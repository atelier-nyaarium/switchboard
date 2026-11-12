import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDaemonEvent, AgentDaemonReceipt } from "../shared/agent-wire.js";
import { composeSessionName } from "../shared/session-id.js";
import { type AgentResponder, stockAgentResponder } from "../testing/fakeHost.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

interface AgentAnswer {
	agentId: string;
	agentState: string;
	observation?: string;
	running?: string | null;
	turns?: Array<{
		id: string;
		state: string;
		reason?: string;
		delivery?: string;
		activities: Array<{ text?: string }>;
		finalResponse?: string;
		error?: string;
	}>;
	turn?: { id: string; state: string };
	finalResponse?: string;
	activities?: Array<{ text?: string }>;
	error?: { code: string };
}

describe("Codex delegation through the gateway and the daemon", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	const operationId = () => randomUUID();
	/** The only caller the route admits. */
	const launch = async (label: string): Promise<FakeSession> => {
		h.host.handlers.onCreateSession = (op) => {
			sessions.push(
				attachFakeSession(h.gateway, {
					team: composeSessionName(op.target.name, op.target.sessionName),
					conversationId: `conv-${label.toLowerCase()}`,
					sessionToken: op.sessionToken,
				}),
			);
		};
		const before = sessions.length;
		const { result } = await h.phone.value({
			kind: "create_session",
			target: h.target("host"),
			displayLabel: label,
		});
		expect(result).toMatchObject({ created: true });
		const created = await h.waitFor(() => sessions[before], "the daemon's launch");
		await created.ready();
		return created;
	};
	const codex = async (caller: FakeSession, body: Record<string, unknown>): Promise<AgentAnswer> => {
		const response = await caller.post("/codex", body);
		return (await response.json()) as AgentAnswer;
	};
	const collectUntilTurn = (caller: FakeSession, agentId: string): Promise<AgentAnswer> =>
		h.waitFor(
			async () => {
				const answer = await codex(caller, { kind: "await", agentId });
				return answer.turns?.length ? answer : undefined;
			},
			`an ended turn for ${agentId}`,
			10_000,
		);
	let alice: FakeSession;
	let carol: FakeSession;

	beforeAll(async () => {
		h = await startFederationHarness();
		alice = await launch("Alice");
		carol = await launch("Carol");
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		if (h) await h.close();
	});

	it("accepts a host start, then collects the completed turn", async () => {
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "count to three" });
		expect(started).toMatchObject({
			agentState: "working",
			observation: "accepted",
			turn: { state: "inProgress" },
			delivery: "started",
		});
		const completed = await collectUntilTurn(alice, started.agentId);
		expect(completed.turns).toMatchObject([{ state: "completed", finalResponse: "done: count to three" }]);
		expect(completed.turns?.[0]?.activities.map((activity) => activity.text)).toContain("working");
		const command = h.host.agentCommands("codex").find((candidate) => candidate.kind === "start");
		expect(command).toMatchObject({ target: { kind: "host" }, prompt: "count to three", agentId: started.agentId });
	});

	it("accepts follow-ups and replays them without a second turn", async () => {
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "first" });
		const followUp = operationId();
		const accepted = await codex(alice, {
			kind: "message",
			operationId: followUp,
			agentId: started.agentId,
			prompt: "second",
		});
		expect(accepted).toMatchObject({
			observation: "accepted",
			turn: { state: "inProgress" },
			delivery: "followup",
		});
		const answered = await collectUntilTurn(alice, started.agentId);
		expect(answered.turns).toMatchObject([
			{ state: "completed", finalResponse: "done: first" },
			{ state: "completed", finalResponse: "done: second" },
		]);
		const thread = h.host.agentCommands("codex").find((c) => c.kind === "message" && c.agentId === started.agentId);
		expect(thread).toMatchObject({ sessionId: `session-${started.agentId}` });

		const again = await codex(alice, {
			kind: "message",
			operationId: followUp,
			agentId: started.agentId,
			prompt: "second",
		});
		expect(again).toMatchObject({
			observation: "terminal",
			turn: { state: "completed" },
			finalResponse: "done: second",
		});
		expect(again.turn?.id).toBe(answered.turns?.at(-1)?.id);
		expect(
			h.host.agentCommands("codex").filter((c) => c.kind === "message" && c.operationId === followUp),
		).toHaveLength(1);
	});

	it("lists an owner's agents to that owner alone", async () => {
		const mine = await codex(alice, { kind: "start", operationId: operationId(), prompt: "mine" });
		const listed = (await (await alice.post("/codex", { kind: "list" })).json()) as {
			agents: Array<{ agentId: string }>;
		};
		expect(listed.agents.map((agent) => agent.agentId)).toContain(mine.agentId);
		const theirs = (await (await carol.post("/codex", { kind: "list" })).json()) as {
			agents: Array<{ agentId: string }>;
		};
		expect(theirs.agents.map((agent) => agent.agentId)).not.toContain(mine.agentId);
		const peek = await codex(carol, { kind: "await", agentId: mine.agentId });
		expect(peek).toMatchObject({ agentState: "unavailable", error: { code: "not_found" } });
	});

	it("refuses a caller with no session binding", async () => {
		const loose = attachFakeSession(h.gateway, { team: "fixture-app.loose", conversationId: "conv-loose" });
		sessions.push(loose);
		await loose.ready();
		const response = await loose.post("/codex", { kind: "start", operationId: operationId(), prompt: "no" });
		expect(response.status).toBe(401);
	});

	it("interrupts a running turn and collects its terminal result", async () => {
		const running: AgentResponder = (command, daemon, backend) => {
			if (backend !== "codex") return stockAgentResponder(command, daemon, backend);
			if (command.kind === "start") return stockAgentResponder(command, daemon, backend)?.slice(0, 2);
			if (command.kind === "interrupt") {
				const base = {
					ownerKey: command.ownerKey,
					daemonInstanceId: daemon.daemonInstanceId,
					agentId: command.agentId,
				};
				const fence = { targetId: command.target.targetId, generation: daemon.generation };
				return [
					{
						type: "codex_receipt",
						requestId: command.requestId,
						...base,
						...fence,
						eventId: daemon.nextEventId(fence.targetId),
						kind: "interruptResult",
						operationId: command.operationId,
						sessionId: command.sessionId,
						turnId: command.turnId,
						ok: true,
					},
					{
						type: "codex_event",
						...base,
						...fence,
						eventId: daemon.nextEventId(fence.targetId),
						sessionId: command.sessionId,
						kind: "terminal",
						turnId: command.turnId,
						state: "interrupted",
					},
				];
			}
			return stockAgentResponder(command, daemon, backend);
		};
		h.host.handlers.onAgentCommand = running;
		try {
			const startId = operationId();
			const starting = codex(alice, { kind: "start", operationId: startId, prompt: "long task" });
			const working = await h.waitFor(async () => {
				const listed = (await (await alice.post("/codex", { kind: "list" })).json()) as {
					agents: Array<{ agentId: string; agentState: string; running: boolean }>;
				};
				return listed.agents.find((agent) => agent.agentState === "working" && agent.running);
			}, "an accepted turn in progress");
			const teams = (await (await alice.get("/teams")).json()) as Array<{ team: string; teammates?: boolean }>;
			expect(teams.find((row) => row.team === alice.team)?.teammates).toBe(true);
			const inProgress = await codex(alice, { kind: "await", agentId: working.agentId });
			expect(inProgress).toMatchObject({ running: expect.any(String), turns: [] });
			const stopped = await codex(alice, { kind: "stop", operationId: operationId(), agentId: working.agentId });
			expect(stopped.agentId, JSON.stringify(stopped)).toBe(working.agentId);
			const started = await starting;
			expect(started).toMatchObject({ observation: "accepted", turn: { state: "inProgress" } });
			expect(inProgress.running).toBe(started.turn?.id);
			const interrupted = await collectUntilTurn(alice, working.agentId);
			expect(interrupted.turns).toMatchObject([{ state: "interrupted" }]);
			expect(h.host.agentCommands("codex").find((c) => c.kind === "interrupt")).toMatchObject({
				agentId: working.agentId,
			});
		} finally {
			h.host.handlers.onAgentCommand = undefined;
		}
	});

	it("keeps one turn when the daemon replays its reliable frames", async () => {
		const replayed: Array<AgentDaemonEvent | AgentDaemonReceipt> = [];
		h.host.handlers.onAgentCommand = (command, daemon, backend) => {
			if (backend !== "codex") return stockAgentResponder(command, daemon, backend);
			const frames = stockAgentResponder(command, daemon, backend) ?? [];
			if (command.kind === "start") replayed.push(...(frames as Array<AgentDaemonEvent | AgentDaemonReceipt>));
			return frames;
		};
		try {
			const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "replay me" });
			for (const frame of replayed) h.host.sendAgent("codex", frame);
			const listed = (await (await alice.post("/codex", { kind: "list" })).json()) as {
				agents: Array<{ agentId: string; uncollected: number; turnCount: number }>;
			};
			const agent = listed.agents.find((candidate) => candidate.agentId === started.agentId);
			expect(agent).toMatchObject({ uncollected: 1, turnCount: 1 });
			expect(await collectUntilTurn(alice, started.agentId)).toMatchObject({
				turns: [{ id: started.turn?.id, state: "completed" }],
			});
		} finally {
			h.host.handlers.onAgentCommand = undefined;
		}
	});

	it("survives a gateway restart and collects a new message", async () => {
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "before restart" });
		await h.restartGateway();
		const reattached = attachFakeSession(h.gateway, {
			team: alice.team,
			conversationId: alice.conversationId,
			sessionToken: alice.sessionToken,
		});
		sessions.push(reattached);
		expect(await reattached.registered()).toMatchObject({ type: "register_ok" });
		await reattached.ready();
		alice = reattached;
		const listed = await h.waitFor(async () => {
			const answer = (await (
				await reattached.post("/codex", { kind: "list", agentId: started.agentId })
			).json()) as {
				agents?: Array<{ agentId: string }>;
			};
			return answer.agents?.some((agent) => agent.agentId === started.agentId) ? answer : undefined;
		}, "the agent after restart");
		expect(listed.agents?.map((agent) => agent.agentId)).toContain(started.agentId);
		const accepted = await codex(reattached, {
			kind: "message",
			operationId: operationId(),
			agentId: started.agentId,
			prompt: "after restart",
		});
		expect(accepted).toMatchObject({ observation: "accepted", turn: { state: "inProgress" } });
		const collected = await collectUntilTurn(reattached, started.agentId);
		expect(collected.turns?.at(-1)).toMatchObject({ state: "completed", finalResponse: "done: after restart" });
	});

	it("after a daemon restart, collects the agent's first message on the new daemon", async () => {
		const caller = alice;
		const started = await codex(caller, {
			kind: "start",
			operationId: operationId(),
			prompt: "before daemon restart",
		});
		h.restartHost({ newDaemon: true });
		// New turn follows reconciliation.
		const first = await codex(caller, {
			kind: "message",
			operationId: operationId(),
			agentId: started.agentId,
			prompt: "who are you now?",
		});
		expect(first).toMatchObject({ delivery: "followup" });
		const ended: NonNullable<AgentAnswer["turns"]> = [];
		await h.waitFor(async () => {
			ended.push(...((await codex(caller, { kind: "await", agentId: started.agentId })).turns ?? []));
			return ended.some((turn) => turn.finalResponse === "done: who are you now?") || undefined;
		}, "the follow-up's answer");
		expect(ended.at(-1)).toMatchObject({ state: "completed", finalResponse: "done: who are you now?" });
	});

	it("abandons an old daemon's pending start before the new host catalog", async () => {
		h.host.handlers.onAgentCommand = (command, daemon, backend) =>
			backend === "codex" ? undefined : stockAgentResponder(command, daemon, backend);
		try {
			const startId = operationId();
			const starting = codex(alice, { kind: "start", operationId: startId, prompt: "hold for restart" });
			await h.waitFor(
				() =>
					h.host
						.agentCommands("codex")
						.find((command) => "operationId" in command && command.operationId === startId) || undefined,
				"start dispatch on the first daemon",
			);
			const firstDaemonId = h.host.daemon.daemonInstanceId;
			h.restartHost({ newDaemon: true });
			const secondHost = h.host;

			expect(secondHost.daemon.daemonInstanceId).not.toBe(firstDaemonId);
			expect(await starting).toMatchObject({ agentState: "unavailable", observation: "indeterminate" });
			expect(
				secondHost
					.agentCommands("codex")
					.filter((command) => "operationId" in command && command.operationId === startId),
			).toHaveLength(0);
		} finally {
			h.host.handlers.onAgentCommand = undefined;
		}
	});

	it("collects a Codex turn lost when its daemon restarts", async () => {
		h.host.handlers.onAgentCommand = (command, daemon, backend) => {
			if (backend !== "codex") return stockAgentResponder(command, daemon, backend);
			const frames = stockAgentResponder(command, daemon, backend) ?? [];
			return command.kind === "start" ? frames.slice(0, 1) : frames;
		};
		try {
			const started = await codex(alice, {
				kind: "start",
				operationId: operationId(),
				prompt: "keep running",
			});
			expect(started).toMatchObject({ agentState: "working", turn: { state: "inProgress" } });
			h.restartHost({ newDaemon: true });
			const collected = await collectUntilTurn(alice, started.agentId);
			expect(collected.turns).toMatchObject([
				{ state: "interrupted", reason: "turn lost: its agent process ended" },
			]);
		} finally {
			h.host.handlers.onAgentCommand = undefined;
		}
	});

	it("clears an accepted stop when its turn is lost and accepts a later message", async () => {
		h.host.handlers.onAgentCommand = (command, daemon, backend) => {
			if (backend !== "codex") return stockAgentResponder(command, daemon, backend);
			if (command.kind === "start") return (stockAgentResponder(command, daemon, backend) ?? []).slice(0, 1);
			if (command.kind === "interrupt") {
				const targetId = command.target.targetId;
				return [
					{
						type: "codex_receipt",
						kind: "interruptResult",
						requestId: command.requestId,
						ownerKey: command.ownerKey,
						daemonInstanceId: daemon.daemonInstanceId,
						targetId,
						generation: daemon.generation,
						eventId: daemon.nextEventId(targetId),
						agentId: command.agentId,
						operationId: command.operationId,
						sessionId: command.sessionId,
						turnId: command.turnId,
						ok: true,
					},
				];
			}
			return stockAgentResponder(command, daemon, backend);
		};
		try {
			const caller = alice;
			const started = await codex(caller, {
				kind: "start",
				operationId: operationId(),
				prompt: "wait for stop",
			});
			const stopped = await codex(caller, {
				kind: "stop",
				operationId: operationId(),
				agentId: started.agentId,
			});
			expect(stopped).toMatchObject({ observation: "interruptRequested" });
			h.restartHost({ newDaemon: true });
			const lost = await collectUntilTurn(caller, started.agentId);
			expect(lost.turns).toMatchObject([{ state: "interrupted" }]);
			const messageId = operationId();
			const next = await codex(caller, {
				kind: "message",
				operationId: messageId,
				agentId: started.agentId,
				prompt: "continue after restart",
			});
			expect(next).toMatchObject({ observation: "accepted", turn: { state: "inProgress" } });
			const collected = await collectUntilTurn(caller, started.agentId);
			expect(collected.turns?.at(-1)).toMatchObject({
				state: "completed",
				finalResponse: "done: continue after restart",
			});
		} finally {
			h.host.handlers.onAgentCommand = undefined;
		}
	});

	it("resends lost start, message, and stop answers once per operation", async () => {
		const answers = new Map<string, AgentDaemonReceipt[]>();
		const takes = new Map<string, number>();
		const responder: AgentResponder = (command, daemon, backend) => {
			if (backend !== "codex") return stockAgentResponder(command, daemon, backend);
			if (command.kind === "reconcile") return stockAgentResponder(command, daemon, backend);
			const previous = answers.get(command.operationId);
			if (previous) return previous;
			takes.set(command.operationId, (takes.get(command.operationId) ?? 0) + 1);
			const resolvedTarget = command.kind === "start" ? daemon.resolve(command.target) : command.target;
			const sessionId = command.kind === "start" ? `session-${command.agentId}` : command.sessionId;
			const turnId =
				command.kind === "interrupt"
					? command.turnId
					: command.kind === "message" && command.expectedTurnId
						? command.expectedTurnId
						: `turn-${command.operationId}`;
			const common = {
				type: "codex_receipt" as const,
				requestId: command.requestId,
				ownerKey: command.ownerKey,
				daemonInstanceId: daemon.daemonInstanceId,
				targetId: resolvedTarget.targetId,
				generation: daemon.generation,
				eventId: daemon.nextEventId(resolvedTarget.targetId),
				agentId: command.agentId,
			};
			const answer: AgentDaemonReceipt =
				command.kind === "interrupt"
					? {
							...common,
							kind: "interruptResult",
							operationId: command.operationId,
							sessionId: command.sessionId,
							turnId,
							ok: true,
						}
					: {
							...common,
							kind: "accepted",
							operationId: command.operationId,
							resolvedTarget,
							sessionId,
							turnId,
							delivery: command.kind === "start" ? "started" : "steered",
						};
			answers.set(command.operationId, [answer]);
			return undefined;
		};
		h.host.handlers.onAgentCommand = responder;
		try {
			const startId = operationId();
			const starting = codex(alice, { kind: "start", operationId: startId, prompt: "start once" });
			await h.waitFor(
				() =>
					h.host
						.agentCommands("codex")
						.some((command) => "operationId" in command && command.operationId === startId) || undefined,
				"first start dispatch",
			);
			const firstHost = h.host;
			h.restartHost();
			const secondHost = h.host;
			const started = await starting;
			expect(started).toMatchObject({ observation: "accepted", turn: { state: "inProgress" } });
			expect(
				secondHost
					.agentCommands("codex")
					.filter((command) => "operationId" in command && command.operationId === startId),
			).toHaveLength(1);

			const messageId = operationId();
			const messaging = codex(alice, {
				kind: "message",
				operationId: messageId,
				agentId: started.agentId,
				prompt: "message once",
			});
			await h.waitFor(
				() =>
					secondHost
						.agentCommands("codex")
						.some((command) => "operationId" in command && command.operationId === messageId) || undefined,
				"first message dispatch",
			);
			h.restartHost();
			const thirdHost = h.host;
			const messaged = await messaging;
			expect(messaged).toMatchObject({ observation: "accepted", turn: { state: "inProgress" } });
			expect(
				thirdHost
					.agentCommands("codex")
					.filter((command) => "operationId" in command && command.operationId === messageId),
			).toHaveLength(1);

			const stopId = operationId();
			const stopped = await codex(alice, { kind: "stop", operationId: stopId, agentId: started.agentId });
			expect(stopped).toMatchObject({ observation: "interruptRequested" });
			await h.waitFor(
				() =>
					thirdHost
						.agentCommands("codex")
						.some((command) => "operationId" in command && command.operationId === stopId) || undefined,
				"first stop dispatch",
			);
			h.restartHost();
			const fourthHost = h.host;
			await h.waitFor(
				() =>
					fourthHost
						.agentCommands("codex")
						.some((command) => "operationId" in command && command.operationId === stopId) || undefined,
				"resent stop dispatch",
			);
			expect(
				fourthHost
					.agentCommands("codex")
					.filter((command) => "operationId" in command && command.operationId === stopId),
			).toHaveLength(1);
			expect(takes).toEqual(
				new Map([
					[startId, 1],
					[messageId, 1],
					[stopId, 1],
				]),
			);
			expect(
				firstHost
					.agentCommands("codex")
					.filter((command) => "operationId" in command && command.operationId === startId),
			).toHaveLength(1);
		} finally {
			h.host.handlers.onAgentCommand = undefined;
		}
	});
});
