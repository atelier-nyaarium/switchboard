import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedAnswerText } from "../mcp/assistant/sendTools.js";
import { registerBridgeSend } from "../mcp/bridge/bridgeSend.js";
import { closeRouter, connectToRouter, initBridge } from "../mcp/bridge/helpers.js";
import { pluginProfile } from "../mcp/sessionCli.js";
import { type SendRefusal, sendRefusalText, startingText } from "../shared/launch-notice.js";
import { OP_LEDGER_PROTOCOL } from "../shared/schemas.js";

const sockets = vi.hoisted(() => ({ made: [] as Array<{ emit: (event: string, value?: unknown) => void }> }));

vi.mock("ws", () => {
	class FakeSocket {
		static OPEN = 1;
		readyState = 1;
		private listeners = new Map<string, Array<(value?: unknown) => void>>();
		constructor() {
			sockets.made.push(this);
		}
		on(event: string, listener: (value?: unknown) => void): this {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}
		send(): void {}
		close(): void {}
		emit(event: string, value?: unknown): void {
			for (const listener of this.listeners.get(event) ?? []) listener(value);
		}
	}
	return { default: FakeSocket };
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

let send: Handler;

beforeEach(() => {
	initBridge({ routerUrl: "http://localhost:20000", projectName: "host.asker", profile: pluginProfile("claude") });
	connectToRouter();
	const socket = sockets.made.at(-1);
	socket?.emit("open");
	socket?.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL }));
	const server = {
		registerTool: (_name: string, _definition: unknown, handler: Handler) => {
			send = handler;
		},
	} as unknown as McpServer;
	registerBridgeSend(server);
});
afterEach(() => {
	closeRouter();
	sockets.made = [];
	vi.restoreAllMocks();
});

const answers = (status: number, body: Record<string, unknown>) =>
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("crosstalk_send's answer to a session that is not up", () => {
	it("renders a starting session in the owner's words", async () => {
		answers(200, { status: "starting", target: "fixture-domain.laptop.app.x", session_id: "s1" });

		const answer = await send({ to: "app.x", body: "hi" });

		expect(answer.content[0]?.text).toBe(startingText("fixture-domain.laptop.app.x"));
	});

	it.each<[string, SendRefusal]>([
		["no label", { kind: "no_label" }],
		["several CLIs", { kind: "cli", refusal: { cause: "needs_pick", available: ["claude", "opencode"] } }],
	])("renders a refusal (%s) as its text alone", async (_label, refused) => {
		answers(404, { error: sendRefusalText(refused, "app.x"), refused });

		const answer = await send({ to: "app.x", body: "hi", displayLabel: "X" });

		expect(answer).toEqual({ content: [{ type: "text", text: sendRefusalText(refused, "app.x") }], isError: true });
	});
});

describe("the assistant's guarded send answer for a session that is not up", () => {
	it("words a starting session and a typed refusal as crosstalk_send does", () => {
		const refusal: SendRefusal = { kind: "cli", refusal: { cause: "none_installed" } };

		const starting = guardedAnswerText({
			outcome: "sent",
			sessionId: "s1",
			target: "d.g.app.x",
			guard: "approved",
			starting: true,
		});
		const refused = guardedAnswerText({
			outcome: "failed",
			reason: "nothing was launched",
			refused: { refusal, target: "d.g.app.x" },
		});

		expect(starting.content[0]?.text).toBe(startingText("d.g.app.x"));
		expect(refused).toEqual({
			content: [{ type: "text", text: sendRefusalText(refusal, "d.g.app.x") }],
			isError: true,
		});
	});
});
