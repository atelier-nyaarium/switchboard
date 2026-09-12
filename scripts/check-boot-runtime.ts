import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type WebSocket from "ws";
import { pinnedDial, realWebSocket } from "../src/gateway/router/pinnedSocket.js";
import { SESSION_COMMANDS } from "../src/shared/session-commands.js";
import { loadIdentitySet, seedGateway, seedRouter } from "../src/testing/identitySet.js";
import { createPhoneDriver } from "../src/testing/phoneDriver.js";

type Child = ReturnType<typeof spawn>;

const root = mkdtempSync(path.join(tmpdir(), "boot-runtime-"));
const children: Array<{ name: string; child: Child; output: string[] }> = [];

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const value = await probe();
		if (value !== undefined) return value;
		await wait(50);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function start(name: string, args: string[], env: NodeJS.ProcessEnv): { child: Child; output: string[] } {
	const child = spawn(process.execPath, args, { cwd: path.resolve(import.meta.dirname, ".."), env });
	const output: string[] = [];
	children.push({ name, child, output });
	child.stdout?.on("data", (data: Buffer) => output.push(...data.toString().split(/\r?\n/).filter(Boolean)));
	child.stderr?.on("data", (data: Buffer) => output.push(...data.toString().split(/\r?\n/).filter(Boolean)));
	return { child, output };
}

function exitCode(child: Child, name: string): Promise<number> {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null) {
			resolve(child.exitCode);
			return;
		}
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
		setTimeout(() => {
			if (child.exitCode !== null) return;
			child.kill("SIGKILL");
			reject(new Error(`${name} did not exit within 10 seconds`));
		}, 10_000).unref();
	});
}

const TOOL = SESSION_COMMANDS.sessionRoutine.tool;
/** Every command in the catalogue, so a new one is proven registered without editing this. */
const SESSION_TOOLS = Object.values(SESSION_COMMANDS).map((command) => command.tool);

interface McpRun {
	tools: string[];
	answer: { kind: string };
}

/**
 * One `main-mcp` over stdio, asked what it registers and then asked to use it. A residue test cannot
 * see a tool that is never registered, and a nudge naming one that is not there reads as working.
 */
