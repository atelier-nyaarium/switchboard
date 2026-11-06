import { describe, expect, it } from "vitest";
import { toCopilotListSource } from "../mcp/local/localAgentHost.js";
import {
	LOCAL_IDLE_REAP_MS,
	type LocalAgentAnswer,
	LocalAgentRuntime,
	type LocalBackendSpec,
	type LocalRefusal,
} from "../mcp/local/localAgentRuntime.js";
import type { LocalBackendSession, LocalTerminal } from "../mcp/local/localAgentSession.js";
import type { AgentBackendId } from "../shared/agent-backend.js";
import type { AgentNotice } from "../shared/agent-notice.js";
import { CodexListAgentsResultSchema } from "../shared/codexAgentCatalog.js";
import { CODEX_ACTIVITY_MAX_ITEMS } from "../shared/codexAgentIdentity.js";
import { CodexAgentResultSchema } from "../shared/codexAgentState.js";
import { CopilotAgentResultSchema, projectCopilotListResult } from "../shared/copilot-agent.js";

type PendingTurn = { settled: Promise<LocalTerminal>; resolve(value: LocalTerminal): void };

class ValueBackendAdapter implements LocalBackendSession {
	private readonly pending = new Map<string, PendingTurn>();
	private activity?: (turnId: string, text: string) => void;
	private closed?: () => void;
	private sequence = 0;
	openThreadGate?: Promise<void>;
	// Absent, like Copilot's session, when steering is unsupported.
	steerTurn?: (threadId: string, turnId: string, prompt: string) => Promise<void>;
	constructor(private readonly options: { openError?: Error; startError?: Error; steer?: boolean } = {}) {
		if (options.steer !== false) this.steerTurn = async () => {};
	}
	async openThread(): Promise<string> {
		if (this.openThreadGate) await this.openThreadGate;
		if (this.options.openError) throw this.options.openError;
		return "thread-1";
	}
	async startTurn(): Promise<{ turnId: string; settled: Promise<LocalTerminal> }> {
		if (this.options.startError) throw this.options.startError;
		const turnId = `turn-${++this.sequence}`;
		let resolve!: (value: LocalTerminal) => void;
		const settled = new Promise<LocalTerminal>((inner) => (resolve = inner));
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
		this.closed?.();
	}
	emitActivity(turnId: string, text: string): void {
		this.activity?.(turnId, text);
	}
	emitTerminal(turnId: string, terminal: LocalTerminal): void {
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
		openSession: async () => backend,
		defaultCwd: () => "/workspace/project",
		waitBudgetMs: 5,
		followupDelivery: backendId === "copilot" ? "followup" : "started",
		maxActivities: CODEX_ACTIVITY_MAX_ITEMS,
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

function answered(value: LocalAgentAnswer | LocalRefusal): LocalAgentAnswer {
	if ("refused" in value) throw new Error(value.refused);
	return value;
}

function publicList(backendId: AgentBackendId, runtime: LocalAgentRuntime) {
	return backendId === "codex"
		? CodexListAgentsResultSchema.parse({ agents: runtime.list() })
		: projectCopilotListResult(runtime.list().map(toCopilotListSource));
}

describe("local publication", () => {
	for (const backendId of ["codex", "copilot"] as const) {
		it(`${backendId} publishes awaited completion through its public schema`, async () => {
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
			const answer = await h.runtime.handle({ kind: "await", agentId: started.agentId });
			const listed = publicList(backendId, h.runtime);
			expect(
				(backendId === "codex" ? CodexAgentResultSchema : CopilotAgentResultSchema).parse(answer),
			).toMatchObject({ observation: "terminal", finalResponse: "done" });
			expect(listed.agents).toHaveLength(1);
			expect(listed.agents[0]?.turns).toHaveLength(1);
		});
	}

	it("returns acceptance immediately and notifies when the turn settles", async () => {
		const h = setup();
		const started = answered(await h.runtime.handle({ kind: "start", prompt: "first job" }));
		expect(started).toMatchObject({ observation: "accepted", turn: { state: "inProgress" } });
		expect(h.notices).toEqual([]);

		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		const result = answered(await h.runtime.handle({ kind: "await", agentId: started.agentId }));

		expect(result).toMatchObject({ observation: "terminal", finalResponse: "done" });
		expect(h.notices).toEqual([{ kind: "done", family: "codex", agentId: started.agentId, outcome: "completed" }]);
	});

	it("projects Copilot operations and rejects the unprojected runtime row", async () => {
		const h = setup("copilot");
		const pending = h.runtime.handle({ kind: "start", prompt: "first prompt" });
		const started = answered(await pending);
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "ok" });
		const settled = answered(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
		await h.runtime.handle({ kind: "message", agentId: started.agentId, prompt: "second prompt" });
		const raw = CopilotAgentResultSchema.safeParse({ agents: h.runtime.list() });
		expect(raw.success).toBe(false);
		expect(projectCopilotListResult(h.runtime.list().map(toCopilotListSource)).agents[0]?.operations).toEqual([
			{ kind: "start", state: "accepted", prompt: "first prompt" },
			{ kind: "message", state: "accepted", prompt: "second prompt" },
		]);
		h.backend.emitTerminal("turn-2", { status: "interrupted" });
		await h.runtime.handle({ kind: "await", agentId: settled.agentId });
	});

	it("returns normalized failures and interrupted terminals", async () => {
		const h = setup();
		const failed = h.runtime.handle({ kind: "start", prompt: "fail" });
		const failedStart = answered(await failed);
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "failed", error: "spawn failed\n at /x.js:1" });
		expect(await h.runtime.handle({ kind: "await", agentId: failedStart.agentId })).toMatchObject({
			observation: "terminal",
			turn: { state: "failed" },
			error: { code: "turn_failed" },
		});
		const interrupted = h.runtime.handle({ kind: "start", prompt: "interrupt" });
		const interruptedStart = answered(await interrupted);
		await turnReady(h.backend, "turn-2");
		h.backend.emitTerminal("turn-2", { status: "interrupted" });
		expect(await h.runtime.handle({ kind: "await", agentId: interruptedStart.agentId })).toMatchObject({
			observation: "terminal",
			turn: { state: "interrupted" },
		});
	});

