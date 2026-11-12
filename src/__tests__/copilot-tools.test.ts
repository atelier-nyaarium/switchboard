import { describe, expect, it } from "vitest";
import { agentRequestBody } from "../mcp/agentRequest.js";
import { COPILOT_BACKEND } from "../shared/agent-backend.js";
import { AgentErrorTextSchema, agentErrorText } from "../shared/agent-identity.js";
import { AGENT_ERROR_MAX_BYTES, AGENT_PROMPT_MAX_BYTES } from "../shared/agent-record.js";
import { AgentGatewayRequestSchema, AgentResultSchema, AgentStartInputSchema } from "../shared/agent-state.js";

const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";

describe("Copilot tool contracts", () => {
	it("builds a gateway-valid request for every tool", () => {
		const bodies = [
			agentRequestBody(COPILOT_BACKEND, "start", { prompt: "Review" }),
			agentRequestBody(COPILOT_BACKEND, "message", { agentId: AGENT_ID, prompt: "Continue" }),
			agentRequestBody(COPILOT_BACKEND, "await", { agentId: AGENT_ID }),
			agentRequestBody(COPILOT_BACKEND, "stop", { agentId: AGENT_ID }),
			agentRequestBody(COPILOT_BACKEND, "list"),
		];

		for (const body of bodies) expect(AgentGatewayRequestSchema.safeParse(body).success).toBe(true);
	});

	it("mints operation ids for every call but a list", () => {
		const first = agentRequestBody(COPILOT_BACKEND, "start", { prompt: "Review" });
		const second = agentRequestBody(COPILOT_BACKEND, "start", { prompt: "Review" });

		expect(first.operationId).not.toBe(second.operationId);
		expect(agentRequestBody(COPILOT_BACKEND, "await", { agentId: AGENT_ID })).toHaveProperty("operationId");
		expect(agentRequestBody(COPILOT_BACKEND, "list")).not.toHaveProperty("operationId");
	});

	it("keeps model and cwd on start only", () => {
		expect(
			agentRequestBody(COPILOT_BACKEND, "start", { prompt: "Review", model: "auto", cwd: "/work/tree" }),
		).toMatchObject({
			model: "auto",
			cwd: "/work/tree",
		});
		expect(
			agentRequestBody(COPILOT_BACKEND, "message", { agentId: AGENT_ID, prompt: "x", model: "auto" }),
		).not.toHaveProperty("model");
	});

	it("forwards a supplied cwd and omits an absent cwd", () => {
		const withCwd = agentRequestBody(COPILOT_BACKEND, "start", { prompt: "p", cwd: "/x" });
		expect(withCwd).toMatchObject({ cwd: "/x" });
		expect("cwd" in agentRequestBody(COPILOT_BACKEND, "start", { prompt: "p", cwd: "" })).toBe(true);
		expect("cwd" in agentRequestBody(COPILOT_BACKEND, "start", { prompt: "p" })).toBe(false);
	});

	it("bounds prompts and normalizes errors", () => {
		const prompt = "x".repeat(AGENT_PROMPT_MAX_BYTES);
		expect(AgentStartInputSchema.parse({ prompt }).prompt).toBe(prompt);
		expect(AgentStartInputSchema.safeParse({ prompt: `${prompt}x` }).success).toBe(false);

		const sanitized = agentErrorText(` daemon\nfailed\u0000 ${"🙂".repeat(AGENT_ERROR_MAX_BYTES)} `);
		expect(AgentErrorTextSchema.safeParse(sanitized).success).toBe(true);
		expect(AgentErrorTextSchema.safeParse(` daemon\nfailed\u0000 `).success).toBe(false);
	});

	it("rejects result states that claim impossible work", () => {
		const base = { agentId: AGENT_ID, activities: [] };
		expect(
			AgentResultSchema.safeParse({
				...base,
				agentState: "working",
				observation: "accepted",
				turn: { id: "turn-1", state: "inProgress" },
				delivery: "started",
			}).success,
		).toBe(true);
		expect(AgentResultSchema.safeParse({ ...base, agentState: "working", observation: "accepted" }).success).toBe(
			false,
		);
		expect(
			AgentResultSchema.safeParse({
				...base,
				agentState: "idle",
				observation: "idle",
				turn: { id: "turn-1", state: "completed" },
			}).success,
		).toBe(false);
		expect(
			AgentResultSchema.safeParse({
				...base,
				agentState: "recovering",
				observation: "indeterminate",
				error: { code: "indeterminate", message: "unknown", retryable: true },
				turn: { id: "turn-1", state: "inProgress" },
			}).success,
		).toBe(false);
	});
});
