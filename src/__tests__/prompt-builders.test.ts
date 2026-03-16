import { describe, expect, it } from "vitest";
import { buildFollowUpPrompt, buildInitialPrompt } from "../mcp/prompt-builders.js";

const msg = {
	from: "team-alpha",
	request_type: "feature",
	body: "Please implement the widget.",
};
const port = 9999;
const sessionId = "abc-123-def";

describe("buildInitialPrompt", () => {
	it("contains From, Type, session_id, and proxy port", () => {
		const result = buildInitialPrompt(msg, port, sessionId);
		expect(result).toContain("From: team-alpha");
		expect(result).toContain("Type: feature");
		expect(result).toContain(`session_id: ${sessionId}`);
		expect(result).toContain(`127.0.0.1:${port}`);
	});

	it("curl example contains correct port and session_id", () => {
		const result = buildInitialPrompt(msg, port, sessionId);
		expect(result).toContain(`curl -s -X POST http://127.0.0.1:${port}/respond`);
		expect(result).toContain(`"session_id":"${sessionId}"`);
	});

	it("msg.body appears at the end unmodified", () => {
		const result = buildInitialPrompt(msg, port, sessionId);
		expect(result).toContain(msg.body);
		expect(result.trimEnd().endsWith(msg.body)).toBe(true);
	});

	it("special characters in body are not mangled", () => {
		const special = { ...msg, body: 'Use `code` and "quotes" & <tags>' };
		const result = buildInitialPrompt(special, port, sessionId);
		expect(result).toContain('Use `code` and "quotes" & <tags>');
	});
});

describe("buildFollowUpPrompt", () => {
	it("contains Follow-up, from, session_id, and proxy port", () => {
		const result = buildFollowUpPrompt(msg, port, sessionId);
		expect(result).toContain("Follow-up");
		expect(result).toContain("From: team-alpha");
		expect(result).toContain(`session_id: ${sessionId}`);
		expect(result).toContain(`127.0.0.1:${port}`);
	});

	it("does NOT contain Type: line", () => {
		const result = buildFollowUpPrompt(msg, port, sessionId);
		expect(result).not.toContain("Type:");
	});

	it("msg.body appears at the end unmodified", () => {
		const result = buildFollowUpPrompt(msg, port, sessionId);
		expect(result).toContain(msg.body);
		expect(result.trimEnd().endsWith(msg.body)).toBe(true);
	});
});
