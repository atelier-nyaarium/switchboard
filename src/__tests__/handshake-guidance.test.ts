import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ handshakeIds: new Set<string>(), sendFails: false }));

vi.mock("../mcp/bridge/helpers.js", () => ({
	bridgeConversationId: () => "conv.test",
	confirmHandshakeRole: (id: string) => bridge.handshakeIds.has(id),
}));

vi.mock("../mcp/bridge/replyTool.js", () => ({
	postReply: async () =>
		bridge.sendFails
			? { content: [{ type: "text", text: "Failed to send reply" }], isError: true }
			: { content: [{ type: "text", text: "Reply sent." }] },
	readReplyAttachments: async () => [],
	toolError: (text: string) => ({ content: [{ type: "text", text }], isError: true }),
}));

const { handleChannelReplyStructured } = await import("../mcp/channel/channelReply.js");
const { capabilityHookOutput, fitGuidance, MAX_GUIDANCE_CHARS } = await import("../mcp/baseline/capabilityHook.js");

const GUIDANCE = "## vault\n\nRun `sudo -A <command>`.";
const guidance = async () => GUIDANCE;
const texts = (result: { content: { text: string }[] }) => result.content.map((part) => part.text);

describe("the handshake answer", () => {
	beforeEach(() => {
		bridge.handshakeIds = new Set(["hs-1"]);
		bridge.sendFails = false;
	});

	it("carries the session's guidance, and only for this process's handshake", async () => {
		const handshake = await handleChannelReplyStructured(
			{ session_id: "hs-1", responseData: { isMainOrLead: true } },
			guidance,
		);
		const relayed = await handleChannelReplyStructured(
			{ session_id: "hs-other", responseData: { isMainOrLead: true } },
			guidance,
		);
		const ordinary = await handleChannelReplyStructured(
			{ session_id: "conv.x", responseData: { ok: 1 } },
			guidance,
		);

		expect(texts(handshake)).toEqual(["Reply sent.", GUIDANCE]);
		expect(texts(relayed)).toEqual(["Reply sent."]);
		expect(texts(ordinary)).toEqual(["Reply sent."]);
	});

	it("carries nothing when the answer did not go", async () => {
		bridge.sendFails = true;
		const failed = await handleChannelReplyStructured(
			{ session_id: "hs-1", responseData: { isMainOrLead: true } },
			guidance,
		);

		expect(failed.isError).toBe(true);
		expect(texts(failed)).not.toContain(GUIDANCE);
	});
});

describe("the compaction hook", () => {
	const contextOf = (output: string) => JSON.parse(output).hookSpecificOutput.additionalContext as string;

	it("renders the set the session started with, and the assistant's own", async () => {
		const scopes: unknown[] = [];
		const deps = {
			guidance: async (scope: unknown) => {
				scopes.push(scope);
				return GUIDANCE;
			},
			startup: (project: string | undefined) => (project === "host.worker" ? [{ id: "vault" }] : null),
		};
		const worker = await capabilityHookOutput({ PROJECT_NAME: "host.worker" }, deps);
		await capabilityHookOutput({ PROJECT_NAME: "host.assistant" }, deps);

		expect(contextOf(worker)).toBe(GUIDANCE);
		expect(scopes).toEqual([
			{ assistant: false, startup: [{ id: "vault" }] },
			{ assistant: true, startup: null },
		]);
	});

	it("says where the guidance is when it cannot be read", async () => {
		const output = await capabilityHookOutput(
			{},
			{
				guidance: async () => {
					throw new Error("gateway down");
				},
			},
		);

		expect(contextOf(output)).toContain("switchboard_capabilities");
	});

	it("cuts an oversized guidance at a section, under the hook cap", () => {
		const section = (name: string) => `## ${name}\n\n${"x".repeat(4_000)}`;
		const fitted = fitGuidance([section("a"), section("b"), section("c")].join("\n"));

		expect(fitted.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARS);
		expect(fitted).toContain("## b");
		expect(fitted).not.toContain("## c");
		expect(fitted).toContain("switchboard_capabilities");
	});
});
