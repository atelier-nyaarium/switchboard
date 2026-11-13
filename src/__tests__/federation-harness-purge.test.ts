import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SWEEP_REST_MS } from "../gateway/purgeSweep.js";
import { SETTLED_RETENTION_MS } from "../gateway/workflows/runner.js";
import { AGENT_THREAD_TTL_MS } from "../shared/agent-collect.js";
import { AGENT_HOST_TARGET_ID } from "../shared/agent-execution-target.js";
import { VAULT_VALUE_KIND, vaultAadKind } from "../shared/content-envelope.js";
import type { HostPurgeOp } from "../shared/host-op.js";
import { PURGE_SWEEP_PATH, type SweepAnswer } from "../shared/schemasPurgeSweep.js";
import { ownSessionFiles } from "../shared/session-files.js";
import { composeSessionName } from "../shared/session-id.js";
import { attachFakeSession, type FakeSession } from "../testing/fakeSession.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

/** Launches, delegations and the queue's drain over one harness. */
function rig(harness: () => FederationHarness, sessions: FakeSession[]) {
	const launch = async (label: string, claudeSessionId = randomUUID()): Promise<FakeSession> => {
		const h = harness();
		h.host.handlers.onCreateSession = (op) => {
			sessions.push(
				attachFakeSession(h.gateway, {
					team: composeSessionName(op.target.name, op.target.sessionName),
					conversationId: `conv-${label.toLowerCase()}`,
					sessionToken: op.sessionToken,
					claudeSessionId,
				}),
			);
		};
		const before = sessions.length;
		await h.phone.value({ kind: "create_session", target: h.target("host"), displayLabel: label });
		const created = await h.waitFor(() => sessions[before], "the daemon's launch");
		await created.ready();
		return created;
	};
	const ask = async <T>(caller: FakeSession, body: Record<string, unknown>): Promise<T> =>
		(await (await caller.post("/codex", body)).json()) as T;
	/** One ended Codex turn, uncollected; answers the agent and its thread. */
	const start = async (caller: FakeSession): Promise<{ agentId: string; threadId: string }> => {
		const { agentId } = await ask<{ agentId: string }>(caller, {
			kind: "start",
			operationId: randomUUID(),
			prompt: "go",
		});
		await harness().waitFor(async () => {
			const listed = await ask<{ agents: Array<{ running: boolean }> }>(caller, { kind: "list", agentId });
			return listed.agents[0]?.running === false ? true : undefined;
		}, "the agent's turn to end");
		return { agentId, threadId: [...harness().agents.of("codex").threads].at(-1) as string };
	};
	const collect = (caller: FakeSession, agentId: string) =>
		ask<{ turns: unknown[]; error?: { code: string } }>(caller, { kind: "await", agentId });
	/** One collected Codex turn; answers its thread id. */
	const delegate = async (caller: FakeSession): Promise<string> => {
		const { agentId, threadId } = await start(caller);
		await collect(caller, agentId);
		return threadId;
	};
	const drained = () =>
		harness().waitFor(
			() => (harness().gateway.faults.purgeQueue().length === 0 ? true : undefined),
			"the purge to drain",
		);
	return { launch, ask, start, collect, delegate, drained };
}

const kinds = (ops: HostPurgeOp[]) => ops.map((op) => op.what.kind);

