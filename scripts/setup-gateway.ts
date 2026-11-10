// Gateway Setup: arms this machine's gateway through its loopback, then waits on the phone.

import os from "node:os";
import { $ } from "bun";
import { ENROLL_PENDING_FILE, type EnrollPending, enrollPendingOf } from "../src/gateway/federation/enrollPending.js";
import { routerTransportOf } from "../src/gateway/router/transport.js";
import { fingerprint } from "../src/shared/crypto.js";
import { GATEWAY_NETWORK } from "../src/shared/gateway-network.js";
import {
	ENROLL_ARM_PATH,
	ENROLL_STATUS_PATH,
	type EnrollArmAnswer,
	EnrollArmAnswerSchema,
	type EnrollStatus,
	EnrollStatusSchema,
} from "../src/shared/schemasEnrollSetup.js";
import { requireDocker } from "./lib/docker-probe.js";
import {
	ask,
	confirm,
	dc,
	dirExists,
	ensureHostWsToken,
	ensureNetwork,
	envGet,
	envSet,
	err,
	note,
	secureFile,
} from "./lib/host.js";
import { FEDERATION_NETWORK, ROUTER_PORT } from "./lib/routerStart.js";
import { routerRunning } from "./lib/routerState.js";
import { FED_DIR_HOST, GATEWAY_URL, GW_JSON_FILE, GW_QR_GIF, HEALTH_URL } from "./setup-constants.js";
import { cleanupTemps, presentEnrollment } from "./setup-enrollment-ui.js";

////////////////////////////////
//  Interfaces & Types

interface RouterAddress {
	host: string;
	port: number;
}

////////////////////////////////
//  Gateway helpers

export function gatewayHostname(): string {
	return os.hostname().trim();
}

const label = (address: RouterAddress): string => `${address.host}:${address.port}`;

/** `host:port` of a Router URL, as the operator typed it. */
function withoutScheme(routerUrl: string): string {
	return routerUrl.replace(/^[a-z]+:\/\//, "");
}

function addressOf(routerUrl: string): RouterAddress {
	const url = new URL(routerUrl);
	return { host: url.hostname, port: Number(url.port) || 443 };
}

async function gatewayHealthy(): Promise<boolean> {
	try {
		return (await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) })).ok;
	} catch {
		return false;
	}
}

/** Poll the gateway's /health until ready (30 x 2s = 60s). */
async function waitHealth(): Promise<boolean> {
	console.log("Waiting for gateway");
	for (let i = 0; i < 30; i++) {
		if (await gatewayHealthy()) return true;
		await Bun.sleep(2000);
	}
	return false;
}

/** The loopback port answers every container on the gateway's network; the token says host. */
async function hostAuth(): Promise<Record<string, string>> {
	return { Authorization: `Bearer ${await envGet("HOST_WS_TOKEN")}` };
}

////////////////////////////////
//  Gateway operations (throw on failure; the menu catches per-op, the top level exits)

/** Delete what an enrollment left: the transport, staging, and an unfinished setup's record. */
async function clearEnrollment(): Promise<void> {
	if (!dirExists(FED_DIR_HOST)) return;
	const mount = `${process.cwd()}/volumes/gateway-data:/w`;
	const targets = ["transport.json", "staging", ENROLL_PENDING_FILE].map((name) => `/w/federation/${name}`);
	await $`docker run --rm -u 0 -v ${mount} busybox rm -rf ${targets}`.quiet().nothrow();
}

/** Where this machine first dials the Router. The bundle names the public host, which a machine on
 * the Router's own LAN may be unable to hairpin to. */
