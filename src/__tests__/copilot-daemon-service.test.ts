import { expect, it } from "vitest";
import type { AgentChild, TargetSupervisor } from "../mcp/devcontainer/codexTargets.js";
import { CopilotDaemonService } from "../mcp/devcontainer/copilotDaemonService.js";
import type { CopilotHeadlessClient, SessionEvent } from "../mcp/devcontainer/copilotHeadless.js";

const OWNER_KEY = "recipe-app.work";
const AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
async function settle(): Promise<void> {
	for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

it("streams a Copilot ACP turn into accepted, activity, and terminal frames", async () => {
	const child = {} as AgentChild;
	const sent: Record<string, unknown>[] = [];
	let listener: (sessionId: string, event: SessionEvent) => void = () => {};
	const client = {
		onEvent(next: (sessionId: string, event: SessionEvent) => void) {
			listener = next;
		},
		createSession: async () => "session-1",
		listModels: async () => [{ id: "gpt-6-luna", reasoningEfforts: ["low", "medium"] }],
		resumeSession: async () => {},
		send: async () => "message-1",
		abort: async () => {},
		close: () => {},
	} as unknown as CopilotHeadlessClient;
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 3, child } }),
		release: () => {},
	};
	const service = new CopilotDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => client,
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();

	expect(sent).toContainEqual(
		expect.objectContaining({ type: "copilot_receipt", kind: "accepted", sessionId: "session-1" }),
	);
	const event = (type: string, data: Record<string, unknown> = {}) => listener("session-1", { type, data });
	event("assistant.message", { content: "Reading the parser." });
	event("tool.execution_start", { toolName: "bash", arguments: { command: "cat parser.ts" } });
	event("assistant.message", { content: "Done." });
	event("session.idle");
	await settle();

	const notes = sent.filter((frame) => frame.type === "copilot_event" && frame.kind === "activity");
	expect(notes.map((frame) => frame.text)).toEqual(["Reading the parser.", "bash: cat parser.ts", "Done."]);
	expect(sent).toContainEqual(
		expect.objectContaining({
			type: "copilot_event",
			kind: "terminal",
			state: "completed",
			finalResponse: "Done.",
		}),
	);
});

it("rejects a start whose session the runtime refused", async () => {
	const sent: Record<string, unknown>[] = [];
	const client = {
		onEvent: () => {},
		createSession: async () => {
			throw new Error("model unavailable is not offered");
		},
		listModels: async () => [{ id: "gpt-6-luna", reasoningEfforts: ["low", "medium"] }],
		resumeSession: async () => {},
		send: async () => "message-1",
		abort: async () => {},
		close: () => {},
	} as unknown as CopilotHeadlessClient;
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
		release: () => {},
	};
	const service = new CopilotDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => client,
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		model: "unavailable",
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();

	expect(sent).toContainEqual(
		expect.objectContaining({
			kind: "rejected",
			error: "model unavailable is not offered",
		}),
	);
});

it("refuses a command whose generation retires while it is in flight", async () => {
	const sent: Record<string, unknown>[] = [];
	let started = () => {};
	const opening = new Promise<void>((resolve) => {
		started = resolve;
	});
	const client = {
		onEvent: () => {},
		createSession: async () => "session-1",
		listModels: async () => [{ id: "gpt-6-luna", reasoningEfforts: ["low", "medium"] }],
		resumeSession: async () => {},
		send: async () => "message-1",
		abort: async () => {},
		close: () => {},
	} as unknown as CopilotHeadlessClient;
	let generation = 1;
	const service = new CopilotDaemonService({
		targets: {
			acquire: () => ({ state: "running", lease: { generation, child: {} as AgentChild } }),
			release: () => {},
		},
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => {
			await opening;
			return client;
		},
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();
	// A newer generation takes the target while the first is still opening.
	generation = 2;
	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: "123e4567-e89b-42d3-a456-426614174005",
		ownerKey: OWNER_KEY,
		agentId: "copilot_fedcba9876543210fedcba9876543210",
		operationId: "123e4567-e89b-42d3-a456-426614174006",
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the lexer",
	});
	started();
	await settle();

	// Losing the acceptance instead would leave that caller waiting on a generation nobody holds.
	expect(sent.filter((message) => message.agentId === AGENT_ID)).toMatchObject([{ kind: "rejected" }]);
});

