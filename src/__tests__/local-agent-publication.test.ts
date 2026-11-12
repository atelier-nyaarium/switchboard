import { describe, expect, it } from "vitest";
import type { AgentBackendSession, AgentModel, TurnHandle, TurnTerminal } from "../mcp/agents/backendSession.js";
import {
	LOCAL_IDLE_REAP_MS,
	type LocalAgentAnswer,
	LocalAgentRuntime,
	type LocalBackendSpec,
	type LocalCollectAnswer,
	type LocalRefusal,
} from "../mcp/local/localAgentRuntime.js";
import type { AgentBackendId } from "../shared/agent-backend.js";
import { agentListAnswer, agentListRow } from "../shared/agent-collect.js";
import type { AgentNotice } from "../shared/agent-notice.js";
import { AGENT_ACTIVITY_MAX_ITEMS } from "../shared/agent-record.js";

type PendingTurn = { settled: Promise<TurnTerminal>; resolve(value: TurnTerminal): void };

class ValueBackendAdapter implements AgentBackendSession {
	private readonly pending = new Map<string, PendingTurn>();
	private activity?: (turnId: string, text: string) => void;
	private closed?: () => void;
	private sequence = 0;
	private threads = 0;
	closes = 0;
	openThreadGate?: Promise<void>;
	// Absent, like Copilot's session, when steering is unsupported.
	steerTurn?: (threadId: string, turnId: string, prompt: string) => Promise<void>;
	inspectTurn?: AgentBackendSession["inspectTurn"];
	adoptTurn?: AgentBackendSession["adoptTurn"];
	resumeThread?: AgentBackendSession["resumeThread"];
	readonly resumed: Array<{ threadId: string; cwd: string }> = [];
	constructor(
		private readonly options: {
			openError?: Error;
			startError?: Error;
			steer?: boolean;
			/** Speaks of a turn before naming it. */
			early?: string;
			resume?: boolean;
		} = {},
	) {
		if (options.steer !== false) this.steerTurn = async () => {};
		if (options.resume)
			this.resumeThread = async (threadId, cwd) => {
				this.resumed.push({ threadId, cwd });
			};
	}
	async openThread(): Promise<string> {
		if (this.openThreadGate) await this.openThreadGate;
		if (this.options.openError) throw this.options.openError;
		return `thread-${++this.threads}`;
	}
	async startTurn(): Promise<TurnHandle> {
		if (this.options.startError) throw this.options.startError;
		const turnId = `turn-${++this.sequence}`;
		if (this.options.early) this.emitActivity(turnId, this.options.early);
		return this.running(turnId);
	}
	running(turnId: string): TurnHandle {
		let resolve!: (value: TurnTerminal) => void;
		const settled = new Promise<TurnTerminal>((inner) => (resolve = inner));
		this.pending.set(turnId, { settled, resolve });
		return { turnId, settled };
	}
	async interruptTurn(): Promise<void> {}
	onActivity(listener: (turnId: string, text: string) => void): void {
		this.activity = listener;
	}
	onClosed(listener: () => void): void {
		this.closed = listener;
	}
	close(): void {
		this.closes += 1;
		this.closed?.();
	}
	async listModels(): Promise<AgentModel[]> {
		return [{ id: "model-1" }];
	}
	emitActivity(turnId: string, text: string): void {
		this.activity?.(turnId, text);
	}
	emitTerminal(turnId: string, terminal: TurnTerminal): void {
		const turn = this.pending.get(turnId);
		if (!turn) throw new Error("unknown turn");
		turn.resolve(terminal);
	}
	hasTurn(turnId: string): boolean {
		return this.pending.has(turnId);
	}
}

