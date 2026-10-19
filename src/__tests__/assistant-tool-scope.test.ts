import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerInboxTool } from "../mcp/assistant/inboxTool.js";
import { scopeTools } from "../mcp/assistant/instructions.js";
import { guardToolResults } from "../mcp/toolResultGuard.js";
import { ASSISTANT_SWITCHBOARD_TOOLS } from "../shared/assistant-session.js";
import { ASSISTANT_INBOX_CONFIRM_PATH, type InboxEventWire } from "../shared/schemasAssistantInbox.js";

const posted: { path: string; body: unknown }[] = [];
const answers = new Map<string, unknown>();

vi.mock("../mcp/bridge/helpers.js", () => ({
	routerPost: async (path: string, body: unknown) => {
		posted.push({ path, body });
		const answer = answers.get(path);
		if (answer instanceof Error) throw answer;
		return answer;
	},
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
				.registerTool("crosstalk_send", { description: "x", inputSchema: {} }, noop)
				.update({ callback: noop });
			registerInboxTool(server);
		});

		const { tools } = await client.listTools();

		expect(tools.map((tool) => tool.name).sort()).toEqual(["channel_reply", "inbox", "switchboard_capabilities"]);
	});
});

describe("the assistant's inbox tool", () => {
	const row: InboxEventWire = {
		watcherId: "github",
		label: "GitHub notifications",
		id: "18",
		title: "Review requested",
		fields: { reason: "review_requested" },
		at: 1,
		action: "inbox",
	};
	const call = async () => {
		const client = await connected(registerInboxTool);
		return (await client.callTool({ name: "inbox", arguments: {} })) as {
			isError?: boolean;
			content: { text: string }[];
		};
	};

	it("marks read only what it answered, and still answers the events when the mark did not land", async () => {
		answers.set("/assistant/inbox", { kind: "events", events: [row], boundaries: { github: 4 }, evicted: {} });
		answers.set(ASSISTANT_INBOX_CONFIRM_PATH, { kind: "confirmed" });
		const marked = await call();
		answers.set(ASSISTANT_INBOX_CONFIRM_PATH, { kind: "unsaved" });
		const unmarked = await call();
		answers.set(ASSISTANT_INBOX_CONFIRM_PATH, new Error("socket hang up"));
		const lost = await call();

		expect(posted[1]).toEqual({ path: ASSISTANT_INBOX_CONFIRM_PATH, body: { boundaries: { github: 4 } } });
		for (const result of [unmarked, lost]) {
			expect(result.isError).toBeFalsy();
			expect(result.content[0]?.text).toContain("Review requested");
			expect(result.content[0]?.text).not.toBe(marked.content[0]?.text);
		}
	});

	it("confirms nothing when nothing waits, and refuses a session that is not the assistant", async () => {
		answers.set("/assistant/inbox", { kind: "events", events: [], boundaries: {}, evicted: {} });
		const empty = await call();
		answers.set("/assistant/inbox", { kind: "not_assistant" });
		const refused = await call();

		expect(posted.map((post) => post.path)).toEqual(["/assistant/inbox", "/assistant/inbox"]);
		expect(empty.isError).toBeFalsy();
		expect(refused.isError).toBe(true);
	});
});