describe("what an ended session leaves at its place", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	const { launch, delegate, drained } = rig(() => h, sessions);
	let forgets = 0;
	/** The answer has no address left to land on, so the record's absence is the result. */
	const forget = async (session: FakeSession): Promise<void> => {
		forgets += 1;
		const sent = await h.phone.deliver(
			session.team,
			{ kind: "forget", target: h.target(session.team) },
			`forget-${forgets}`,
		);
		expect(sent.outcome).toBe("accepted");
		await h.waitFor(
			() => (h.gateway.faults.sessionRecord(session.team) === undefined ? true : undefined),
			"the record to go",
		);
	};

	// Every host the harness attaches fails its purges while set.
	let failing = false;

	beforeAll(async () => {
		h = await startFederationHarness({ host: { onPurge: () => (failing ? "fail" : undefined) } });
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		await h.close();
	});

	it("leaves no armed send and no read anchor at the Router for a forgotten session", async () => {
		const nia = await launch("Nia");
		// A neighbour's stream, which stays.
		const kept = { team: "host.neighbour" };
		const [domainId, gatewayId] = h.target(nia.team).split(".") as [string, string];
		const stream = (team: string) => h.target(team);
		const armed = (await h.phone.send({
			kind: "schedule_send",
			target: { domainId, gatewayId, sessionId: nia.team },
			fireAt: h.now() + 60 * 60_000,
			opId: randomUUID(),
			files: [],
			// The Router never opens it, so any sealed body serves.
			body: h.phone.seal("later", vaultAadKind(VAULT_VALUE_KIND, randomUUID())),
		})) as { outcome: string };
		expect(armed.outcome).toBe("accepted");
		for (const name of [stream(nia.team), `scheduled:${stream(nia.team)}`, stream(kept.team)]) {
			expect((await h.phone.reportRead(name, 1, 1)).status).toBe(200);
		}
		const anchors = async () =>
			((await h.phone.send({ kind: "read_anchors_read" })) as { anchors: Array<{ stream: string }> }).anchors.map(
				(anchor) => anchor.stream,
			);
		const sends = async () =>
			(await h.phone.send({ kind: "schedule_list" })) as Array<{ target: { sessionId: string }; state: string }>;
		expect(await anchors()).toHaveLength(3);

		await forget(nia);
		await h.waitFor(async () => ((await anchors()).length === 1 ? true : undefined), "the anchors to go");

		expect(await anchors()).toEqual([stream(kept.team)]);
		expect((await sends()).filter((send) => send.target.sessionId === nia.team)).toMatchObject([
			{ state: "cancelled" },
		]);
		// The Gateway's claim file for its address went with it.
		const claimed = fs
			.readdirSync(path.join(h.root, "gateway", "inbox-claims"))
			.map((file) => Buffer.from(file.slice("claim-".length, -".json".length), "base64url").toString());
		expect(claimed.filter((address) => address.endsWith(`/${nia.team}`))).toEqual([]);
	});

	it("deletes a forgotten session's conversation, own files and agent threads, behind its pane's close", async () => {
		const conversation = randomUUID();
		const alice = await launch("Alice", conversation);
		const threadId = await delegate(alice);
		const from = h.host.purges.length;
		const onDisk = [
			`.claude/projects/-home-fixture/${conversation}.jsonl`,
			`.claude/projects/-home-fixture/${conversation}/side.json`,
			...ownSessionFiles(alice.team),
		].map((file) => path.join(h.host.home, file));
		const kept = path.join(h.host.home, `.claude/projects/-home-fixture/${randomUUID()}.jsonl`);
		for (const file of [...onDisk, kept]) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "x");
		}

		await forget(alice);
		await drained();

		expect(onDisk.filter((file) => fs.existsSync(file))).toEqual([]);
		expect(fs.existsSync(kept)).toBe(true);

		const asked = h.host.purges.slice(from);
		expect(asked.map((op) => op.what)).toEqual([
			{ kind: "claude", conversationId: conversation },
			{ kind: "files", session: { kind: "host", name: "host", sessionName: alice.team.split(".")[1] } },
			{ kind: "thread", backend: "codex", threadId },
		]);
		expect(asked.map((op) => op.pane !== undefined)).toEqual([true, true, false]);
		expect(h.agents.of("codex").threads.has(threadId)).toBe(false);
	});

	it("ends a forgotten session without waiting on its pane's close", async () => {
		const silas = await launch("Silas");
		const from = h.host.purges.length;
		h.host.handlers.silentKills = true;

		await forget(silas);
		await drained();
		h.host.handlers.silentKills = false;

		expect(h.host.ops.some((op) => op.kind === "killSession")).toBe(true);
		expect(kinds(h.host.purges.slice(from))).toEqual(["claude", "files"]);
	});

	it("ends a record a failed wake adopted as it ends any other, with its pane and files", async () => {
		const from = h.host.purges.length;
		h.host.handlers.answerWake = () => "failed";
		const target = h.target("host.orphan1");

		await h.phone.deliver("host.orphan1", { kind: "wake", target, harness: "claude" }, "wake-orphan");
		await h.waitFor(() => (h.host.purges.length > from ? true : undefined), "the failed wake's purge");
		await drained();
		h.host.handlers.answerWake = undefined;

		expect(h.gateway.faults.sessionRecord("host.orphan1")).toBeUndefined();
		expect(h.host.purges.slice(from).map((op) => [op.what.kind, op.pane?.sessionName])).toEqual([
			["files", "orphan1"],
		]);
	});

	it("deletes a workflow step's thread when the step ends", async () => {
		const dana = await launch("Dana");
		const before = new Set(h.agents.of("codex").threads);
		const from = h.host.purges.length;
		const started = h.gateway.faults.workflowStart({
			team: dana.team,
			operationId: randomUUID(),
			resumeFrom: null,
			script: `export const meta = {}; await agent("once"); return { ok: true };`,
			args: {},
			defaultBackend: "codex",
			phases: [],
		});
		if (started.kind !== "started") throw new Error("workflow did not start");
		await h.waitFor(
			() => (h.gateway.faults.workflowRecord(started.run.runId)?.status === "succeeded" ? true : undefined),
			"the run to end",
		);
		await drained();

		expect(kinds(h.host.purges.slice(from))).toEqual(["thread"]);
		expect([...h.agents.of("codex").threads].filter((threadId) => !before.has(threadId))).toEqual([]);
		await forget(dana);
		await drained();
	});

	it("purges a swept session as it does a forgotten one", async () => {
		const bob = await launch("Bob");
		const threadId = await delegate(bob);
		bob.close();
		const from = h.host.purges.length;

		expect(h.gateway.faults.sweepSessions(-1)).toContain(bob.team);
		await drained();

		expect(kinds(h.host.purges.slice(from))).toEqual(["claude", "files", "thread"]);
		expect(h.agents.of("codex").threads.has(threadId)).toBe(false);
	});

	it("keeps what a failed delete left, across a Gateway restart, and deletes it once the daemon answers", async () => {
		const carol = await launch("Carol");
		failing = true;
		await forget(carol);
		await h.waitFor(
			() => (h.host.purges.some((op) => op.what.kind === "files") ? true : undefined),
			"the first try",
		);
		expect(h.gateway.faults.purgeQueue().map((entry) => entry.what.kind)).toEqual(["claude", "files"]);

		await h.restartGateway();
		expect(h.gateway.faults.purgeQueue().map((entry) => entry.what.kind)).toEqual(["claude", "files"]);

		failing = false;
		h.restartHost();
		await drained();
		expect(kinds(h.host.purges)).toEqual(["claude", "files"]);
	});
});

