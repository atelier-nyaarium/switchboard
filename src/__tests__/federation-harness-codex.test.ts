import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeHost } from "../testing/fakeHost.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";
import type { ScriptedTurn } from "../testing/scriptedAgents.js";

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
	const backend = () => h.agents.of("codex");
	/** Leaves turn running. */
	const running = (turn: ScriptedTurn): void => turn.activity("working");
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
		const [first, second] = backend().turns.filter((turn) => ["first", "second"].includes(turn.prompt));
		expect(second?.threadId).toBe(first?.threadId);

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
		backend().onTurn = running;
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
			backend().onTurn = undefined;
		}
	});

	it("keeps one turn when the daemon replays frames whose acknowledgements were lost", async () => {
		h.host.handlers.loseAgentAcks = true;
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "replay me" });
		await h.waitFor(async () => {
			const listed = (await (await alice.post("/codex", { kind: "list" })).json()) as {
				agents: Array<{ agentId: string; uncollected: number }>;
			};
			return listed.agents.some((agent) => agent.agentId === started.agentId && agent.uncollected === 1);
		}, "the turn's end on the first link");

		h.restartHost();
		// Commentary is transient.
		const replayed = h.host.daemonFrames.filter((frame) => frame.turnId === started.turn?.id);
		expect(replayed.map((frame) => frame.kind)).toEqual(["accepted", "terminal"]);
		const listed = (await (await alice.post("/codex", { kind: "list" })).json()) as {
			agents: Array<{ agentId: string; uncollected: number; turnCount: number }>;
		};
		expect(listed.agents.find((agent) => agent.agentId === started.agentId)).toMatchObject({
			uncollected: 1,
			turnCount: 1,
		});
		expect(await collectUntilTurn(alice, started.agentId)).toMatchObject({
			turns: [{ id: started.turn?.id, state: "completed" }],
		});

		// Ack clears replay buffers.
		const ended = Number(replayed.at(-1)?.eventId);
		await h.waitFor(
			() => h.host.frames.some((frame) => frame.type === "codex_ack" && Number(frame.throughEventId) >= ended),
			"the repeated acknowledgement",
		);
		h.restartHost();
		expect(h.host.daemonFrames.filter((frame) => frame.turnId === started.turn?.id)).toEqual([]);
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

	it("abandons an old daemon's unanswered start, and never sends it to the new daemon", async () => {
		h.host.handlers.loseAgentFrames = true;
		const startId = operationId();
		const starting = codex(alice, { kind: "start", operationId: startId, prompt: "hold for restart" });
		await h.waitFor(
			() => backend().turns.some((turn) => turn.prompt === "hold for restart") || undefined,
			"the start on the first daemon",
		);
		const firstDaemonId = h.host.daemonInstanceId;
		h.restartHost({ newDaemon: true });
		const secondHost = h.host;

		expect(secondHost.daemonInstanceId).not.toBe(firstDaemonId);
		expect(await starting).toMatchObject({ agentState: "unavailable", observation: "indeterminate" });
		expect(
			secondHost
				.agentCommands("codex")
				.filter((command) => "operationId" in command && command.operationId === startId),
		).toHaveLength(0);
	});

	it("collects a Codex turn lost when its daemon restarts", async () => {
		backend().onTurn = running;
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
			backend().onTurn = undefined;
		}
	});

	it("ends a running turn when its child exits, and runs the next message on a fresh child", async () => {
		backend().onTurn = running;
		const launches = backend().launches;
		try {
			const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "crash under me" });
			expect(started).toMatchObject({ agentState: "working", turn: { state: "inProgress" } });
			h.agents.exitChild("codex");
			const lost = await collectUntilTurn(alice, started.agentId);
			expect(lost.turns).toMatchObject([{ id: started.turn?.id, state: "interrupted" }]);

			h.agents.skip(5_000);
			backend().onTurn = undefined;
			const next = await codex(alice, {
				kind: "message",
				operationId: operationId(),
				agentId: started.agentId,
				prompt: "on the new child",
			});
			expect(next).toMatchObject({ delivery: "followup" });
			const collected = await collectUntilTurn(alice, started.agentId);
			expect(collected.turns?.at(-1)).toMatchObject({
				state: "completed",
				finalResponse: "done: on the new child",
			});
			expect(backend().launches).toBe(launches + 1);
		} finally {
			backend().onTurn = undefined;
		}
	});

	it("clears an accepted stop when its turn is lost and accepts a later message", async () => {
		backend().onTurn = running;
		backend().onInterrupt = () => {};
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
			backend().onTurn = undefined;
			const next = await codex(caller, {
				kind: "message",
				operationId: operationId(),
				agentId: started.agentId,
				prompt: "continue after restart",
			});
			expect(next).toMatchObject({ delivery: "followup" });
			const collected = await collectUntilTurn(caller, started.agentId);
			expect(collected.turns?.at(-1)).toMatchObject({
				state: "completed",
				finalResponse: "done: continue after restart",
			});
		} finally {
			backend().onTurn = undefined;
			backend().onInterrupt = undefined;
		}
	});

	it("runs a start, a message and a stop once each when the link loses their answers", async () => {
		backend().onTurn = running;
		try {
			h.host.handlers.loseAgentFrames = true;
			const starting = codex(alice, { kind: "start", operationId: operationId(), prompt: "start once" });
			const turn = await h.waitFor(
				() => backend().turns.find((held) => held.prompt === "start once"),
				"the start on the daemon",
			);
			h.restartHost();
			const started = await starting;
			expect(started).toMatchObject({ observation: "accepted", turn: { id: turn.turnId, state: "inProgress" } });

			h.host.handlers.loseAgentFrames = true;
			const messaging = codex(alice, {
				kind: "message",
				operationId: operationId(),
				agentId: started.agentId,
				prompt: "message once",
			});
			await h.waitFor(() => turn.steers.length > 0 || undefined, "the message on the daemon");
			h.restartHost();
			expect(await messaging).toMatchObject({ turn: { id: turn.turnId }, delivery: "steered" });

			h.host.handlers.loseAgentFrames = true;
			const stopped = await codex(alice, { kind: "stop", operationId: operationId(), agentId: started.agentId });
			expect(stopped).toMatchObject({ observation: "interruptRequested" });
			await h.waitFor(() => turn.interrupts > 0 || undefined, "the stop on the daemon");
			h.restartHost();
			const collected = await collectUntilTurn(alice, started.agentId);
			expect(collected.turns).toMatchObject([{ id: turn.turnId, state: "interrupted" }]);

			// Replay resends are idempotent.
			expect(backend().turns.filter((held) => held.prompt === "start once")).toHaveLength(1);
			expect(turn.steers).toEqual(["message once"]);
			expect(turn.interrupts).toBe(1);
		} finally {
			backend().onTurn = undefined;
		}
	});

	it("answers a refused start from the daemon's own record when the link lost the refusal", async () => {
		const startId = operationId();
		const turns = backend().turns.length;
		backend().startError = new Error("model is not offered");
		h.host.handlers.loseAgentFrames = true;
		const starting = codex(alice, { kind: "start", operationId: startId, prompt: "refuse me once" });
		await h.waitFor(() => backend().startError === undefined || undefined, "the refused start on the daemon");

		// Gateway retries refusals.
		h.restartHost();

		expect(await starting).toMatchObject({ agentState: "unavailable" });
		const resent = h.host
			.agentCommands("codex")
			.filter((command) => "operationId" in command && command.operationId === startId);
		expect(resent).toHaveLength(1);
		expect(backend().turns).toHaveLength(turns);
	});

	it("drops an agent frame that arrives on a host socket another has replaced", async () => {
		const started = await codex(alice, { kind: "start", operationId: operationId(), prompt: "before a new host" });
		await collectUntilTurn(alice, started.agentId);
		const first = h.host;
		const ended = first.daemonFrames.findLast(
			(frame) => frame.turnId === started.turn?.id && frame.kind === "terminal",
		);
		if (!ended) throw new Error("the turn's terminal never crossed the link");
		// The Gateway has not heard the first link close.
		first.vanish();
		const second = attachFakeHost(h.gateway, { token: h.set.tokens.host });
		try {
			const acknowledged = () =>
				second.frames.filter(
					(frame) => frame.type === "codex_ack" && frame.daemonInstanceId === first.daemonInstanceId,
				);

			// Frames apply in arrival order, so the live socket's answer follows the replaced one's.
			first.sendFrame(ended);
			second.sendFrame(ended);
			await h.waitFor(() => acknowledged().length > 0 || undefined, "the live socket's acknowledgement");

			expect(acknowledged()).toHaveLength(1);
		} finally {
			second.close();
			h.restartHost();
		}
	});
});