function setup(
	backendId: AgentBackendId = "codex",
	options: ConstructorParameters<typeof ValueBackendAdapter>[0] = {},
) {
	let now = 1_000;
	const backend = new ValueBackendAdapter(options);
	const notices: AgentNotice[] = [];
	const spec: LocalBackendSpec = {
		backendId,
		displayName: backendId === "copilot" ? "Copilot" : "Codex",
		failureCode: (error) => (/login/.test(error) ? "authentication_required" : undefined),
		openSession: async () => backend,
		defaultCwd: () => "/workspace/project",
		maxActivities: AGENT_ACTIVITY_MAX_ITEMS,
		threadsResumable: backendId === "codex",
		replaysOperations: false,
		notify: (notice) => notices.push(notice),
		...(backendId === "copilot" ? { busyMessage: "busy" } : {}),
	};
	return {
		runtime: new LocalAgentRuntime(spec, () => now++),
		backend,
		notices,
		advance(ms: number) {
			now += ms;
		},
	};
}

async function turnReady(backend: ValueBackendAdapter, id = "turn-1"): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (backend.hasTurn(id)) return;
		await Promise.resolve();
	}
	throw new Error("turn did not start");
}

async function turnEnded(runtime: LocalAgentRuntime, agentId: string, id = "turn-1"): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const turn = runtime
			.list()
			.find((agent) => agent.agentId === agentId)
			?.turns.find((candidate) => candidate.id === id);
		if (turn && turn.state !== "inProgress") return;
		await Promise.resolve();
	}
	throw new Error("turn did not end");
}

function answered(value: LocalAgentAnswer | LocalCollectAnswer | LocalRefusal): LocalAgentAnswer {
	if ("refused" in value) throw new Error(value.refused);
	if ("running" in value) throw new Error("request did not return an agent answer");
	return value;
}

function collected(value: LocalAgentAnswer | LocalRefusal | LocalCollectAnswer): LocalCollectAnswer {
	if ("refused" in value) throw new Error(value.refused);
	if (!("running" in value)) throw new Error("await did not return a collect answer");
	return value;
}

function publicList(runtime: LocalAgentRuntime, backendId: "codex" | "copilot") {
	const agents = runtime.list();
	return agentListAnswer(agents, {}, (agent) =>
		agentListRow(agent, backendId, { model: agent.model, latestPrompt: agent.exchanges.at(-1)?.prompt }),
	);
}