describe("what an agent leaves once its session is done with it", () => {
	let h: FederationHarness;
	let clock = Date.now();
	const sessions: FakeSession[] = [];
	const { launch, ask, start, collect, drained } = rig(() => h, sessions);
	const message = (caller: FakeSession, agentId: string) =>
		ask<{ error?: { code: string; retryable: boolean } }>(caller, {
			kind: "message",
			agentId,
			operationId: randomUUID(),
			prompt: "more",
		});
	const held = async (caller: FakeSession, agentId: string) =>
		(await ask<{ agents: unknown[] }>(caller, { kind: "list", agentId })).agents.length;
	const threads = () => h.agents.of("codex").threads;

	beforeAll(async () => {
		h = await startFederationHarness({ now: () => clock });
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		await h.close();
	});

	it("deletes a thread unused for a day, counting a collect as a use, and refuses a message to it as expired", async () => {
		const erin = await launch("Erin");
		const { agentId, threadId } = await start(erin);
		clock += AGENT_THREAD_TTL_MS - 60_000;
		await collect(erin, agentId);

		clock += 120_000;
		expect(h.gateway.faults.expireThreads()).toBe(0);
		expect(threads().has(threadId)).toBe(true);

		clock += AGENT_THREAD_TTL_MS;
		expect(h.gateway.faults.expireThreads()).toBe(1);
		await drained();

		expect(threads().has(threadId)).toBe(false);
		expect(await held(erin, agentId)).toBe(0);
		expect((await message(erin, agentId)).error).toMatchObject({ code: "expired", retryable: false });
	});

	it("keeps an uncollected answer after its thread went, and drops the record once collected", async () => {
		const finn = await launch("Finn");
		const { agentId, threadId } = await start(finn);

		clock += AGENT_THREAD_TTL_MS;
		expect(h.gateway.faults.expireThreads()).toBe(1);
		await drained();
		expect(threads().has(threadId)).toBe(false);
		expect((await message(finn, agentId)).error).toMatchObject({ code: "expired" });

		const answer = await collect(finn, agentId);
		expect(answer.turns).toHaveLength(1);
		expect(answer.error).toMatchObject({ code: "expired" });
		expect(h.gateway.faults.expireThreads()).toBe(1);
		expect(await held(finn, agentId)).toBe(0);
	});

	it("deletes an agent on request, stopping a turn that is still running", async () => {
		const gwen = await launch("Gwen");
		const idle = await start(gwen);
		expect(await ask(gwen, { kind: "delete", agentId: idle.agentId })).toEqual({
			agentId: idle.agentId,
			deleted: true,
		});
		expect(await ask(gwen, { kind: "delete", agentId: idle.agentId })).toMatchObject({ deleted: true });

		h.agents.of("codex").onTurn = () => {};
		const { agentId } = await ask<{ agentId: string }>(gwen, {
			kind: "start",
			operationId: randomUUID(),
			prompt: "stall",
		});
		const running = h.agents.of("codex").turns.at(-1)!;
		expect(await ask(gwen, { kind: "delete", agentId })).toEqual({ agentId, deleted: true });
		h.agents.of("codex").onTurn = undefined;
		await drained();

		expect(running.interrupts).toBe(1);
		expect(threads().has(idle.threadId)).toBe(false);
		expect(threads().has(running.threadId)).toBe(false);
	});

	const run = async (caller: FakeSession, script: string, resumeFrom: string | null = null): Promise<string> => {
		const started = h.gateway.faults.workflowStart({
			team: caller.team,
			operationId: randomUUID(),
			resumeFrom,
			script: `export const meta = {}; ${script} return { ok: true };`,
			args: {},
			defaultBackend: "codex",
			phases: [],
		});
		if (started.kind !== "started") throw new Error("workflow did not start");
		return started.run.runId;
	};
	const ended = (runId: string) =>
		h.waitFor(
			() => (h.gateway.faults.workflowRecord(runId)?.status === "running" ? undefined : true),
			"the run to end",
		);
	const runAgents = (caller: FakeSession) =>
		h.gateway.faults.workflowAgents(caller.team).flatMap((agent) => (agent.runId ? [agent.runId] : []));

	it("keeps a run's named thread past its end for a resume to reuse, and deletes it a day after its last use", async () => {
		const ivy = await launch("Ivy");
		const first = await run(ivy, `await agent("first", { thread: "kept" });`);
		await ended(first);
		await drained();
		const held = new Set(threads());
		expect(runAgents(ivy)).toEqual([first]);

		const second = await run(
			ivy,
			`await agent("first", { thread: "kept" }); await agent("second", { thread: "kept" });`,
			first,
		);
		await ended(second);
		expect(runAgents(ivy)).toEqual([second]);
		expect(new Set(threads())).toEqual(held);
		expect(h.gateway.faults.expireThreads()).toBe(0);

		clock += AGENT_THREAD_TTL_MS;
		expect(h.gateway.faults.expireThreads()).toBe(1);
		await drained();
		expect(runAgents(ivy)).toEqual([]);
		expect([...threads()].filter((threadId) => held.has(threadId))).toHaveLength(held.size - 1);
	});

	it("holds a resumed run's step for a named thread still ending its turn, then reuses that thread", async () => {
		const kira = await launch("Kira");
		const codex = h.agents.of("codex");
		const script = `await agent("first", { thread: "kept" }); await agent("second", { thread: "kept" });`;
		codex.onTurn = (turn) => {
			if (turn.prompt.includes("first")) turn.settle({ status: "completed", finalResponse: "one" });
		};
		// The stop is taken and the turn lingers.
		codex.onInterrupt = () => {};
		const first = await run(kira, script);
		const stalled = await h.waitFor(
			() => codex.turns.find((turn) => turn.prompt.includes("second") && turn.state() === "inProgress"),
			"the first run's second step",
		);
		expect(h.gateway.faults.workflowCancel(first)).toBe(true);
		await h.waitFor(() => (stalled.interrupts > 0 ? true : undefined), "the stop to reach the turn");
		const held = new Set(threads());
		const turns = codex.turns.length;

		const second = await run(kira, script, first);
		await h.waitFor(
			() =>
				h.gateway.faults.workflowRows(second).filter((row) => row.kind === "issue").length === 2
					? true
					: undefined,
			"the resumed run to reach its second step",
		);
		// No agent of its own was started for the step.
		expect(runAgents(kira)).toEqual([first]);
		expect(codex.turns.length).toBe(turns);
		expect(h.gateway.faults.workflowRecord(second)).toMatchObject({ status: "running", failureReason: null });

		codex.onTurn = undefined;
		codex.onInterrupt = undefined;
		stalled.settle({ status: "interrupted" });
		await ended(second);

		expect(h.gateway.faults.workflowRecord(second)?.status).toBe("succeeded");
		expect(codex.turns.at(-1)).toMatchObject({ threadId: stalled.threadId });
		expect(codex.turns.at(-1)?.prompt).toContain("second");
		expect(new Set(threads())).toEqual(held);
		expect(runAgents(kira)).toEqual([second]);
	});

	it("deletes a run on request with what its steps left, and not one a running run resumes from", async () => {
		const jade = await launch("Jade");
		const before = new Set(threads());
		const first = await run(jade, `await agent("first", { thread: "kept" });`);
		await ended(first);
		const remove = async (runId: string) =>
			(await (await jade.post("/workflow/delete", { runId })).json()) as { deleted?: boolean; error?: string };

		h.agents.of("codex").onTurn = () => {};
		const second = await run(jade, `await agent("first", { thread: "kept" }); await agent("held step");`, first);
		const stalled = await h.waitFor(
			() => h.agents.of("codex").turns.find((turn) => turn.prompt.includes("held step")),
			"the second run's live step",
		);
		expect((await remove(first)).error).toBeDefined();
		expect(h.gateway.faults.workflowRecord(first)).not.toBeNull();

		expect(await remove(second)).toMatchObject({ runId: second, deleted: false, note: expect.any(String) });
		h.agents.of("codex").onTurn = undefined;
		await h.waitFor(() => (runAgents(jade).length === 1 ? true : undefined), "the stopped step's agent to go");
		expect(stalled.interrupts).toBe(1);
		expect(h.gateway.faults.workflowSweep()).toBe(1);
		expect(await remove(first)).toEqual({ runId: first, deleted: true });
		expect(await remove(first)).toEqual({ runId: first, deleted: true });
		await drained();

		expect(h.gateway.faults.workflowRecord(first)).toBeNull();
		expect(h.gateway.faults.workflowRecord(second)).toBeNull();
		expect(runAgents(jade)).toEqual([]);
		expect([...threads()].filter((threadId) => !before.has(threadId))).toEqual([]);
	});

	it("leaves a workflow's agent to its run", async () => {
		const hugo = await launch("Hugo");
		h.agents.of("codex").onTurn = () => {};
		const started = h.gateway.faults.workflowStart({
			team: hugo.team,
			operationId: randomUUID(),
			resumeFrom: null,
			script: `export const meta = {}; await agent("once"); return { ok: true };`,
			args: {},
			defaultBackend: "codex",
			phases: [],
		});
		if (started.kind !== "started") throw new Error("workflow did not start");
		const step = await h.waitFor(
			() => h.gateway.faults.workflowAgents(hugo.team).find((agent) => agent.runId === started.run.runId),
			"the step's agent",
		);
		const turn = await h.waitFor(() => h.agents.of("codex").turns.at(-1), "the step's turn");

		expect(await ask(hugo, { kind: "delete", agentId: step.agentId })).toHaveProperty("error");
		expect(turn.interrupts).toBe(0);

		h.agents.of("codex").onTurn = undefined;
		turn.settle({ status: "completed", finalResponse: "done" });
		await h.waitFor(
			() => (h.gateway.faults.workflowRecord(started.run.runId)?.status === "succeeded" ? true : undefined),
			"the run to end",
		);
		await drained();
	});
});

