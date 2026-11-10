// A fake `opencode` binary: its version, its server and its terminal UI.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OPENCODE_GREETING_ID, opencodeAuth } from "../../src/shared/opencode.js";
import { HARNESS, OPENCODE_PIN } from "../../src/shared/session-harness.js";
import { createFakeOpencodeServer, type FakeOpencodeServer } from "../../src/testing/fakeOpencodeServer.js";

////////////////////////////////
//  Constants

/** The UI's exit code once its checks pass. */
export const FAKE_UI_EXIT = 7;
const REFUSED = 3;

/** A file the UI waits for before exiting. */
export const FAKE_UI_RELEASE_ENV = "FAKE_OPENCODE_RELEASE";
const RELEASE_WAIT_MS = 15_000;

////////////////////////////////
//  Functions & Helpers

const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** Writes an executable `opencode` into `dir`; answers its path. */
export function installFakeOpencode(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, HARNESS.opencode.binary.posix);
	const script = `#!/bin/sh\nexec ${quoted(process.execPath)} --no-env-file ${quoted(import.meta.filename)} "$@"\n`;
	writeFileSync(file, script, { mode: 0o755 });
	return file;
}

function flag(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

function refuse(reason: string): number {
	console.error(`fake opencode: ${reason}`);
	return REFUSED;
}

function serve(args: readonly string[]): number | undefined {
	const hostname = flag(args, "--hostname");
	const port = Number(flag(args, "--port"));
	const password = process.env.OPENCODE_PASSWORD;
	if (!args.includes("--stdio") || !hostname || !Number.isInteger(port)) return refuse(`bad serve args: ${args}`);
	if (!password) return refuse("serve without OPENCODE_PASSWORD");
	let fake: FakeOpencodeServer | undefined;
	const server = Bun.serve({
		hostname,
		port,
		fetch: async (request) => {
			if (!fake) return new Response(null, { status: 503 });
			const body = await request.text();
			return fake.fetch(request.url, {
				method: request.method,
				headers: request.headers,
				signal: request.signal,
				...(body ? { body } : {}),
			});
		},
	});
	const url = `http://${hostname}:${server.port}`;
	fake = createFakeOpencodeServer({ url, password });
	console.log(JSON.stringify({ url }));
	process.stdin.on("data", () => undefined).on("end", () => process.exit(0));
	return undefined;
}

async function released(file: string | undefined): Promise<boolean> {
	if (!file) return true;
	const deadline = Date.now() + RELEASE_WAIT_MS;
	while (Date.now() < deadline) {
		if (existsSync(file)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

async function ui(args: readonly string[]): Promise<number> {
	const url = flag(args, "--server");
	const sessionId = flag(args, "--session");
	const password = process.env.OPENCODE_PASSWORD;
	if (!url || !sessionId) return refuse(`bad UI args: ${args}`);
	if (!password) return refuse("UI without OPENCODE_PASSWORD");
	const answer = await fetch(`${url}/api/session/${sessionId}/message`, {
		headers: { authorization: opencodeAuth(password) },
	});
	if (!answer.ok) return refuse(`session ${sessionId} answered HTTP ${answer.status}`);
	const rows = ((await answer.json()) as { data?: Array<{ id?: string }> }).data ?? [];
	if (!rows.some((row) => row.id === OPENCODE_GREETING_ID)) return refuse("the session holds no greeting");
	if (!(await released(process.env[FAKE_UI_RELEASE_ENV]))) return refuse("never released");
	return FAKE_UI_EXIT;
}

////////////////////////////////
//  Entry

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === "--version") {
		console.log(OPENCODE_PIN);
	} else if (args[0] === "serve") {
		const refused = serve(args.slice(1));
		if (refused !== undefined) process.exit(refused);
	} else if (args.includes("--server")) {
		process.exit(await ui(args));
	} else {
		process.exit(refuse(`unknown mode: ${args}`));
	}
}
