import { describe, expect, it } from "vitest";
import { buildFollowUpPrompt, buildInitialPrompt } from "../mcp/cli/promptBuilders.js";

const msg = {
	from: "team-alpha",
	request_type: "feature",
	body: "Please implement the widget.",
};
const sessionId = "abc-123-def";

describe("buildInitialPrompt", () => {
	it("contains From, Type, and session_id", () => {
		const result = buildInitialPrompt(msg, sessionId);
		expect(result).toContain("From: team-alpha");
		expect(result).toContain("Type: feature");
		expect(result).toContain(`session_id: ${sessionId}`);
	});

	it("contains crosstalk_reply instruction", () => {
		const result = buildInitialPrompt(msg, sessionId);
		expect(result).toContain("crosstalk_reply");
	});

	it("msg.body appears at the end unmodified", () => {
		const result = buildInitialPrompt(msg, sessionId);
		expect(result).toContain(msg.body);
		expect(result.trimEnd().endsWith(msg.body)).toBe(true);
	});

	it("special characters in body are not mangled", () => {
		const special = { ...msg, body: 'Use `code` and "quotes" & <tags>' };
		const result = buildInitialPrompt(special, sessionId);
		expect(result).toContain('Use `code` and "quotes" & <tags>');
	});
});

describe("buildFollowUpPrompt", () => {
	it("contains Follow-up, from, and session_id", () => {
		const result = buildFollowUpPrompt(msg, sessionId);
		expect(result).toContain("Follow-up");
		expect(result).toContain("From: team-alpha");
		expect(result).toContain(`session_id: ${sessionId}`);
	});

	it("does NOT contain Type: line", () => {
		const result = buildFollowUpPrompt(msg, sessionId);
		expect(result).not.toContain("Type:");
	});

	it("msg.body appears at the end unmodified", () => {
		const result = buildFollowUpPrompt(msg, sessionId);
		expect(result).toContain(msg.body);
		expect(result.trimEnd().endsWith(msg.body)).toBe(true);
	});
});