it("classifies login failures in rejected receipts", async () => {
	const sent: Record<string, unknown>[] = [];
	const targets: TargetSupervisor = {
		acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
		release: () => {},
	};
	const service = new CopilotDaemonService({
		targets,
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => {
			throw new Error("Copilot login required");
		},
		resolveHostCwd: () => "/home/agent",
	});

	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
	});
	await settle();

	expect(sent).toContainEqual(
		expect.objectContaining({
			kind: "rejected",
			daemonInstanceId: "daemon-1",
			failureCode: "authentication_required",
		}),
	);
});

it("steers a follow-up into the running turn it names, and refuses one that names another", async () => {
	const sent: Record<string, unknown>[] = [];
	const sends: Array<{ prompt: string; options?: unknown }> = [];
	const client = {
		onEvent: () => {},
		listModels: async () => [],
		createSession: async () => "session-1",
		resumeSession: async () => {},
		send: async (_sessionId: string, prompt: string, options?: unknown) => {
			sends.push({ prompt, options });
			return "message-1";
		},
		steer: async (_sessionId: string, prompt: string) => {
			sends.push({ prompt, options: "steer" });
			return "message-2";
		},
		abort: async () => {},
		close: () => {},
	} as unknown as CopilotHeadlessClient;
	const service = new CopilotDaemonService({
		targets: {
			acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
			release: () => {},
		},
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => client,
		resolveHostCwd: () => "/home/agent",
	});
	const target = { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" } as const;
	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target,
		prompt: "Review the parser",
		outputSchema: { type: "object" },
	});
	await settle();
	const accepted = sent.find((message) => message.kind === "accepted") as { turnId: string; resolvedTarget: unknown };
	expect(sends).toEqual([{ prompt: "Review the parser", options: { outputSchema: { type: "object" } } }]);

	const message = (requestId: string, expectedTurnId: string) =>
		service.handleCommand({
			type: "copilot_command",
			kind: "message",
			requestId,
			ownerKey: OWNER_KEY,
			agentId: AGENT_ID,
			operationId: requestId,
			target: accepted.resolvedTarget,
			sessionId: "session-1",
			expectedTurnId,
			prompt: "Also check the lexer",
		});
	message("123e4567-e89b-42d3-a456-426614174010", accepted.turnId);
	await settle();
	expect(sent.at(-1)).toMatchObject({ kind: "accepted", delivery: "steered", turnId: accepted.turnId });
	expect(sends.at(-1)).toEqual({ prompt: "Also check the lexer", options: "steer" });

	message("123e4567-e89b-42d3-a456-426614174011", "some-settled-turn");
	await settle();
	expect(sent.at(-1)).toMatchObject({ kind: "rejected", error: "Copilot agent is still working" });
});

it("refuses a reasoning effort the catalog does not list for the model", async () => {
	const sent: Record<string, unknown>[] = [];
	let created = 0;
	const client = {
		onEvent: () => {},
		listModels: async () => [{ id: "gpt-6-luna", reasoningEfforts: ["low", "medium"] }],
		createSession: async () => {
			created += 1;
			return "session-1";
		},
		resumeSession: async () => {},
		send: async () => "message-1",
		abort: async () => {},
		close: () => {},
	} as unknown as CopilotHeadlessClient;
	const service = new CopilotDaemonService({
		targets: {
			acquire: () => ({ state: "running", lease: { generation: 1, child: {} as AgentChild } }),
			release: () => {},
		},
		daemonInstanceId: "daemon-1",
		send: (message) => sent.push(message),
		openClient: async () => client,
		resolveHostCwd: () => "/home/agent",
	});
	service.handleCommand({
		type: "copilot_command",
		kind: "start",
		requestId: REQUEST_ID,
		ownerKey: OWNER_KEY,
		agentId: AGENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" },
		prompt: "Review the parser",
		model: "gpt-6-luna",
		reasoningEffort: "max",
	});
	await settle();

	expect(created).toBe(0);
	expect(sent.at(-1)).toMatchObject({
		kind: "rejected",
		error: expect.stringContaining("not offered for gpt-6-luna"),
	});
});