describe("what a run's seven day removal still finds", () => {
	let h: FederationHarness;
	let clock = Date.now();
	const sessions: FakeSession[] = [];
	const { launch, drained } = rig(() => h, sessions);

	beforeAll(async () => {
		h = await startFederationHarness({ now: () => clock });
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		await h.close();
	});

	it("counts an agent a run still holds at its seven days, and nothing for a run deleted on request", async () => {
		const lena = await launch("Lena");
		const found = async () =>
			((await (await lena.get("/health")).json()) as { backstop: { found: number } }).backstop.found;
		const run = async (): Promise<string> => {
			const started = h.gateway.faults.workflowStart({
				team: lena.team,
				operationId: randomUUID(),
				resumeFrom: null,
				script: `export const meta = {}; await agent("first", { thread: "kept" }); return { ok: true };`,
				args: {},
				defaultBackend: "codex",
				phases: [],
			});
			if (started.kind !== "started") throw new Error("workflow did not start");
			await h.waitFor(
				() => (h.gateway.faults.workflowRecord(started.run.runId)?.status === "running" ? undefined : true),
				"the run to end",
			);
			return started.run.runId;
		};

		const asked = await run();
		expect(await (await lena.post("/workflow/delete", { runId: asked })).json()).toMatchObject({ deleted: true });
		expect(await found()).toBe(0);

		const aged = await run();
		clock += SETTLED_RETENTION_MS;
		expect(h.gateway.faults.workflowSweep()).toBe(1);
		await drained();

		expect(h.gateway.faults.workflowRecord(aged)).toBeNull();
		expect(await found()).toBe(1);
		expect(h.agents.of("codex").threads.size).toBe(0);
	});
});