	it("keeps only the newest activities and reports omission", async () => {
		const h = setup();
		const pending = h.runtime.handle({ kind: "start", prompt: "work" });
		const started = answered(await pending);
		await turnReady(h.backend);
		for (let index = 0; index <= CODEX_ACTIVITY_MAX_ITEMS; index += 1)
			h.backend.emitActivity("turn-1", `item-${index}`);
		const answer = answered(await h.runtime.handle({ kind: "await", agentId: started.agentId }));
		expect(answer.observation).toBe("waitTimedOut");
		expect(answer.activities[0]).toEqual({ kind: "commentary", text: "item-1" });
		expect(answer.activities.at(-2)).toEqual({
			kind: "commentary",
			text: `item-${CODEX_ACTIVITY_MAX_ITEMS}`,
		});
		expect(answer.activities.at(-1)).toEqual({ kind: "truncated", omitted: 1 });
		h.backend.emitTerminal("turn-1", { status: "interrupted" });
	});

	it("steers Codex and refuses a busy Copilot follow-up", async () => {
		const codex = setup();
		const first = codex.runtime.handle({ kind: "start", prompt: "begin" });
		const firstStart = answered(await first);
		await turnReady(codex.backend);
		codex.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await codex.runtime.handle({ kind: "await", agentId: firstStart.agentId });
		const followUp = codex.runtime.handle({
			kind: "message",
			agentId: firstStart.agentId,
			prompt: "follow up",
		});
		const followUpStart = answered(await followUp);
		await turnReady(codex.backend, "turn-2");
		codex.backend.emitTerminal("turn-2", { status: "completed", finalResponse: "again" });
		expect(await codex.runtime.handle({ kind: "await", agentId: followUpStart.agentId })).toMatchObject({
			observation: "terminal",
			finalResponse: "again",
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
		const completed = await Promise.all([
			h.runtime.handle({ kind: "await", agentId: firstStart.agentId }),
			h.runtime.handle({ kind: "await", agentId: secondStart.agentId }),
		]);
		expect(completed.map((answer) => answered(answer).turn?.state)).toEqual(["completed", "completed"]);
	});

	it("reaps only an idle resumable backend at the controlled timestamp", async () => {
		const h = setup();
		const pending = h.runtime.handle({ kind: "start", prompt: "work" });
		const started = answered(await pending);
		await turnReady(h.backend);
		h.backend.emitTerminal("turn-1", { status: "completed", finalResponse: "done" });
		await h.runtime.handle({ kind: "await", agentId: started.agentId });
		expect(h.runtime.reapIfIdle()).toBe(false);
		h.advance(LOCAL_IDLE_REAP_MS);
		expect(h.runtime.reapIfIdle()).toBe(true);
	});
});
