import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initBridge, routerErrorText, routerPost } from "../mcp/bridge/helpers.js";
import { codexRequestBody, codexStartDefaults } from "../mcp/codex/codexTools.js";
import { pluginProfile } from "../mcp/sessionCli.js";
import { CodexRequestErrorSchema, sanitizeCodexErrorText } from "../shared/codex-agent.js";
import { modelFamily, sameFamily } from "../shared/model-family.js";

describe("Codex request identities", () => {
	it("mints distinct ids for every call but a list", () => {
		const first = codexRequestBody("start", { prompt: "Audit" });
		const second = codexRequestBody("start", { prompt: "Audit" });
		expect(first.operationId).not.toBe(second.operationId);
		expect(codexRequestBody("await", { agentId: "codex_0123456789abcdef0123456789abcdef" })).toHaveProperty(
			"operationId",
		);
		expect(codexRequestBody("list")).not.toHaveProperty("operationId");
	});

	it("applies start defaults without copying them to later turns", () => {
		expect(codexRequestBody("start", { prompt: "Audit" })).toMatchObject({
			model: expect.any(String),
			serviceTier: "priority",
		});
		expect(codexRequestBody("start", { prompt: "Audit", model: "gpt-6.1-sol" })).not.toHaveProperty("serviceTier");
		expect(
			codexRequestBody("message", { agentId: "codex_0123456789abcdef0123456789abcdef", prompt: "Continue" }),
		).not.toHaveProperty("model");
	});

	it("gives priority to any Luna model that names no tier, and lets a named tier win", () => {
		expect(codexStartDefaults({})).toEqual({ model: "gpt-6-luna", serviceTier: "priority" });
		expect(codexStartDefaults({ model: "gpt-6.1-luna" })).toEqual({
			model: "gpt-6.1-luna",
			serviceTier: "priority",
		});
		expect(codexStartDefaults({ model: "gpt-6.1-luna", serviceTier: "standard" })).toEqual({
			model: "gpt-6.1-luna",
			serviceTier: "standard",
		});
		expect(codexStartDefaults({ model: "gpt-6.1-sol" })).toEqual({ model: "gpt-6.1-sol" });
	});
});

describe("a model's family", () => {
	it("joins versions of one line and keeps sizes and lines apart", () => {
		const pairs: Array<[string, string, boolean]> = [
			["claude-opus-5-4", "claude-opus-5-5", true],
			["gpt-6-luna", "gpt-6.1-luna", true],
			["gpt-6.1-sol", "gpt-6.1-luna", false],
			["deepseek-v4-pro", "deepseek-v4.1-flash", false],
			["glm-5.2", "glm-5.3", true],
			["glm-5.3", "glm-5.3-flash", false],
		];

		expect(pairs.map(([a, b]) => sameFamily(a, b))).toEqual(pairs.map(([, , same]) => same));
		expect(modelFamily("gpt-6-luna")).toBe(modelFamily("GPT-6.1-Luna"));
	});
});

describe("routerPost", () => {
	let server: http.Server;
	let reply: { status: number; body: unknown };

	beforeAll(async () => {
		server = http.createServer((_request, response) => {
			response.writeHead(reply.status, { "content-type": "application/json" });
			response.end(JSON.stringify(reply.body));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		initBridge({
			routerUrl: `http://127.0.0.1:${port}`,
			projectName: "recipe-app.work",
			profile: pluginProfile("claude"),
		});
	});

	afterAll(() => server.close());

	it("returns the parsed gateway value", async () => {
		reply = { status: 200, body: { agentId: "codex_0123456789abcdef0123456789abcdef", observation: "terminal" } };
		expect(await routerPost("/codex", codexRequestBody("list"), { retries: 0 })).toEqual(reply.body);
	});

	it("exposes structured HTTP failures as an error object", async () => {
		reply = {
			status: 400,
			body: CodexRequestErrorSchema.parse({
				error: { code: "invalid_input", retryable: false, message: sanitizeCodexErrorText("invalid request") },
			}),
		};
		try {
			await routerPost("/codex", codexRequestBody("list"), { retries: 0 });
			expect.fail("request should reject");
		} catch (error) {
			expect(error).toMatchObject({ status: 400 });
		}
	});

	it("preserves status when the error body is null", async () => {
		reply = { status: 502, body: null };
		try {
			await routerPost("/codex", codexRequestBody("list"), { retries: 0 });
			expect.fail("request should reject");
		} catch (error) {
			expect(error).toMatchObject({ status: 502 });
		}
	});
});

describe("routerErrorText", () => {
	it.each([
		["plain", "plain"],
		[{ message: "structured" }, "structured"],
		[undefined, undefined],
		[{ code: "invalid_input" }, undefined],
		[42, undefined],
	] as const)("extracts a supported value", (failure, expected) => expect(routerErrorText(failure)).toBe(expected));
});