describe("the one sweep", () => {
	let h: FederationHarness;
	const sessions: FakeSession[] = [];
	const { launch, start, collect, ask, drained } = rig(() => h, sessions);
	const sweep = async (body: Record<string, unknown>, token = h.set.tokens.host) => {
		const answered = await h.gateway.router(
			new Request(`http://gateway${PURGE_SWEEP_PATH}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		return { status: answered.status, body: (await answered.json()) as SweepAnswer };
	};

	beforeAll(async () => {
		h = await startFederationHarness();
	}, 30_000);
	afterAll(async () => {
		for (const attached of sessions) attached.close();
		await h.close();
	});

	it("lists a store through the daemon, deletes what no roster session names, and ends the agents it took from", async () => {
		const mia = await launch("Mia");
		const held = await start(mia);
		const codex = h.agents.of("codex");
		codex.plant("stray-old", AGENT_HOST_TARGET_ID, Date.now() - 2 * SWEEP_REST_MS);
		codex.plant("stray-fresh", AGENT_HOST_TARGET_ID, Date.now());

		expect((await sweep({}, "not the host's")).status).toBe(403);
		const shown = (await sweep({})).body;
		expect(shown.plan?.rows.find((row) => row.place === "host" && row.backend === "codex")).toEqual({
			place: "host",
			backend: "codex",
			listed: 3,
			kept: 0,
			running: 0,
			unreadable: 1,
			agents: 1,
			unnamed: 1,
		});
		expect([...codex.threads].sort()).toEqual(["stray-fresh", "stray-old", held.threadId].sort());

		const done = (await sweep({ apply: true, expect: shown.plan?.fingerprint })).body;
		await drained();

		expect(done).toMatchObject({ applied: true, ended: 1, queued: 1 });
		expect([...codex.threads]).toEqual(["stray-fresh"]);
		// Its answer was not collected, so the record stays without its thread.
		expect((await collect(mia, held.agentId)).turns).toHaveLength(1);
		expect(
			await ask<{ error?: { code: string } }>(mia, {
				kind: "message",
				agentId: held.agentId,
				operationId: randomUUID(),
				prompt: "more",
			}),
		).toMatchObject({ error: { code: "expired" } });
	});
});
