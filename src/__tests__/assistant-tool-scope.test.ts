import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerInboxTool } from "../mcp/assistant/inboxTool.js";
import { ASSISTANT_INSTRUCTIONS, scopeTools } from "../mcp/assistant/instructions.js";
import { sendGuarded } from "../mcp/assistant/sendTools.js";
import { RouterHttpError } from "../mcp/bridge/helpers.js";
import { guardToolResults } from "../mcp/toolResultGuard.js";
import { ASSISTANT_CROSSTALK_TOOLS, ASSISTANT_SWITCHBOARD_TOOLS } from "../shared/assistant-session.js";
import { ASSISTANT_ACTION_KEYS } from "../shared/schemasAssistantActions.js";
import type { InboxItem } from "../shared/schemasAssistantInbox.js";
import { ASSISTANT_SEND_ROUTES, SEND_ROUTE_WAIT_CAP_MS } from "../shared/schemasAssistantSend.js";
import { ASSISTANT_COMMANDS } from "../shared/session-commands.js";

const posted: { path: string; body: unknown }[] = [];
const answers = new Map<string, unknown>();

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: async (path: string, body: unknown) => {
		posted.push({ path, body });
		const answer = answers.get(path);
		if (answer instanceof Error) throw answer;
		return answer;
	},
	RouterHttpError: class extends Error {
		constructor(
			readonly status: number,
			body: string,
		) {
			super(`HTTP ${status}: ${body}`);
		}
	},
	bridgeConversationId: () => "conv-assistant",
}));

beforeEach(() => {
	posted.length = 0;
	answers.clear();
});

async function connected(register: (server: McpServer) => void): Promise<Client> {
	const server = new McpServer({ name: "probe", version: "0.0.0" });
	guardToolResults(server);
	scopeTools(server, new Set(ASSISTANT_SWITCHBOARD_TOOLS));
	register(server);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "probe-client", version: "0.0.0" });
	await client.connect(clientSide);
	return client;
}

describe("the assistant's tool scope", () => {
	it("lists only the assistant's tools, even after a removed one is updated", async () => {
		const noop = async () => ({ content: [] });
		const client = await connected((server) => {
			for (const name of ["channel_reply", "vault_run", "codexStartAgent", "switchboard_capabilities"]) {
				server.registerTool(name, { description: name, inputSchema: {} }, noop);
			}
			server
				.registerTool("reload_plugins", { description: "x", inputSchema: {} }, noop)
				.update({ callback: noop });
			registerInboxTool(server);
		});

		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual(["channel_reply", "inbox", "switchboard_capabilities"]);
	});

	it("teaches the assistant every command and action it is given", () => {
		const taught = [
			...Object.values(ASSISTANT_COMMANDS).map(({ tool }) => tool),
			...ASSISTANT_ACTION_KEYS,
			...Object.values(ASSISTANT_CROSSTALK_TOOLS),
		];

		for (const tool of taught) expect(ASSISTANT_INSTRUCTIONS).toContain(`\`${tool}\``);
		for (const tool of taught) expect(ASSISTANT_SWITCHBOARD_TOOLS).toContain(tool);
	});
});

describe("the assistant's guarded send", () => {
	const SEND = ASSISTANT_SEND_ROUTES.send;
	const target = "home.sakura.host.worker";
	const textOf = (result: { content: { text: string }[] }) => result.content[0]?.text ?? "";

	it("posts the intent to the guard, then says how it cleared or how to continue", async () => {
		answers.set(SEND, { outcome: "pending", requestId: "r1", deadlineAt: 1 });
		const pending = await sendGuarded({ to: target, body: "hi", files: [] });
		answers.set(SEND, { outcome: "sent", sessionId: "s1", target, guard: "approved" });
		const sent = await sendGuarded({ to: target, body: "hi", files: [] });

		expect(posted[0]).toEqual({
			path: SEND,
			body: { to: target, body: "hi", fromConversationId: "conv-assistant", waitMs: SEND_ROUTE_WAIT_CAP_MS },
		});
		expect(pending.isError).toBeFalsy();
		expect(textOf(pending)).toContain(ASSISTANT_CROSSTALK_TOOLS.collect);
		expect(textOf(pending)).toContain('"r1"');
		expect(textOf(sent)).toContain("approved by the owner");
		expect(textOf(sent)).toContain("s1");
	});

	it("is an error when nothing was sent, and names a Gateway that does not guard sends", async () => {
		answers.set(SEND, { outcome: "denied", note: "not to that team" });
		const denied = await sendGuarded({ to: target, body: "hi", files: [] });
		answers.set(SEND, new RouterHttpError(404, "Not Found"));
		const unguarded = await sendGuarded({ to: target, body: "hi", files: [] });
		answers.set(SEND, new RouterHttpError(404, `no session named "${target}"`));
		const missing = await sendGuarded({ to: target, body: "hi", files: [] });

		expect([denied, unguarded, missing].map((result) => result.isError)).toEqual([true, true, true]);
		expect(textOf(denied)).toContain("not to that team");
		expect(textOf(unguarded)).toContain("does not guard");
		expect(textOf(missing)).not.toContain("does not guard");
	});
});

describe("the assistant's inbox tool", () => {
	const PATH = ASSISTANT_COMMANDS.inbox.path;
	const item: InboxItem = {
		id: "18",
		title: "Review requested",
		fields: { reason: "review_requested" },
		at: Date.parse("2026-10-18T10:00:00Z"),
		decision: "wake",
	};
	const call = async (args: Record<string, unknown>) => {
		const client = await connected(registerInboxTool);
		return (await client.callTool({ name: "inbox", arguments: args })) as {
			isError?: boolean;
			content: { text: string }[];
		};
	};

	it("lists one call at a time, posting nothing else, and hands back the next page to ask for", async () => {
		answers.set(PATH, { kind: "listed", lists: [{ label: "GitHub notifications", items: [item], next: "tok" }] });

		const listed = await call({ scope: "new" });
		await call({ scope: "new", page: "tok" });

		expect(posted).toEqual([
			{ path: PATH, body: { scope: "new" } },
			{ path: PATH, body: { scope: "new", page: "tok" } },
		]);
		expect(listed.isError).toBeFalsy();
		expect(listed.content[0]?.text).toContain("id: 18");
		expect(listed.content[0]?.text).toContain('page: "tok"');
	});

	it("is an error when a watcher could not list, the scope is missing, or the session is not the assistant", async () => {
		answers.set(PATH, {
			kind: "listed",
			lists: [{ label: "GitHub notifications", items: [], error: "rate limit" }],
		});
		const failed = await call({ scope: "all" });
		const unscoped = await call({});
		answers.set(PATH, { kind: "not_assistant" });
		const refused = await call({ scope: "all" });
		answers.set(PATH, { kind: "unauthenticated" });
		const unbound = await call({ scope: "all" });

		expect([failed, unscoped, refused, unbound].map((result) => result.isError)).toEqual([true, true, true, true]);
		expect(posted).toHaveLength(3);
	});
});
