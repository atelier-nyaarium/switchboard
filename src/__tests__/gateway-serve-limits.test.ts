import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ASSISTANT_WAITS } from "../gateway/assistant/waits.js";
import { DEFAULT_BOARD_ATTEMPTS } from "../gateway/router/boardClient.js";
import { TOOL_CALL_TIMEOUT_MS } from "../gateway/router/routerClient.js";
import { VAULT_REFRESH_MAX_CALLS } from "../gateway/router/vaultClient.js";
import { GATEWAY_IDLE_TIMEOUT_S } from "../gateway/serveLimits.js";
import { DEFAULT_WAKE_TIMEOUT_MS, POST_WAKE_SETTLE_MS } from "../gateway/wake.js";
import { initBridge, routerPost } from "../mcp/bridge/helpers.js";
import { AGENT_BACKENDS, agentHttpPath } from "../shared/agent-backend.js";
import {
	CONSOLE_ANSWER_WAIT_MS,
	CONSOLE_HOP_MARGIN_MS,
	CREATE_SESSION_BOUND_MS,
	SEND_BOUND_MS,
} from "../shared/console-protocol.js";
import { GATEWAY_LONG_WAIT_ROUTES, isGatewayLongWaitRoute } from "../shared/gateway-long-waits.js";
import { SEND_ROUTE_WAIT_CAP_MS } from "../shared/schemasAssistantSend.js";
import { VAULT_ROUTE_WAIT_CAP_MS } from "../shared/schemasVault.js";

const VAULT_REFRESH_BOUND_MS = VAULT_REFRESH_MAX_CALLS * TOOL_CALL_TIMEOUT_MS;

const IDLE_CUT_MS = GATEWAY_IDLE_TIMEOUT_S * 1000;

const VAULT_HOLD_FLOOR_MS = VAULT_ROUTE_WAIT_CAP_MS + VAULT_REFRESH_BOUND_MS;
const PHONE_ROUTE_WAIT_MS = ASSISTANT_WAITS.phone * 2 + CONSOLE_ANSWER_WAIT_MS + CONSOLE_HOP_MARGIN_MS;

// Long floors, short ceilings.
const ROUTE_WAIT_MS = new Map<string, number>([
	["/send", DEFAULT_WAKE_TIMEOUT_MS + POST_WAKE_SETTLE_MS],
	["/task-board", (1 + DEFAULT_BOARD_ATTEMPTS) * TOOL_CALL_TIMEOUT_MS],
	["/blob/get", TOOL_CALL_TIMEOUT_MS],
	["/vault/search", VAULT_REFRESH_BOUND_MS],
	["/vault/use", VAULT_HOLD_FLOOR_MS],
	["/vault/collect", VAULT_HOLD_FLOOR_MS],
	["/vault/capture", VAULT_REFRESH_BOUND_MS + TOOL_CALL_TIMEOUT_MS],
	["/vault/askpass", VAULT_HOLD_FLOOR_MS],
	["/assistant/action", ASSISTANT_WAITS.action],
	["/assistant/list", ASSISTANT_WAITS.list],
	["/assistant/phone", PHONE_ROUTE_WAIT_MS],
	// Unasked sends wake targets.
	["/assistant/send", Math.max(SEND_ROUTE_WAIT_CAP_MS, DEFAULT_WAKE_TIMEOUT_MS + POST_WAKE_SETTLE_MS)],
	["/assistant/send/collect", SEND_ROUTE_WAIT_CAP_MS],
	...AGENT_BACKENDS.map(({ id, waitBudgetMs }) => [agentHttpPath(id), waitBudgetMs] as const),
]);

const SHORT_POST_PATHS = [
	"/enroll",
	"/federation/retire",
	"/respond",
	"/poll",
	"/human/notify",
	"/plugin-action",
	"/blob/stat",
	"/blob/put",
	"/vault/withdraw",
	"/assistant/send/withdraw",
	"/routine/session",
	"/routine/report",
	"/session/baseline",
	"/assistant/hold",
];