async function mcpSession(
	gatewayUrl: string,
	projectName: string,
	token: string | undefined,
	until?: string,
): Promise<McpRun> {
	const { child, output } = start(`mcp:${token ? "bound" : "unbound"}`, ["src/main-mcp.ts"], {
		...process.env,
		PROJECT_NAME: projectName,
		BRIDGE_ROUTER_URL: gatewayUrl,
		AGENT_TYPE: "claude",
		ALLOW_FIXTURE_IDENTITY: "1",
		...(token ? { SWITCHBOARD_SESSION_TOKEN: token } : { SWITCHBOARD_SESSION_TOKEN: undefined }),
	});

	let buffer = "";
	let nextId = 1;
	const answers = new Map<number, Record<string, unknown>>();
	const send = (body: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(body)}\n`);

	child.stdout?.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const frame = JSON.parse(line) as {
				id?: number;
				method?: string;
				result?: Record<string, unknown>;
				params?: { meta?: { session_id?: string; reply_schema?: string } };
			};
			if (typeof frame.id === "number" && frame.result) answers.set(frame.id, frame.result);
			// A session is bound only once it answers the gateway's handshake, as a real client does.
			const handshake = frame.params?.meta;
			if (frame.method === "notifications/claude/channel" && handshake?.reply_schema && handshake.session_id) {
				send({
					jsonrpc: "2.0",
					id: nextId++,
					method: "tools/call",
					params: {
						name: "channel_reply_structured",
						arguments: { session_id: handshake.session_id, responseData: { isMainOrLead: true } },
					},
				});
			}
		}
	});

	const call = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
		const id = nextId++;
		send({ jsonrpc: "2.0", id, method, params });
		return waitFor(async () => answers.get(id), `${method} answer`, 20_000);
	};

	try {
		await call("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "boot-check", version: "0" },
		});
		send({ jsonrpc: "2.0", method: "notifications/initialized" });

		const listed = (await call("tools/list")) as { tools?: Array<{ name: string }> };
		const tools = (listed.tools ?? []).map((tool) => tool.name);
		if (!tools.includes(TOOL)) return { tools, answer: { kind: "not_registered" } };

		const ask = async (): Promise<string> => {
			const called = (await call("tools/call", {
				name: TOOL,
				arguments: { occurrenceId: "1" },
			})) as { content?: Array<{ text?: string }> };
			const text = called.content?.[0]?.text ?? "";
			// The tool renders each outcome as its own sentence, which is what a session reads.
			if (text.startsWith("No routine runs")) return "no_routine";
			if (text.startsWith("This session is not bound")) return "unauthenticated";
			if (text.startsWith("This session holds no run")) return "unknown_occurrence";
			if (text.startsWith("That run belongs")) return "wrong_session";
			return "unexpected";
		};

		// A binding is confirmed by the handshake, which lands after the socket opens, so the first
		// ask can honestly precede it.
		if (!until) return { tools, answer: { kind: await ask() } };
		const kind = await waitFor(
			async () => ((await ask()) === until ? until : undefined),
			`a ${until} answer (mcp said: ${output.slice(-6).join(" | ")})`,
			15_000,
		);
		return { tools, answer: { kind } };
	} finally {
		child.kill("SIGKILL");
	}
}

interface RouterRequest {
	headers?: Record<string, string>;
	body?: string;
}

async function routerRequest(
	url: string,
	expectedFp: string,
	{ headers = {}, body }: RouterRequest = {},
): Promise<{ status: number; text: string }> {
	const target = new URL(url);
	const pin = pinnedDial(target.hostname, Number(target.port), expectedFp);
	return await new Promise((resolve, reject) => {
		const request = https.request(
			{
				hostname: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? headers : { ...headers, "content-length": Buffer.byteLength(body) },
				createConnection: pin.createConnection as never,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					if (pin.verdict() !== "match") reject(new Error(`Router pin ${pin.verdict()}`));
					else resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
				});
			},
		);
		request.once("error", reject);
		if (body !== undefined) request.write(body);
		request.end();
	});
}

async function main(): Promise<void> {
	const set = loadIdentitySet();
	const routerDir = path.join(root, "router");
	const gatewayDir = path.join(root, "gateway");
	const federationDir = path.join(gatewayDir, "federation");
	let host: WebSocket | undefined;
	let router: Child | undefined;
	let gateway: Child | undefined;
	let routerPort = 0;
	let routerFp = "";
	/** Captured from the create the console asks for, so the MCP can present what a real one would. */
	let sessionToken: string | undefined;

	const step = async (name: string, action: () => Promise<void>): Promise<void> => {
		try {
			await action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${name}: ${message}`);
		}
		console.log(`[boot] ${name}`);
	};

	await step("seed Router", async () => {
		await seedRouter(routerDir, set);
	});
	await step("start Router", async () => {
		const started = start("router", ["src/main-federation.ts"], {
			...process.env,
			PORT: "0",
			DATA_DIR: routerDir,
			CONSOLE_BRIDGE_TOKEN: set.tokens.console,
			FEDERATION_WS_TOKEN: set.tokens.federation,
			ALLOW_FIXTURE_IDENTITY: "1",
		});
		router = started.child;
		await waitFor(async () => {
			const portLine = started.output.find((line) => line.includes("[federation-router] listening on "));
			const fpLine = started.output.find((line) => line.includes("[federation-router] TLS fingerprint "));
			routerPort = Number(portLine?.match(/listening on (\d+)/)?.[1] ?? 0);
			routerFp = fpLine?.split("TLS fingerprint ")[1]?.trim() ?? "";
			return routerPort && routerFp ? true : undefined;
		}, "Router listen and fingerprint");
	});
	await step("pin Router health", async () => {
		const response = await waitFor(async () => {
			try {
				const answer = await routerRequest(`https://127.0.0.1:${routerPort}/health`, routerFp);
				return answer.status === 200 ? answer : undefined;
			} catch {
				return undefined;
			}
		}, "Router health");
		const health = JSON.parse(response.text) as { certFingerprint?: string };
		if (health.certFingerprint !== routerFp) throw new Error("Router health fingerprint mismatch");
	});
	await step("seed gateway", async () => {
		seedGateway(federationDir, set, { routerUrl: `https://127.0.0.1:${routerPort}`, routerCertFp: routerFp });
	});
	await step("start gateway", async () => {
		const started = start("gateway", ["src/main-gateway.ts"], {
			...process.env,
			PORT: "0",
			DATA_DIR: gatewayDir,
			FEDERATION_DIR: federationDir,
			HOST_WS_TOKEN: set.tokens.host,
			GATEWAY_ID: set.gateway.id,
			ALLOW_FIXTURE_IDENTITY: "1",
		});
		gateway = started.child;
		await waitFor(async () => {
			const line = started.output.find((value) => value.includes("[router] listening on :"));
			return Number(line?.match(/listening on :(\d+)/)?.[1] ?? 0) || undefined;
		}, "gateway listen").then((port) => {
			(gateway as Child & { bootPort?: number }).bootPort = port;
		});
	});
	const gatewayPort = (gateway as Child & { bootPort: number }).bootPort;
	await step("gateway health", async () => {
		await waitFor(async () => {
			try {
				const response = await fetch(`http://127.0.0.1:${gatewayPort}/health`);
				return response.status === 200 ? response : undefined;
			} catch {
				return undefined;
			}
		}, "gateway health");
	});
	await step("register fake host", async () => {
		const WebSocket = realWebSocket();
		host = new WebSocket(`ws://127.0.0.1:${gatewayPort}/bridge`);
		await new Promise<void>((resolve, reject) => {
			const socket = host as WebSocket;
			socket.once("open", () =>
				socket.send(
					JSON.stringify({ type: "register", team: "host", subId: "boot-host", token: set.tokens.host }),
				),
			);
			socket.on("message", (raw: Buffer) => {
				const frame = JSON.parse(raw.toString()) as {
					type: string;
					reqId?: string;
					op?: { kind?: string; path?: string; sessionToken?: string };
				};
				if (frame.type === "register_ok") {
					socket.send(JSON.stringify({ type: "catalog", projects: [], hostSpawns: [] }));
					resolve();
				}
				if (frame.type === "host_op" && frame.op?.kind === "listDirs") {
					socket.send(
						JSON.stringify({
							type: "host_op_reply",
							reqId: frame.reqId,
							ok: true,
							result: { entries: ["projects"], path: frame.op.path || "/home/fixture" },
						}),
					);
				}
				if (frame.type === "host_op" && frame.op?.kind === "createSession") {
					sessionToken = frame.op.sessionToken;
					socket.send(
						JSON.stringify({
							type: "host_op_reply",
							reqId: frame.reqId,
							ok: true,
							result: { created: true, ready: true, alive: true },
						}),
					);
				}
			});
			socket.once("error", reject);
		});
	});
	await step("await Router registration", async () => {
		await waitFor(async () => {
			try {
				const answer = await routerRequest(`https://127.0.0.1:${routerPort}/health`, routerFp);
				const health = JSON.parse(answer.text) as { gateways?: number };
				return answer.status === 200 && health.gateways === 1 ? health : undefined;
			} catch {
				return undefined;
			}
		}, "Router gateway registration");
	});
	await step("run console op", async () => {
		const driver = createPhoneDriver({
			set,
			handle: async (request) => {
				const answer = await routerRequest(`https://127.0.0.1:${routerPort}/console`, routerFp, {
					headers: Object.fromEntries(request.headers),
					body: await request.text(),
				});
				return new Response(answer.text, { status: answer.status });
			},
		});
		const answer = await driver.value({ kind: "list_dirs", path: "" });
		if (answer.envelope.outcome !== "accepted") throw new Error(`console op outcome: ${answer.envelope.outcome}`);
		if (JSON.stringify((answer.result as { entries?: string[] }).entries) !== JSON.stringify(["projects"])) {
			throw new Error("console op result mismatch");
		}
	});

	await step("session tool over MCP", async () => {
		const driver = createPhoneDriver({
			set,
			handle: async (request) => {
				const answer = await routerRequest(`https://127.0.0.1:${routerPort}/console`, routerFp, {
					headers: Object.fromEntries(request.headers),
					body: await request.text(),
				});
				return new Response(answer.text, { status: answer.status });
			},
		});
		const made = await driver.value({
			kind: "create_session",
			target: `${set.domain.id}.${set.gateway.id}.host`,
			sessionName: "boot-mcp",
		});
		if (made.envelope.outcome !== "accepted") throw new Error(`create_session outcome: ${made.envelope.outcome}`);
		if (!sessionToken) throw new Error("the host was never asked to create a session");

		const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
		const bound = await mcpSession(gatewayUrl, "host.boot-mcp", sessionToken, "no_routine");
		for (const tool of SESSION_TOOLS) {
			if (!bound.tools.includes(tool)) throw new Error(`${tool} was not registered for a bound session`);
		}

		const wrong = await mcpSession(gatewayUrl, "host.boot-mcp", "0".repeat(64));
		if (wrong.answer.kind !== "unauthenticated") throw new Error(`stale token answered ${wrong.answer.kind}`);

		const none = await mcpSession(gatewayUrl, "host.boot-mcp", undefined);
		for (const tool of SESSION_TOOLS) {
			if (none.tools.includes(tool)) throw new Error(`${tool} registered for a session with no token`);
		}
	});

	host?.close();
	await step("stop gateway", async () => {
		gateway?.kill("SIGTERM");
		if (!gateway || (await exitCode(gateway, "gateway")) !== 0) throw new Error("gateway exit code was not 0");
	});
	await step("stop Router", async () => {
		router?.kill("SIGTERM");
		if (!router || (await exitCode(router, "Router")) !== 0) throw new Error("Router exit code was not 0");
	});
}

try {
	await main();
	console.log("[boot] ok");
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[boot] FAILED: ${message}`);
	for (const entry of children) {
		for (const line of entry.output) console.error(`[${entry.name}] ${line}`);
	}
	for (const entry of children) {
		if (entry.child.exitCode === null) entry.child.kill("SIGKILL");
	}
	process.exitCode = 1;
} finally {
	rmSync(root, { recursive: true, force: true });
}