async function askRouterAddress(previous?: RouterAddress): Promise<RouterAddress> {
	const localRouter = await routerRunning();
	const currentHost =
		previous?.host || (await envGet("FEDERATION_ROUTER_HOST")) || (localRouter ? "federation-router" : "");
	const currentPort = previous?.port || Number(await envGet("FEDERATION_ROUTER_PORT")) || ROUTER_PORT;
	let host = currentHost;
	let port = currentPort;
	if (process.stdin.isTTY) {
		host = ask(`Federation router host [${currentHost || "none"}]:`) || currentHost;
		const portAnswer = ask(`Federation router port [${currentPort}]:`);
		port = portAnswer === "" ? currentPort : Number(portAnswer);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${portAnswer}`);
	}
	if (!host) throw new Error("a Federation Router host is required to enroll this gateway");
	await envSet("FEDERATION_ROUTER_HOST", host);
	await envSet("FEDERATION_ROUTER_PORT", String(port));
	secureFile(".env");
	return { host, port };
}

/** Bring the gateway up. A re-enrollment first stops it and clears what the last one installed. */
async function startGateway(reenroll: boolean): Promise<void> {
	console.log("Starting gateway");
	// Compose declares these external and will not create them, so a missing one refuses the start.
	await ensureNetwork(FEDERATION_NETWORK);
	await ensureNetwork(GATEWAY_NETWORK);
	// The arm route and the host slot refuse without it.
	await ensureHostWsToken();
	if (reenroll) {
		await dc("down", "--remove-orphans").quiet().nothrow();
		await clearEnrollment();
	}
	const up = await dc("up", "--build", "-d").nothrow();
	// Compose's own last lines say why.
	if (up.exitCode !== 0) {
		const detail = up.stderr.toString().trim().split("\n").slice(-3).join("\n");
		throw new Error(`could not start the gateway${detail ? `:\n${detail}` : ""}`);
	}
	if (!(await waitHealth())) {
		throw new Error("gateway not ready in 60s - run: docker logs switchboard");
	}
}

/** Ask the gateway to arm. It checks the Router's reach from its own network and mints the code. */
async function arm(address: RouterAddress): Promise<EnrollArmAnswer> {
	const response = await fetch(`${GATEWAY_URL}${ENROLL_ARM_PATH}`, {
		method: "POST",
		headers: { ...(await hostAuth()), "Content-Type": "application/json" },
		body: JSON.stringify(address),
		signal: AbortSignal.timeout(30_000),
	});
	const parsed = EnrollArmAnswerSchema.safeParse(await response.json().catch(() => null));
	if (!parsed.success) throw new Error(`the gateway answered ${response.status} to the arm - is it up to date?`);
	return parsed.data;
}

/** The gateway's reading of the wait, or null when it did not answer. Each read is what makes it ask. */
async function readStatus(): Promise<EnrollStatus | null> {
	try {
		const response = await fetch(`${GATEWAY_URL}${ENROLL_STATUS_PATH}`, {
			headers: await hostAuth(),
			signal: AbortSignal.timeout(5000),
		});
		const parsed = EnrollStatusSchema.safeParse(await response.json());
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function armRefusal(error: Exclude<EnrollArmAnswer, { ok: true }>["error"]): string {
	switch (error) {
		case "already_enrolled":
			return "the gateway is already enrolled";
		case "closing":
			return "the gateway is shutting down - try again";
		case "unauthorized":
			return "the gateway refused the host token - run ./start-gateway.sh so it holds the one in .env";
		default:
			return "the gateway refused that Router address";
	}
}

/** The line under the options while the screen waits. */
export function waitLine(seen: EnrollStatus | null): string {
	if (!seen) return "Cannot reach this machine's gateway, retrying";
	switch (seen.state) {
		case "unreachable":
			return `Cannot reach the Router at ${withoutScheme(seen.router)} (${seen.reason}), retrying`;
		case "refused":
			return `A bundle arrived and was refused (${seen.reason}). Waiting for your phone...`;
		case "none":
			return "This setup is no longer armed. Press b, then run Gateway Setup again.";
		default:
			return "Waiting for your phone...";
	}
}

/** True once transport.json holds what the gateway itself accepts, by the loader's own reading. */
export async function transportInstalled(): Promise<boolean> {
	const text = await readFederationFile("transport.json");
	return text !== null && routerTransportOf(text) !== null;
}

/** A setup that armed and has not finished, read with the gateway up or down. */
export async function pendingSetup(): Promise<EnrollPending | null> {
	const text = await readFederationFile(ENROLL_PENDING_FILE);
	return text === null ? null : enrollPendingOf(text);
}

/** A federation file's text, or null when absent. Root-owned once the container ran, so a refused
 * read goes through a container. */
async function readFederationFile(name: string): Promise<string | null> {
	// Not `exists()`: it answers false for a file inside an unreadable folder.
	try {
		return await Bun.file(`${FED_DIR_HOST}/${name}`).text();
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EACCES") return null;
	}
	const mount = `${process.cwd()}/volumes/gateway-data:/w:ro`;
	const read = await $`docker run --rm -v ${mount} busybox cat ${`/w/federation/${name}`}`.quiet().nothrow();
	return read.exitCode === 0 ? read.stdout.toString() : null;
}

/** Arms this machine's gateway, or returns to a setup it already armed, and waits on the phone
 * beside the code to match. */
export async function setupGateway(): Promise<void> {
	// Before any prompt.
	await requireDocker();

	// A pre-set GATEWAY_ID overrides the hostname.
	const id = (await envGet("GATEWAY_ID")) || gatewayHostname();
	await envSet("GATEWAY_ID", id);
	secureFile(".env");

	const enrolled = await transportInstalled();
	const pending = enrolled ? null : await pendingSetup();
	let address: RouterAddress;
	if (pending) {
		// The same code, with no address asked and no restart.
		address = addressOf(pending.routerUrl);
		if (!(await gatewayHealthy())) await startGateway(false);
	} else {
		// Re-enrolling disconnects an enrolled gateway until a new bundle arrives.
		if (enrolled && !confirm(`Gateway "${id}" already enrolled. Re-enroll?`)) return;
		address = await askRouterAddress();
		await startGateway(enrolled);
	}

	let armed: Extract<EnrollArmAnswer, { ok: true }>;
	for (;;) {
		const answer = await arm(address);
		if (answer.ok) {
			armed = answer;
			break;
		}
		if (answer.error !== "router_unreachable") throw new Error(armRefusal(answer.error));
		const reason = answer.reason ?? "no answer";
		err(`Cannot reach the Router at ${label(address)} (${reason}).${pending ? "" : " Nothing was armed."}`);
		if (!process.stdin.isTTY) throw new Error("the Router could not be reached");
		address = await askRouterAddress(address);
	}
	note(`Router reached at ${label(address)}`);

	const watch: { seen: EnrollStatus | null } = { seen: { state: "waiting" } };
	try {
		const action = await presentEnrollment(JSON.stringify(armed.payload), {
			title: `Gateway "${id}" - send to your phone:`,
			qrScanHint: "Scan this QR in your phone's Add Gateway screen.",
			jsonScanHint: "Paste the enrollment JSON into your phone's Add Gateway screen.",
			qrGifPath: GW_QR_GIF,
			jsonFilePath: GW_JSON_FILE,
			qrSaveLabel: "Save Enrollment QR Instead",
			jsonSaveLabel: "Save Enrollment JSON Instead",
			settle: {
				installed: async () => {
					watch.seen = await readStatus();
					return watch.seen?.state === "installed";
				},
				status: () => waitLine(watch.seen),
				// Both sides run the same function over the same key.
				sas: fingerprint(armed.payload.signPub),
			},
		});
		if (action !== "settled") return;
		const domain = watch.seen?.state === "installed" ? watch.seen.domain : null;
		console.log();
		note(`Gateway "${id}" enrolled${domain ? ` into ${domain}` : ""}; connecting to the Router.`);
		// Without the daemon the phone lists nothing here.
		note("Next: run ./start-host-daemon.sh here, or this machine stays empty on your phone.");
	} finally {
		cleanupTemps();
	}
}