function quotedPaths(source: string): string[] {
	return [...source.matchAll(/["'](\/[A-Za-z0-9/_-]+)["']/g)].map((match) => match[1]);
}

function postHttpPaths(source: string): string[] {
	const paths = [...source.matchAll(/method === "POST" && url\.pathname === "(\/[^"]+)"/g)].map((match) => match[1]);
	const blobRoutes = source.match(/const BLOB_ROUTE_SCHEMAS = \{([\s\S]*?)\} as const;/)?.[1] ?? "";
	paths.push(...quotedPaths(blobRoutes));
	return paths;
}

function mapKeys(source: string): string[] {
	const map = source.match(/return new Map(?:<string, Handler>)?\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
	return [...map.matchAll(/\[\s*([^,\n]+?)\s*,/g)].map((match) => match[1].trim());
}

function longRoutePaths(): string[] {
	return [...ROUTE_WAIT_MS].filter(([, waitMs]) => waitMs >= IDLE_CUT_MS).map(([path]) => path);
}

describe("gateway long waits", () => {
	it("classifies a route as long exactly when its wait reaches Bun's idle cut", () => {
		expect([...GATEWAY_LONG_WAIT_ROUTES].sort()).toEqual(
			longRoutePaths()
				.map((path) => `POST ${path}`)
				.sort(),
		);
	});

	it("accounts for every HTTP and loopback POST path", () => {
		const listener = fs.readFileSync("src/gateway/compose/composeListener.ts", "utf8");
		const providers = listener.match(/loopbackRoutes: new Map\(\[([\s\S]*?)\]\),\s*routes:/)?.[1] ?? "";
		expect([...providers.matchAll(/\.\.\.\(?(deps\.[\w.?]+)/g)].map((match) => match[1])).toEqual([
			"deps.agents.agentRoutes",
			"deps.vault.routes",
			"deps.routines?.routes",
			"deps.baseline.routes",
			"deps.assistant.routes",
		]);

		const httpRouter = fs.readFileSync("src/gateway/httpRouter.ts", "utf8");
		const vaultRoutes = fs.readFileSync("src/gateway/vault/vaultRoutes.ts", "utf8");
		const assistantRoutes = fs.readFileSync("src/gateway/assistant/assistantRoutes.ts", "utf8");
		const routineRoutes = fs.readFileSync("src/gateway/routines/routineRoutes.ts", "utf8");
		const baselineRoutes = fs.readFileSync("src/gateway/sessionBaseline.ts", "utf8");
		const assistantPaths = fs.readFileSync("src/shared/schemasAssistantActions.ts", "utf8");
		const phonePaths = fs.readFileSync("src/shared/schemasPhoneCapabilities.ts", "utf8");
		const holdPaths = fs.readFileSync("src/shared/assistant-hold.ts", "utf8");
		const sendPaths = fs.readFileSync("src/shared/schemasAssistantSend.ts", "utf8");
		const commandPaths = fs.readFileSync("src/shared/session-commands.ts", "utf8");
		const baselinePaths = fs.readFileSync("src/shared/session-baseline.ts", "utf8");

		expect(mapKeys(vaultRoutes)).toEqual([
			'"/vault/search"',
			'"/vault/use"',
			'"/vault/collect"',
			'"/vault/withdraw"',
			'"/vault/capture"',
			'"/vault/askpass"',
		]);
		expect(mapKeys(assistantRoutes)).toEqual([
			"INBOX.path",
			"ASSISTANT_ACTION_PATH",
			"ASSISTANT_HOLD_PATH",
			"PHONE_CAPABILITY_PATH",
			"ASSISTANT_SEND_ROUTES.send",
			"ASSISTANT_SEND_ROUTES.collect",
			"ASSISTANT_SEND_ROUTES.withdraw",
		]);
		expect(mapKeys(routineRoutes)).toEqual(["COMMAND.path", "REPORT.path"]);
		expect(mapKeys(baselineRoutes)).toEqual(["SESSION_BASELINE_PATH"]);

		const loopbackPaths = [
			...quotedPaths(vaultRoutes),
			...quotedPaths(assistantPaths),
			...quotedPaths(phonePaths),
			...quotedPaths(holdPaths),
			...quotedPaths(sendPaths),
			...quotedPaths(commandPaths),
			...quotedPaths(baselinePaths),
			...AGENT_BACKENDS.map(({ id }) => agentHttpPath(id)),
		];
		const postPaths = new Set([...postHttpPaths(httpRouter), ...loopbackPaths]);
		const classifiedPaths = new Set([...ROUTE_WAIT_MS.keys(), ...SHORT_POST_PATHS]);

		expect([...postPaths].sort()).toEqual([...classifiedPaths].sort());
		for (const path of postPaths) {
			expect(isGatewayLongWaitRoute("POST", path)).toBe(longRoutePaths().includes(path));
		}
		expect(isGatewayLongWaitRoute("GET", "/send")).toBe(false);
	});

	it("sets the request timeout before dispatching a long wait", () => {
		const adapter = fs.readFileSync("src/gateway/index.ts", "utf8");
		expect(adapter).toMatch(
			/if\s*\(isGatewayLongWaitRoute\(req\.method,\s*url\.pathname\)\)\s*server\.timeout\(req,\s*0\);\s*return graph\.router\(req\);/,
		);
		expect(adapter).toMatch(/idleTimeout: GATEWAY_IDLE_TIMEOUT_S/);
	});
});

describe("the waits a caller is promised", () => {
	it("sit inside what holds them: the phone for a console op, the action for a request", () => {
		for (const consoleWait of [ASSISTANT_WAITS.preview, SEND_BOUND_MS, CREATE_SESSION_BOUND_MS]) {
			expect(consoleWait + CONSOLE_HOP_MARGIN_MS).toBeLessThanOrEqual(CONSOLE_ANSWER_WAIT_MS);
		}
		expect(ASSISTANT_WAITS.request).toBeLessThan(ASSISTANT_WAITS.action);
	});
});

describe("long-wait HTTP clients", () => {
	it("lifts the fetch timeout and resends a reset only to a replayed route", async () => {
		const calls: Array<{ init: RequestInit; timeout?: boolean | number }> = [];
		const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
		initBridge({ routerUrl: "http://gateway", projectName: "test", agentType: "test" });
		vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ init: init ?? {}, timeout: (init as RequestInit & { timeout?: boolean | number })?.timeout });
			throw reset;
		});
		try {
			await expect(routerPost("/send", {}, { retries: 3, retryDelayMs: 0 })).rejects.toBe(reset);
			expect(calls).toHaveLength(1);
			expect(calls[0].timeout).toBe(false);

			calls.length = 0;
			await expect(routerPost("/task-board", {}, { retries: 1, retryDelayMs: 0 })).rejects.toBe(reset);
			expect(calls.map((call) => call.timeout)).toEqual([false, false]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("retries a refusal for long waits and keeps retries for short routes", async () => {
		const calls: Array<{ url: string; timeout?: boolean | number }> = [];
		let attempts = 0;
		initBridge({ routerUrl: "http://gateway", projectName: "test", agentType: "test" });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				timeout: (init as RequestInit & { timeout?: boolean | number })?.timeout,
			});
			attempts++;
			if (attempts === 1) throw Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" });
			if (attempts === 2) throw new TypeError("connect refused", { cause: { code: "ECONNREFUSED" } });
			return Response.json({ ok: true });
		});
		try {
			await expect(routerPost("/vault/use", {}, { retries: 2, retryDelayMs: 0 })).resolves.toEqual({ ok: true });
			expect(calls).toHaveLength(3);
			expect(calls.map((call) => call.timeout)).toEqual([false, false, false]);

			calls.length = 0;
			vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					timeout: (init as RequestInit & { timeout?: boolean | number })?.timeout,
				});
				if (calls.length === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
				return Response.json({ ok: true });
			});
			await expect(routerPost("/respond", {}, { retries: 1, retryDelayMs: 0 })).resolves.toEqual({ ok: true });
			expect(calls).toHaveLength(2);
			expect(calls.map((call) => call.timeout)).toEqual([undefined, undefined]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
