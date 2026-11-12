import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowRunRecord, WorkflowStartInput } from "../gateway/workflows/workflowSchemas.js";
import { AGENT_BACKEND_IDS } from "../shared/agent-backend.js";
import type { CodexDaemonEvent } from "../shared/codexAgentRelay.js";
import { composeSessionName } from "../shared/session-id.js";
import { type CodexResponder, type FakeCodexDaemon, stockCodexResponder } from "../testing/fakeHost.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness, waitFor } from "../testing/federationHarness.js";

interface HeldTurn {
	daemon: FakeCodexDaemon;
	terminal: Extract<CodexDaemonEvent, { kind: "terminal" }>;
}

describe("workflow steps through the federation harness", () => {
	let h: FederationHarness;
	let session: FakeSession;
	let team: string;
	let testerRound = 0;

	const startRun = (script: string, options: Partial<WorkflowStartInput> = {}): WorkflowRunRecord => {
		const result = h.gateway.faults.workflowStart({
			team,
			operationId: randomUUID(),
			resumeFrom: null,
			script,
			args: {},
			defaultBackend: "codex",
			phases: [],
			...options,
		});
		expect(result.kind).toBe("started");
		if (result.kind !== "started") throw new Error("workflow did not start");
		return result.run;
	};

	const waitForStatus = async (runId: string, status: WorkflowRunRecord["status"]): Promise<WorkflowRunRecord> =>
		waitFor(() => {
			const record = h.gateway.faults.workflowRecord(runId);
			return record?.status === status ? record : undefined;
		}, `workflow ${status}`);

	const withAnswer: CodexResponder = (command, daemon) => {
		const text = command.kind === "start" || command.kind === "message" ? command.prompt : "";
		let answer: unknown = "Mock edit and build.";
		if (text.includes("Mock tester")) {
			testerRound += 1;
			answer = { pass: testerRound > 1, version: 5, failure: testerRound > 1 ? null : "tests failed" };
		} else if (text.includes("Mock verifier")) {
			answer = { version: 5, isFive: true };
		}
		return (stockCodexResponder(command, daemon) ?? []).map((frame) => {
			if (frame.type === "codex_event" && frame.kind === "terminal") {
				return {
					...frame,
					finalResponse: typeof answer === "string" ? answer : JSON.stringify(answer),
				};
			}
			return frame;
		});
	};

	beforeEach(async () => {
		testerRound = 0;
		session = undefined!;
		team = "";
		h = await startFederationHarness({
			drive: "manual",
			host: { onCodexCommand: withAnswer },
			workflowProgressIntervalMsForTests: 1_000,
		});
		h.host.handlers.onCreateSession = (op) => {
			team = composeSessionName(op.target.name, op.target.sessionName);
			session = attachFakeSession(h.gateway, {
				team,
				conversationId: "workflow-session",
				sessionToken: op.sessionToken,
			});
		};
		const before = h.host.wakes.length;
		const launched = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: "Workflow",
		});
		expect(launched.result).toMatchObject({ created: true });
		await waitFor(() => (session && h.host.wakes.length >= before ? session : undefined), "workflow session");
		await session.ready();
	}, 30_000);

	afterEach(async () => {
		session?.close();
		if (h) await h.close();
	});

	it("runs the workflow example with one reused implementer thread", async () => {
		testerRound = 0;
		const script = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "workflow-example.workflow"), "utf8");
		const run = startRun(script, { args: { dir: "/tmp/project" } });
		const record = await waitForStatus(run.runId, "succeeded");
		expect(record.result).toEqual({ ok: true, rounds: 2, version: 5 });
		const implementer = h.host.codexCommands.filter(
			(command) =>
				(command.kind === "start" || command.kind === "message") && command.prompt.includes("Mock implementer"),
		);
		expect(implementer.map((command) => command.kind)).toEqual(["start", "message"]);
		expect(implementer[0]?.agentId).toBe(implementer[1]?.agentId);
	});

	it("runs a step through each installed agent backend", async () => {
		const steps = AGENT_BACKEND_IDS.map((id) => `await agent("${id} step", {backend: "${id}"});`).join(" ");
		const run = startRun(`export const meta = {}; ${steps} return true;`);
		const record = await waitForStatus(run.runId, "succeeded");
		expect(record.result).toBe(true);
		for (const id of AGENT_BACKEND_IDS) {
			const commands = id === "codex" ? h.host.codexCommands : h.host.agentCommands(id);
			expect(
				commands.some((command) => command.kind === "start" && command.prompt.includes(`${id} step`)),
				id,
			).toBe(true);
		}
		expect(h.gateway.faults.workflowRows(run.runId).filter((row) => row.kind === "settle")).toEqual(
			AGENT_BACKEND_IDS.map((_, index) =>
				expect.objectContaining({ issueOrdinal: index + 1, outcome: "completed" }),
			),
		);
	});

	it("runs two Claude steps with one workflow notice", async () => {
		h.host.handlers.onClaudeRun = (op) => ({ answer: op.prompt.includes("second") ? "two" : "one" });
		const run = startRun(
			`export const meta = {}; const first = await agent("first"); const second = await agent("second"); return [first, second];`,
			{ defaultBackend: "claude" },
		);
		const record = await waitForStatus(run.runId, "succeeded");
		expect(record.result).toEqual(["one", "two"]);
		const settleNotice = () =>
			session.inbound.find(
				(frame) =>
					JSON.stringify(frame.awareness ?? {}).includes(run.runId) &&
					JSON.stringify(frame.awareness ?? {}).includes("act_now"),
			);
		for (let attempt = 0; attempt < 65 && !settleNotice(); attempt += 1) await h.ambient.advance(1_000);
		await waitFor(() => settleNotice(), "Claude settle notice");
		const chain = session.inbound.filter((frame) => JSON.stringify(frame.awareness ?? {}).includes(run.runId));
		expect(chain).toHaveLength(1);
		expect(chain.filter((frame) => JSON.stringify(frame.awareness ?? {}).includes("act_now"))).toHaveLength(1);
		expect(chain.some((frame) => JSON.stringify(frame.awareness ?? {}).includes("Claude agent"))).toBe(false);
		expect(h.gateway.faults.workflowRecord(run.runId)?.notified).toBe(true);
	});

	it("withholds the settle notice of a run collected first", async () => {
		h.host.handlers.onClaudeRun = () => ({ answer: "one" });
		const run = startRun(`export const meta = {}; return await agent("first");`, { defaultBackend: "claude" });
		await waitForStatus(run.runId, "succeeded");
		for (let attempt = 0; attempt < 3; attempt += 1) await h.ambient.advance(1_000);
		expect(await (await session.post("/workflow/collect", { runId: run.runId })).json()).toMatchObject({
			result: "one",
		});
		for (let attempt = 0; attempt < 65; attempt += 1) await h.ambient.advance(1_000);
		expect(
			session.inbound.some((frame) => JSON.stringify(frame.awareness ?? {}).includes(`${run.runId} succeeded`)),
		).toBe(false);
		expect(h.gateway.faults.workflowRecord(run.runId)).toMatchObject({ collected: true, notified: true });
	});

	it("hands back step answers for a run that ended without a result", async () => {
		h.host.handlers.onClaudeRun = () => ({ answer: "one" });
		const run = startRun(`export const meta = {}; await agent("first", {label: "a"}); throw new Error("boom");`, {
			defaultBackend: "claude",
		});
		await waitForStatus(run.runId, "failed");
		expect(await (await session.post("/workflow/collect", { runId: run.runId })).json()).toMatchObject({
			status: "failed",
			result: null,
			steps: [{ label: "a", outcome: "completed", answer: "one" }],
		});
	});

	it("resumes a Claude thread session on its second step", async () => {
		const run = startRun(
			`export const meta = {}; await agent("first", {thread: "implementer"}); await agent("second", {thread: "implementer"}); return true;`,
			{ defaultBackend: "claude" },
		);
		await waitForStatus(run.runId, "succeeded");
		expect(h.host.claudeRuns).toHaveLength(2);
		expect(h.host.claudeRuns[1]?.sessionId).toBe(h.host.claudeRuns[0]?.sessionId);
		expect(h.host.claudeRuns.map(({ resume }) => resume)).toEqual([false, true]);
	});

	it("journals and acknowledges a Claude result after the session goes offline", async () => {
		let runId = "";
		let settlesAtAck = 0;
		h.host.handlers.onClaudeRun = () => ({ answer: { ok: true }, delayMs: 50 });
		h.host.handlers.onClaudeAck = () => {
			settlesAtAck = h.gateway.faults.workflowRows(runId).filter((row) => row.kind === "settle").length;
		};
		const run = startRun(`export const meta = {}; return await agent("offline result");`, {
			defaultBackend: "claude",
		});
		runId = run.runId;
		await waitFor(() => (h.host.claudeRuns.length === 1 ? true : undefined), "Claude turn accepted");
		session.close();
		const record = await waitForStatus(run.runId, "succeeded");
		await waitFor(() => (h.host.claudeAcks.length === 1 ? true : undefined), "Claude result ack");
		expect(record.result).toEqual({ ok: true });
		expect(settlesAtAck).toBe(1);
		expect(h.gateway.faults.workflowRows(run.runId)).toContainEqual(
			expect.objectContaining({ kind: "settle", issueOrdinal: 1, outcome: "completed" }),
		);
	});

	it("settles a Claude step lost to a daemon restart as interrupted", async () => {
		h.host.handlers.onClaudeRun = () => ({ answer: "late", delayMs: 100 });
		const run = startRun(`export const meta = {}; return await agent("held turn");`, {
			defaultBackend: "claude",
		});
		const oldDaemonId = h.host.daemon.daemonInstanceId;
		await waitFor(() => (h.host.claudeRuns.length === 1 ? true : undefined), "Claude turn accepted");
		h.restartHost({ newDaemon: true });
		const record = await waitForStatus(run.runId, "succeeded");
		expect(record.result).toBeNull();
		expect(h.host.daemon.daemonInstanceId).not.toBe(oldDaemonId);
		expect(h.gateway.faults.workflowRows(run.runId)).toContainEqual(
			expect.objectContaining({
				kind: "settle",
				issueOrdinal: 1,
				outcome: "interrupted",
				reason: "runner lost: the host daemon restarted",
			}),
		);
	});

	it("cancels Claude on stop", async () => {
		h.host.handlers.onClaudeRun = () => ({ answer: "late", delayMs: 10_000 });
		const run = startRun(`export const meta = {}; return await agent("long turn");`, { defaultBackend: "claude" });
		await waitFor(() => (h.host.claudeRuns.length === 1 ? true : undefined), "Claude turn accepted");
		const stopped = await session.post("/workflow/stop", { runId: run.runId });
		expect(stopped.status).toBe(200);
		await waitForStatus(run.runId, "cancelled");
		await waitFor(() => (h.host.claudeCancels.length > 0 ? true : undefined), "Claude cancel");
		expect(h.host.claudeCancels[0]).toMatchObject({ runId: run.runId, turnId: h.host.claudeRuns[0]?.turnId });
	});

	it("serves authenticated owner-scoped workflow start, collect, list and stop routes", async () => {
		const operationId = randomUUID();
		const body = { operationId, script: `export const meta = {}; return {ok: true};` };
		const started = await session.post("/workflow/start", body);
		expect(started.status).toBe(200);
		const first = (await started.json()) as { runId: string; existing: boolean };
		expect(first.existing).toBe(false);
		const repeated = await session.post("/workflow/start", body);
		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toMatchObject({ runId: first.runId, existing: true });
		await waitForStatus(first.runId, "succeeded");
		expect(await (await session.post("/workflow/list", {})).json()).toEqual({
			runs: [
				{
					runId: first.runId,
					name: null,
					status: "succeeded",
					createdAt: expect.any(Number),
					settledAt: expect.any(Number),
					steps: {},
				},
			],
		});
		const collected = await session.post("/workflow/collect", { runId: first.runId });
		expect(collected.status).toBe(200);
		expect(await collected.json()).toMatchObject({ status: "succeeded", result: { ok: true }, steps: [] });
		expect(await (await session.post("/workflow/list", {})).json()).toEqual({ runs: [] });
		expect(await (await session.post("/workflow/collect", { runId: first.runId })).json()).toMatchObject({
			result: { ok: true },
		});

		const foreign = h.gateway.faults.workflowStart({
			team: "foreign-session",
			operationId: randomUUID(),
			resumeFrom: null,
			script: `export const meta = {}; return true;`,
			args: {},
			defaultBackend: "codex",
			phases: [],
		});
		expect(foreign.kind).toBe("started");
		if (foreign.kind !== "started") throw new Error("foreign workflow did not start");
		await waitForStatus(foreign.run.runId, "succeeded");
		const hidden = await session.post("/workflow/collect", { runId: foreign.run.runId });
		expect(hidden.status).toBe(404);
		const unauthenticated = await h.gateway.router(
			new Request("http://gateway.test/workflow/list", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(unauthenticated.status).toBe(403);
	});

	it("opens two correction turns on the same agent and journals invalid", async () => {
		h.host.handlers.onCodexCommand = (command, daemon) => {
			const replies = stockCodexResponder(command, daemon) ?? [];
			return replies.map((frame) =>
				frame.type === "codex_event" && frame.kind === "terminal" ? { ...frame, finalResponse: "{}" } : frame,
			);
		};
		const script = `export const meta = {};\nawait agent("give an object", {schema: {type: "object", required: ["ok"], properties: {ok: {type: "boolean"}}}}); return true;`;
		const run = startRun(script);
		const record = await waitForStatus(run.runId, "succeeded");
		expect(record.result).toBe(true);
		const rows = h.gateway.faults.workflowRows(run.runId);
		const turns = rows.filter(
			(row): row is Extract<(typeof rows)[number], { kind: "turn" }> =>
				row.kind === "turn" && row.issueOrdinal === 1,
		);
		expect(turns).toHaveLength(3);
		expect(new Set(turns.map((row) => row.agentId)).size).toBe(1);
		expect(rows).toContainEqual(expect.objectContaining({ kind: "settle", issueOrdinal: 1, outcome: "invalid" }));
	});

	it("retries a start and a thread message once under each new daemon", async () => {
		let holdStart = true;
		let holdMessage = true;
		const responder: CodexResponder = (command, daemon) => {
			if (command.kind === "start" && holdStart) {
				holdStart = false;
				return [];
			}
			if (command.kind === "message" && holdMessage) {
				holdMessage = false;
				return [];
			}
			return stockCodexResponder(command, daemon);
		};
		h.host.handlers.onCodexCommand = responder;
		const run = startRun(
			`export const meta = {}; await agent("first", {thread: "same"}); await agent("second", {thread: "same"}); return true;`,
		);
		const firstHost = h.host;
		await waitFor(
			() => firstHost.codexCommands.some((command) => command.kind === "start") || undefined,
			"first start",
		);
		h.restartHost({ newDaemon: true, deferCatalog: true });
		const secondHost = h.host;
		const abandoned = await waitFor(
			() =>
				h.gateway.faults
					.workflowAgents(team)
					.find(
						(agent) =>
							agent.runId === run.runId &&
							agent.operations.some(
								(operation) =>
									operation.kind === "start" &&
									operation.state === "indeterminate" &&
									operation.daemonInstanceId === firstHost.daemon.daemonInstanceId,
							),
					),
			"abandoned start operation",
		);
		const originalTurn = h.gateway.faults.workflowRows(run.runId).find((row) => row.kind === "turn");
		expect(abandoned.operations).toContainEqual(
			expect.objectContaining({
				operationId: originalTurn?.kind === "turn" ? originalTurn.operationId : undefined,
				kind: "start",
				state: "indeterminate",
				daemonInstanceId: firstHost.daemon.daemonInstanceId,
			}),
		);
		await waitFor(
			() => secondHost.codexCommands.find((command) => command.kind === "start"),
			"register retry start",
		);
		expect(secondHost.codexCommands.filter((command) => command.kind === "start")).toHaveLength(1);
		secondHost.announceCatalog();
		await waitFor(
			() => secondHost.codexCommands.find((command) => command.kind === "message"),
			"first thread message",
		);
		h.restartHost({ newDaemon: true });
		const thirdHost = h.host;
		await waitFor(() => thirdHost.codexCommands.find((command) => command.kind === "message"), "retried message");
		await waitForStatus(run.runId, "succeeded");
		const turns = h.gateway.faults.workflowRows(run.runId).filter((row) => row.kind === "turn");
		const startTurns = turns.filter((row) => row.issueOrdinal === 1);
		const messageTurns = turns.filter((row) => row.issueOrdinal === 2);
		expect(startTurns.map((row) => row.registerInstanceId)).toEqual([
			firstHost.daemon.daemonInstanceId,
			secondHost.daemon.daemonInstanceId,
		]);
		expect(messageTurns.map((row) => row.registerInstanceId)).toEqual([
			secondHost.daemon.daemonInstanceId,
			thirdHost.daemon.daemonInstanceId,
		]);
		expect(new Set(startTurns.map((row) => row.operationId)).size).toBe(2);
		expect(new Set(messageTurns.map((row) => row.operationId)).size).toBe(2);
		for (const [host, kind] of [
			[firstHost, "start"],
			[secondHost, "start"],
			[secondHost, "message"],
			[thirdHost, "message"],
		] as const) {
			const operationIds = host.codexCommands
				.filter((command) => command.kind === kind)
				.flatMap((command) => ("operationId" in command ? [command.operationId] : []));
			expect(new Set(operationIds).size).toBe(1);
		}
	});

	it("cancels a working run and stops its step agent", async () => {
		h.host.handlers.onCodexCommand = (command, daemon) => {
			if (command.kind === "interrupt") return stockCodexResponder(command, daemon);
			return (stockCodexResponder(command, daemon) ?? []).filter(
				(frame) => !(frame.type === "codex_event" && frame.kind === "terminal"),
			);
		};
		const run = startRun(`export const meta = {}; await agent("keep working"); return true;`);
		await waitFor(
			() => h.host.codexCommands.some((command) => command.kind === "start") || undefined,
			"working start",
		);
		await waitFor(
			() =>
				h.gateway.faults
					.workflowAgents(team)
					.some((agent) => agent.runId === run.runId && agent.state === "working") || undefined,
			"working run agent",
		);
		const stopped = await session.post("/workflow/stop", { runId: run.runId });
		expect(stopped.status).toBe(200);
		expect(await stopped.json()).toMatchObject({ runId: run.runId, status: "cancelled", stopped: true });
		await waitForStatus(run.runId, "cancelled");
		await waitFor(
			() => h.host.codexCommands.some((command) => command.kind === "interrupt") || undefined,
			"step stop",
		);
	});

	it("stops an in-flight step when another step fails the run", async () => {
		h.host.handlers.onCodexCommand = (command, daemon) => {
			if ((command.kind === "start" || command.kind === "message") && command.prompt.includes("slow step")) {
				return (stockCodexResponder(command, daemon) ?? []).filter(
					(frame) => !(frame.type === "codex_event" && frame.kind === "terminal"),
				);
			}
			return stockCodexResponder(command, daemon);
		};
		const run = startRun(
			`export const meta = {}; const slow = agent("slow step"); await agent("fast step"); throw new Error("failed after fast step");`,
		);
		const record = await waitForStatus(run.runId, "failed");
		expect(record.failureReason).toContain("failed after fast step");
		const slowAgent = h.gateway.faults
			.workflowAgents(team)
			.find((agent) => agent.runId === run.runId && agent.state === "working");
		expect(slowAgent).toBeDefined();
		await waitFor(
			() =>
				h.host.codexCommands.find(
					(command) => command.kind === "interrupt" && command.agentId === slowAgent?.agentId,
				),
			"terminal step stop",
		);
		expect(
			h.host.codexCommands.filter(
				(command) => command.kind === "interrupt" && command.agentId === slowAgent?.agentId,
			),
		).toHaveLength(1);
	});

	it("retries a terminal run stop once on a replacement host socket", async () => {
		let stopAttempts = 0;
		h.host.handlers.onCodexCommand = (command, daemon) => {
			if (command.kind === "interrupt") {
				stopAttempts += 1;
				return stopAttempts === 1 ? [] : stockCodexResponder(command, daemon);
			}
			if ((command.kind === "start" || command.kind === "message") && command.prompt.includes("held stop")) {
				return (stockCodexResponder(command, daemon) ?? []).filter(
					(frame) => !(frame.type === "codex_event" && frame.kind === "terminal"),
				);
			}
			return stockCodexResponder(command, daemon);
		};
		const run = startRun(`export const meta = {}; await agent("held stop"); return true;`);
		const firstHost = h.host;
		await waitFor(() => firstHost.codexCommands.find((command) => command.kind === "start"), "stop test start");
		await waitFor(
			() =>
				h.gateway.faults
					.workflowAgents(team)
					.find((agent) => agent.runId === run.runId && agent.state === "working"),
			"stop test working agent",
		);
		expect(h.gateway.faults.workflowCancel(run.runId)).toBe(true);
		await waitForStatus(run.runId, "cancelled");
		await waitFor(
			() => firstHost.codexCommands.find((command) => command.kind === "interrupt"),
			"first terminal stop",
		);
		h.restartHost();
		const secondHost = h.host;
		await waitFor(
			() => secondHost.codexCommands.find((command) => command.kind === "interrupt"),
			"retried terminal stop",
		);
		expect(firstHost.codexCommands.filter((command) => command.kind === "interrupt")).toHaveLength(1);
		expect(secondHost.codexCommands.filter((command) => command.kind === "interrupt")).toHaveLength(1);
	});

	it("rejects a missing skill before dispatch", async () => {
		h.host.handlers.onCodexCommand = stockCodexResponder;
		const run = startRun(`export const meta = {}; await agent("read it", {skills: ["missing.md"]}); return true;`);
		await waitForStatus(run.runId, "succeeded");
		expect(h.gateway.faults.workflowRows(run.runId)).toContainEqual(
			expect.objectContaining({ kind: "settle", outcome: "rejected", reason: "skill missing.md: missing" }),
		);
	});

	it("gives one skill to steps that start together", async () => {
		h.host.handlers.onCodexCommand = stockCodexResponder;
		h.host.handlers.skillText = (path) => (path === "guide.md" ? "Read carefully." : undefined);
		const run = startRun(
			`export const meta = {}; const answers = await parallel(["one", "two", "three"].map((name) => () => agent(name, {skills: ["guide.md"]}))); return answers.filter(Boolean).length;`,
		);
		await waitForStatus(run.runId, "succeeded");
		expect(h.gateway.faults.workflowRecord(run.runId)?.result).toBe(3);
		const prompts = h.host.codexCommands.flatMap((command) => (command.kind === "start" ? [command.prompt] : []));
		expect(prompts.filter((prompt) => prompt.includes("Read carefully."))).toHaveLength(3);
	});

	it("sends one workflow notice chain and no step agent notices", async () => {
		const held: HeldTurn[] = [];
		h.host.handlers.onCodexCommand = (command, daemon) => {
			if (command.kind !== "start" && command.kind !== "message") return stockCodexResponder(command, daemon);
			const replies = stockCodexResponder(command, daemon) ?? [];
			const terminal = replies.find(
				(frame) => frame.type === "codex_event" && frame.kind === "terminal",
			) as unknown as Extract<CodexDaemonEvent, { kind: "terminal" }>;
			held.push({ daemon, terminal });
			return replies.filter((frame) => !(frame.type === "codex_event" && frame.kind === "terminal"));
		};
		const run = startRun(
			`export const meta = {}; await parallel([() => agent("one"), () => agent("two"), () => agent("three")]); return true;`,
		);
		await waitFor(() => (held.length === 3 ? held : undefined), "three working steps");
		const progressNotice = () =>
			session.inbound.find(
				(frame) =>
					JSON.stringify(frame.awareness ?? {}).includes(run.runId) &&
					JSON.stringify(frame.awareness ?? {}).includes("no_act"),
			);
		for (let attempt = 0; attempt < 5 && !progressNotice(); attempt += 1) await h.ambient.advance(1_000);
		await waitFor(() => progressNotice(), "workflow progress notice");
		const progress = session.inbound.filter((frame) => JSON.stringify(frame.awareness ?? {}).includes(run.runId));
		expect(progress).toHaveLength(1);
		expect(JSON.stringify(progress[0]?.awareness ?? {})).toContain("no_act");
		expect(JSON.stringify(progress[0]?.awareness ?? {})).not.toContain("Codex agent");
		for (const { daemon, terminal } of held) {
			const eventId = daemon.nextEventId(terminal.targetId);
			h.host.sendCodex({ ...terminal, eventId });
		}
		await waitForStatus(run.runId, "succeeded");
		const settleNotice = () =>
			session.inbound.find(
				(frame) =>
					JSON.stringify(frame.awareness ?? {}).includes(run.runId) &&
					JSON.stringify(frame.awareness ?? {}).includes("act_now"),
			);
		for (let attempt = 0; attempt < 65 && !settleNotice(); attempt += 1) await h.ambient.advance(1_000);
		await waitFor(() => settleNotice(), "workflow settle notice");
		const chain = session.inbound.filter((frame) => JSON.stringify(frame.awareness ?? {}).includes(run.runId));
		expect(chain).toHaveLength(2);
		expect(JSON.stringify(chain[1]?.awareness ?? {})).toContain("workflowCollect");
		expect(chain.some((frame) => JSON.stringify(frame.awareness ?? {}).includes("Codex agent"))).toBe(false);
		expect(h.gateway.faults.workflowRecord(run.runId)?.notified).toBe(true);
	});

	it("cancels before forget and reserves the session from the sweep", async () => {
		h.host.handlers.onCodexCommand = (command, daemon) => {
			if (command.kind === "interrupt") return stockCodexResponder(command, daemon);
			return (stockCodexResponder(command, daemon) ?? []).filter(
				(frame) => !(frame.type === "codex_event" && frame.kind === "terminal"),
			);
		};
		const run = startRun(`export const meta = {}; await agent("held until forgotten"); return true;`);
		const working = await waitFor(() => {
			const agents = h.gateway.faults.workflowAgents(team);
			if (agents.some((agent) => agent.runId === run.runId && agent.state === "working")) return { agents };
			const record = h.gateway.faults.workflowRecord(run.runId);
			return record?.status === "running" ? undefined : { agents, record };
		}, "forgotten step");
		expect(working.agents).toContainEqual(expect.objectContaining({ runId: run.runId, state: "working" }));
		expect(h.gateway.faults.sweepSessions(0)).not.toContain(team);
		expect(h.gateway.faults.sessionRecord(team)).toBeDefined();
		await h.phone.deliver(team, { kind: "forget", target: h.target(team) });
		await waitFor(() => h.gateway.faults.sessionRecord(team) === undefined || undefined, "forgotten session");
		await waitForStatus(run.runId, "cancelled");
		expect(h.gateway.faults.workflowRecord(run.runId)?.notified).toBe(true);
		expect(h.host.codexCommands.some((command) => command.kind === "interrupt")).toBe(true);
	});
});