describe("local publication", () => {
	for (const backendId of ["codex", "copilot"] as const) {
		it(`${backendId} publishes completion through collect and shared list shapes`, async () => {
			const h = setup(backendId);
			const pending = h.runtime.handle({ kind: "start", prompt: "first job" });
			const started = answered(await pending);
			expect(started).toMatchObject({
				observation: "accepted",
				agentState: "working",
				turn: { id: "turn-1", state: "inProgress" },
			});
			await turnReady(h.backend);
			h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
			await turnEnded(h.runtime, started.agentId);
			const listed = publicList(h.runtime, backendId);
			const answer = collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
			expect(answer).toMatchObject({
				agentId: started.agentId,
				agentState: "idle",
				running: null,
				turns: [{ id: "turn-1", state: "completed", finalResponse: "done" }],
			});
			expect(listed).toMatchObject({
				agents: [
					{
						agentId: started.agentId,
						backend: backendId,
						agentState: "idle",
						running: false,
						uncollected: 1,
						turnCount: 1,
						latestPromptFirstLine: "first job",
					},
				],
				omitted: 0,
			});
			expect(publicList(h.runtime, backendId)).toEqual({ agents: [], omitted: 0 });
		});
	}

	it("returns acceptance immediately and notifies when the turn settles", async () => {
		const h = setup();
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "first job" }));
		expect(started).toMatchObject({ observation: "accepted", turn: { state: "inProgress" } });
		expect(h.notices).toEqual([]);

		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await turnEnded(h.runtime, started.agentId);
		const result = collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }));

		expect(result).toMatchObject({
			agentId: started.agentId,
			agentState: "idle",
			running: null,
			turns: [{ id: "turn-1", state: "completed", finalResponse: "done" }],
		});
		expect(h.notices).toEqual([{ kind: "done", backend: "codex", agentId: started.agentId, outcome: "completed" }]);
	});

	it("projects local activity into the shared agent list row", async () => {
		const h = setup("copilot");
		const pending = h.runtime.handle({ kind: "start", prompt: "first prompt" });
		const started = answered(await pending);
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "ok" });
		await turnEnded(h.runtime, started.agentId);
		collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
		answered(await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "second prompt" }));
		await turnReady(h.backend, "turn-2");
		expect(publicList(h.runtime, "copilot")).toMatchObject({
			agents: [
				{
					agentId: started.agentId,
					agentState: "working",
					running: true,
					uncollected: 0,
					turnCount: 2,
					latestPromptFirstLine: "second prompt",
				},
			],
			omitted: 0,
		});
		h.backend.emitTerminal("turn-2", { status: "interrupted" });
		await turnEnded(h.runtime, started.agentId, "turn-2");
		expect(collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }))).toMatchObject({
			running: null,
			turns: [{ id: "turn-2", state: "interrupted" }],
		});
	});

	it("refuses a message and a second stop while an interrupt is pending", async () => {
		const h = setup();
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "first job" }));
		await turnReady(h.backend);
		const stopped = answered(await h.runtime.handle({ kind: "stop", agentId: started.agentId }));
		expect(stopped.observation).toBe("interruptRequested");
		expect(await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "more" })).toHaveProperty(
			"refused",
		);
		expect(await h.runtime.handle({ kind: "stop", agentId: started.agentId })).toHaveProperty("refused");

		h.backend.emitTerminal("turn-1", { status: "interrupted" });
		await turnEnded(h.runtime, started.agentId);
		const next = answered(await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "more" }));
		expect(next).toMatchObject({ observation: "accepted", turn: { id: "turn-2" } });
	});

	it("opens a new turn for a steer whose turn ended under it", async () => {
		const h = setup();
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "first job" }));
		await turnReady(h.backend);
		h.backend.steerTurn = async (_thread, turnId) => {
			h.backend.emitTerminal(turnId, { status: "completed", finalResponse: "first" });
			throw new Error("turn is no longer active");
		};
		const followed = answered(
			await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "more" }),
		);
		expect(followed).toMatchObject({ observation: "accepted", turn: { id: "turn-2", state: "inProgress" } });
		const answer = collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
		expect(answer).toMatchObject({ running: "turn-2", turns: [{ id: "turn-1", state: "completed" }] });
	});

	it("opens a new turn after a refused steer when its driver reads the turn as ended", async () => {
		const h = setup();
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "first job" }));
		await turnReady(h.backend);
		h.backend.steerTurn = async () => {
			throw new Error("turn is no longer active");
		};
		h.backend.inspectTurn = async () => ({
			known: "settled",
			terminal: { status: "completed", finalResponse: "first" },
		});
		const followed = answered(
			await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "more" }),
		);
		expect(followed).toMatchObject({ observation: "accepted", turn: { id: "turn-2", state: "inProgress" } });
		const answer = collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
		expect(answer).toMatchObject({
			running: "turn-2",
			turns: [{ id: "turn-1", state: "completed", finalResponse: "first" }],
		});
	});

	it("takes the turn its child started when the start's reply failed, and never one it already holds", async () => {
		const h = setup("codex", { startError: new Error("turn/start timed out") });
		h.backend.adoptTurn = async () => h.backend.running("turn-9");
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "first job" }));
		expect(started).toMatchObject({ observation: "accepted", turn: { id: "turn-9", state: "inProgress" } });

		h.backend.emitTerminal("turn-9", { status: "completed", finalResponse: "done" });
		await turnEnded(h.runtime, started.agentId, "turn-9");
		expect(collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }))).toMatchObject({
			turns: [{ id: "turn-9", state: "completed", finalResponse: "done" }],
		});

		const second = answered(await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "more" }));
		expect(second).toMatchObject({ observation: "unavailable" });
	});

	it("answers a start the child refuses with the driver's reading of why", async () => {
		const h = setup("copilot", { openError: new Error("Copilot login required") });
		const refused = answered(await h.runtime.handle({ kind: "start", prompt: "first job" }));
		expect(refused).toMatchObject({
			observation: "unavailable",
			error: { code: "authentication_required", retryable: true },
		});
	});

	it("returns normalized failures and interrupted terminals", async () => {
		const h = setup();
		const failed = h.runtime.handle({ kind: "start", prompt: "fail" });
		const failedStart = answered(await failed);
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "failed", error: "spawn failed\n at /x.js:1" });
		await turnEnded(h.runtime, failedStart.agentId);
		expect(collected(await h.runtime.handle({ kind: "await", agentId: failedStart.agentId }))).toMatchObject({
			agentState: "idle",
			running: null,
			turns: [{ id: "turn-1", state: "failed", error: expect.stringContaining("spawn failed") }],
		});
		const interrupted = h.runtime.handle({ kind: "start", prompt: "interrupt" });
		const interruptedStart = answered(await interrupted);
		await turnReady(h.backend, "turn-2");
		h.backend.emitTerminal("turn-2", { status: "interrupted" });
		await turnEnded(h.runtime, interruptedStart.agentId, "turn-2");
		expect(collected(await h.runtime.handle({ kind: "await", agentId: interruptedStart.agentId }))).toMatchObject({
			agentState: "idle",
			running: null,
			turns: [{ id: "turn-2", state: "interrupted" }],
		});
	});

	it("keeps only the newest activities and reports omission", async () => {
		const h = setup();
		const pending = h.runtime.handle({ kind: "start", prompt: "work" });
		const started = answered(await pending);
		await turnReady(h.backend);
		for (let index = 0; index <= AGENT_ACTIVITY_MAX_ITEMS; index += 1)
			h.backend.emitActivity("turn-1", `item-${index}`);
		const answer = collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
		expect(answer).toMatchObject({ agentId: started.agentId, agentState: "working", running: "turn-1", turns: [] });
		const activeTurn = h.runtime.list().find((agent) => agent.agentId === started.agentId)?.turns[0];
		expect(activeTurn?.activities[0]).toEqual({ kind: "commentary", text: "item-1" });
		expect(activeTurn?.activities.at(-2)).toEqual({
			kind: "commentary",
			text: `item-${AGENT_ACTIVITY_MAX_ITEMS}`,
		});
		expect(activeTurn?.activities.at(-1)).toEqual({ kind: "truncated", omitted: 1 });
		h.backend.emitTerminal("turn-1", { status: "interrupted" });
		await turnEnded(h.runtime, started.agentId);
		expect(collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }))).toMatchObject({
			running: null,
			turns: [{ id: "turn-1", state: "interrupted" }],
		});
	});

	it("steers Codex and refuses a busy Copilot follow-up", async () => {
		const codex = setup();
		const first = codex.runtime.handle({ kind: "start", prompt: "begin" });
		const firstStart = answered(await first);
		await turnReady(codex.backend);
		codex.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await turnEnded(codex.runtime, firstStart.agentId);
		collected(await codex.runtime.handle({ kind: "await", agentId: firstStart.agentId }));
		const followUp = codex.runtime.handle({
			kind: "message",
			agentId: firstStart.agentId,
			prompt: "follow up",
		});
		const followUpStart = answered(await followUp);
		await turnReady(codex.backend, "turn-2");
		codex.backend.emitTerminal("turn-2", { status: "completed", finalResponse: "again" });
		await turnEnded(codex.runtime, followUpStart.agentId, "turn-2");
		expect(collected(await codex.runtime.handle({ kind: "await", agentId: followUpStart.agentId }))).toMatchObject({
			running: null,
			turns: [{ id: "turn-2", state: "completed", finalResponse: "again" }],
		});

		const copilot = setup("copilot", { steer: false });
		const busy = copilot.runtime.handle({ kind: "start", prompt: "begin" });
		const busyStart = answered(await busy);
		await turnReady(copilot.backend);
		const id = busyStart.agentId;
		expect(await copilot.runtime.handle({ kind: "message", agentId: id, prompt: "again" })).toEqual({
			refused: "busy",
		});
		copilot.backend.emitTerminal("turn-1", { status: "interrupted" });
		await turnEnded(copilot.runtime, id);
		collected(await copilot.runtime.handle({ kind: "await", agentId: id }));
	});

	it("answers unknown agents without opening a backend", async () => {
		const h = setup();
		expect(await h.runtime.handle({ kind: "await", agentId: "codex_unknown" })).toMatchObject({
			error: { code: "not_found" },
		});
		expect(h.runtime.list()).toEqual([]);
	});

	it("shares opening across concurrent starts and reopens after close", async () => {
		const h = setup();
		const first = h.runtime.handle({ kind: "start", prompt: "one" });
		const second = h.runtime.handle({ kind: "start", prompt: "two" });
		const [firstStart, secondStart] = (await Promise.all([first, second])).map(answered);
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "one" });
		h.backend.emitTerminal("turn-2", { status: "completed", finalResponse: "two" });
		await turnEnded(h.runtime, firstStart.agentId);
		await turnEnded(h.runtime, secondStart.agentId, "turn-2");
		const completed = await Promise.all([
			h.runtime.handle({ kind: "await", agentId: firstStart.agentId }),
			h.runtime.handle({ kind: "await", agentId: secondStart.agentId }),
		]);
		expect(completed.map(collected)).toMatchObject([
			{ agentState: "idle", running: null, turns: [{ id: "turn-1", state: "completed" }] },
			{ agentState: "idle", running: null, turns: [{ id: "turn-2", state: "completed" }] },
		]);
	});

	it("ends a child that a model listing opened and no agent uses", async () => {
		const h = setup("copilot");
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "work" }));
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await turnEnded(h.runtime, started.agentId);
		// Its record outlives its child.
		h.backend.close();
		const closes = h.backend.closes;

		expect(await h.runtime.listModels()).toEqual(["model-1"]);

		expect(h.backend.closes).toBe(closes + 1);
	});

	it("keeps what a child said of a turn before the turn was named", async () => {
		const h = setup("codex", { early: "thinking" });

		const started = answered(await h.runtime.handle({ kind: "start", prompt: "work" }));

		expect(started.activities).toEqual([{ kind: "commentary", text: "thinking" }]);
	});

	it("resumes an agent's thread on the child that replaces a reaped one", async () => {
		const h = setup("codex", { resume: true });
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "work", cwd: "/workspace/app" }));
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await turnEnded(h.runtime, started.agentId);
		h.advance(LOCAL_IDLE_REAP_MS);
		expect(h.runtime.reapIfIdle()).toBe(true);

		const followed = answered(
			await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "more" }),
		);

		expect(followed).toMatchObject({ observation: "accepted", turn: { id: "turn-2" } });
		expect(h.backend.resumed).toEqual([{ threadId: "thread-1", cwd: "/workspace/app" }]);
	});

	it("says an agent ended with its process when its thread cannot be resumed", async () => {
		const h = setup();
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "work" }));
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await turnEnded(h.runtime, started.agentId);
		h.advance(LOCAL_IDLE_REAP_MS);
		h.runtime.reapIfIdle();

		const followed = answered(
			await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "more" }),
		);

		expect(followed).toMatchObject({
			observation: "unavailable",
			error: { message: "Codex agent ended with its process" },
		});
	});

	it("ends as lost the turns a child was running when it closed", async () => {
		const h = setup();
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "work" }));
		await turnReady(h.backend);

		h.backend.close();

		const agent = h.runtime.list().find((candidate) => candidate.agentId === started.agentId);
		expect(agent).toMatchObject({ agentState: "idle", turns: [{ id: "turn-1", state: "interrupted" }] });
	});

	it("reaps only an idle resumable backend at the controlled timestamp", async () => {
		const h = setup();
		const pending = h.runtime.handle({ kind: "start", prompt: "work" });
		const started = answered(await pending);
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await turnEnded(h.runtime, started.agentId);
		collected(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
		expect(h.runtime.reapIfIdle()).toBe(false);
		h.advance(LOCAL_IDLE_REAP_MS);
		expect(h.runtime.reapIfIdle()).toBe(true);
	});
});
