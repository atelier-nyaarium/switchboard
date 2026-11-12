import crypto from "node:crypto";
import { collectAnswer } from "../../shared/agent-collect.js";
import { emptyAgentProgressCounts } from "../../shared/agent-counter.js";
import { AGENT_PROGRESS_EVERY_MS } from "../../shared/agent-notice.js";
import {
	AGENT_ERROR_MAX_BYTES,
	AGENT_TURN_LOST_REASON,
	agentIdForOperation,
	sanitizeAgentErrorText,
} from "../../shared/agent-record.js";
import { agentResultDelivery, type AgentServiceTier as CodexServiceTier } from "../../shared/agent-state.js";
import { type AgentTurnMarks, collectTurns } from "../../shared/agent-turn-marks.js";
import type { AgentBackendSession, TurnOptions, TurnTerminal } from "../agents/backendSession.js";
import { type MessageOutcome, TurnRunner } from "../agents/turnRunner.js";
import type {
	LocalAgentAnswer,
	LocalAgentState,
	LocalBackendSpec,
	LocalCollectAnswer,
	LocalErrorCode,
	LocalListAgent,
	LocalRefusal,
	LocalRequest,
	LocalTurnState,
} from "./localAgentRuntime.js";

export interface LocalHandlerHost {
	spec: LocalBackendSpec;
	now(): number;
	open(): Promise<AgentBackendSession>;
	/** Ends a child past saving. */
	drop(session: AgentBackendSession): void;
	markUsed(at?: number): void;
}

interface LocalTurnRecord {
	id: string;
	state: LocalTurnState;
	commentary: string[];
	omitted: number;
	finalResponse?: string;
	error?: string;
	updatedAt: number;
}

export interface LocalExchangeRecord {
	kind: "start" | "message";
	prompt: string;
	status: "accepted";
	delivery: string;
	turnId: string;
	createdAt: number;
	acceptedAt: number;
}

interface LocalAgentRecord {
	agentId: string;
	threadId: string;
	/** Where its thread is resumed. */
	cwd: string;
	createdAt: number;
	updatedAt: number;
	activeTurnId?: string;
	/** The turn a stop was sent for. */
	interruptingTurnId?: string;
	serviceTier?: CodexServiceTier;
	model?: string;
	turns: LocalTurnRecord[];
	turnMarks: AgentTurnMarks;
	exchanges: LocalExchangeRecord[];
	progress?: ReturnType<typeof setInterval>;
}

const WATCH_EVERY_MS = 30_000;

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeAgentErrorText(text, AGENT_ERROR_MAX_BYTES) || `agent command failed`;
}

export class LocalAgentHandlers {
	private readonly agents = new Map<string, LocalAgentRecord>();
	/** One runner per child, made before its first turn, with its silent-turn sweep. */
	private readonly runners = new WeakMap<
		AgentBackendSession,
		{ runner: TurnRunner<LocalAgentRecord>; sweep: ReturnType<typeof setInterval> }
	>();

	constructor(private readonly host: LocalHandlerHost) {}

	list(): LocalListAgent[] {
		return [...this.agents.values()].map((agent) => ({
			agentId: agent.agentId,
			agentState: this.stateOf(agent),
			...(agent.model === undefined ? {} : { model: agent.model }),
			...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
			exchanges: agent.exchanges.map((exchange) => ({ ...exchange })),
			turns: agent.turns.map((turn) => ({
				id: turn.id,
				state: turn.state,
				activities: this.activitiesOf(turn),
				...(turn.state === "completed" ? { finalResponse: turn.finalResponse ?? "" } : {}),
				...(turn.state === "failed" ? { error: turn.error ?? `turn failed` } : {}),
				updatedAt: turn.updatedAt,
			})),
			turnMarks: agent.turnMarks,
			createdAt: agent.createdAt,
			updatedAt: agent.updatedAt,
		}));
	}

	hasActiveTurn(): boolean {
		for (const agent of this.agents.values()) {
			if (agent.activeTurnId) return true;
		}
		return false;
	}

	async start(request: LocalRequest): Promise<LocalAgentAnswer> {
		// Preserve a caller-supplied operation identity for agent derivation.
		const operationId = request.operationId ?? crypto.randomUUID();
		const agentId = agentIdForOperation(this.host.spec.backendId, operationId);
		const prompt = request.prompt ?? "";

		let session: AgentBackendSession;
		try {
			session = await this.host.open();
		} catch (error) {
			return this.unavailable(agentId, error);
		}
		const runner = this.runnerOf(session);

		const createdAt = this.host.now();
		const cwd = request.cwd ?? this.host.spec.defaultCwd();
		let threadId: string;
		try {
			threadId = await session.openThread({
				cwd,
				model: request.model,
				serviceTier: request.serviceTier,
				reasoningEffort: request.reasoningEffort,
			});
		} catch (error) {
			return this.unavailable(agentId, error);
		}

		const agent: LocalAgentRecord = {
			agentId,
			threadId,
			cwd,
			createdAt,
			updatedAt: createdAt,
			...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
			...(request.model === undefined ? {} : { model: request.model }),
			turns: [],
			turnMarks: { collected: [], notified: [] },
			exchanges: [],
		};
		this.agents.set(agentId, agent);
		runner.remember(threadId, agent);
		const settings: TurnOptions = { outputSchema: request.outputSchema, key: operationId };
		let turnId: string;
		try {
			turnId = await runner.begin(threadId, agent, prompt, settings, (opened) =>
				this.openTurn(agent, opened, prompt, "start"),
			);
		} catch (error) {
			return this.unavailable(agentId, error);
		}
		return this.acceptedAnswer(agent, turnId, this.startedDelivery("start"));
	}

	async message(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const prompt = request.prompt ?? "";
		let session: AgentBackendSession;
		try {
			session = await this.host.open();
		} catch (error) {
			return this.unavailable(agent.agentId, error);
		}

		const active = this.activeTurn(agent);
		if (active && agent.interruptingTurnId === active.id)
			return { refused: `agent cannot accept a message while interrupting` };
		const serviceTier = request.serviceTier ?? agent.serviceTier;
		let outcome: MessageOutcome;
		try {
			outcome = await this.runnerOf(session).message(
				agent.threadId,
				agent,
				prompt,
				{
					expectedTurnId: agent.activeTurnId,
					cwd: agent.cwd,
					model: agent.model,
					serviceTier,
					outputSchema: request.outputSchema,
					// One key for the steer and the turn it may fall back to: one prompt.
					key: request.operationId ?? crypto.randomUUID(),
				},
				(accepted) => {
					if (accepted.kind === "started") return this.openTurn(agent, accepted.turnId, prompt, "message");
					const at = this.touch(agent);
					agent.exchanges.push({
						kind: "message",
						prompt,
						status: "accepted",
						delivery: "steered",
						turnId: accepted.turnId,
						createdAt: at,
						acceptedAt: at,
					});
				},
			);
		} catch (error) {
			return this.unavailable(agent.agentId, error);
		}
		if (outcome.kind === "busy") return { refused: this.host.spec.busyMessage ?? `agent is still working` };
		if (outcome.kind === "ended")
			return this.unavailable(agent.agentId, `${this.host.spec.displayName} agent ended with its process`);
		if (outcome.kind === "steered") {
			if (request.serviceTier !== undefined) agent.serviceTier = request.serviceTier;
			return this.acceptedAnswer(agent, outcome.turnId, "steered");
		}
		if (serviceTier !== undefined) agent.serviceTier = serviceTier;
		return this.acceptedAnswer(agent, outcome.turnId, this.startedDelivery("message"));
	}

	/** Returns uncollected ended turns. */
	collect(request: LocalRequest): LocalAgentAnswer | LocalCollectAnswer {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const view = {
			agentId: agent.agentId,
			agentState: this.stateOf(agent),
			turns: agent.turns,
			turnMarks: agent.turnMarks,
			updatedAt: agent.updatedAt,
		};
		const taken = collectTurns(view, request.operationId);
		if (taken.marks) agent.turnMarks = taken.marks;
		return collectAnswer(view, taken.turnIds, (turn) => ({
			id: turn.id,
			state: turn.state,
			activities: this.activitiesOf(turn),
			...(turn.state === "completed" ? { finalResponse: turn.finalResponse ?? "" } : {}),
			...(turn.state === "failed" ? { error: turn.error ?? `turn failed` } : {}),
		}));
	}

	async stop(request: LocalRequest): Promise<LocalAgentAnswer | LocalRefusal> {
		const agent = this.agents.get(request.agentId ?? "");
		if (!agent) return this.notFound(request.agentId ?? "");
		const active = this.activeTurn(agent);
		if (!active) return this.idleAnswer(agent);
		if (agent.interruptingTurnId === active.id) return { refused: `an interrupt is already pending` };

		let session: AgentBackendSession;
		try {
			session = await this.host.open();
		} catch (error) {
			return this.unavailable(agent.agentId, error);
		}
		agent.interruptingTurnId = active.id;
		const forget = () => {
			if (agent.interruptingTurnId === active.id) agent.interruptingTurnId = undefined;
		};
		try {
			if (!(await this.runnerOf(session).interrupt(agent.threadId, active.id))) {
				forget();
				return this.unavailable(agent.agentId, `${this.host.spec.displayName} turn is no longer active`);
			}
		} catch (error) {
			forget();
			return this.unavailable(agent.agentId, error);
		}
		return {
			agentId: agent.agentId,
			agentState: "working",
			observation: "interruptRequested",
			turn: { id: active.id, state: "inProgress" },
			activities: this.activitiesOf(active),
		};
	}

	/** A child that closed: the turns it still ran are lost. */
	closed(session: AgentBackendSession): void {
		const held = this.runners.get(session);
		if (!held) return;
		this.runners.delete(session);
		clearInterval(held.sweep);
		const lost = held.runner.activeTurns();
		held.runner.clear();
		for (const turn of lost)
			this.applyTerminal(turn.owner, turn.turnId, { status: "interrupted", reason: AGENT_TURN_LOST_REASON });
	}

	/** The child's runner, which takes its activity from then on. */
	private runnerOf(session: AgentBackendSession): TurnRunner<LocalAgentRecord> {
		const known = this.runners.get(session);
		if (known) return known.runner;
		const runner = new TurnRunner<LocalAgentRecord>(session, {
			now: () => this.host.now(),
			terminal: (turn, terminal) => this.applyTerminal(turn.owner, turn.turnId, terminal),
			activity: (turn, text) => this.recordActivity(turn.owner, turn.turnId, text),
			counter: () => {},
			giveUp: (silent) => {
				console.error(
					`[${this.host.spec.backendId}-local] dropping its child: ${silent.threadId} made no progress on ${silent.turnId}`,
				);
				this.host.drop(session);
			},
			log: (line) => console.error(`[${this.host.spec.backendId}-local] ${line}`),
		});
		const sweep = setInterval(
			() => void runner.watch(() => this.runners.get(session)?.runner === runner),
			WATCH_EVERY_MS,
		);
		sweep.unref?.();
		this.runners.set(session, { runner, sweep });
		return runner;
	}

	private recordActivity(agent: LocalAgentRecord, turnId: string, text: string): void {
		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (turn?.state !== "inProgress") return;
		turn.commentary.push(text);
		while (turn.commentary.length > this.host.spec.maxActivities) {
			turn.commentary.shift();
			turn.omitted += 1;
		}
		turn.updatedAt = this.host.now();
		agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
	}

	private startedDelivery(kind: "start" | "message"): string {
		return agentResultDelivery(kind, "started") ?? "started";
	}

	/** Records a turn the moment it is known, ahead of anything its child said of it. */
	private openTurn(agent: LocalAgentRecord, turnId: string, prompt: string, kind: "start" | "message"): void {
		const at = this.touch(agent);
		const turn: LocalTurnRecord = { id: turnId, state: "inProgress", commentary: [], omitted: 0, updatedAt: at };
		agent.turns.push(turn);
		agent.activeTurnId = turn.id;
		agent.exchanges.push({
			kind,
			prompt,
			status: "accepted",
			delivery: this.startedDelivery(kind),
			turnId: turn.id,
			createdAt: at,
			acceptedAt: at,
		});
		this.watchProgress(agent, turn);
	}

	/** The turn as taken, without waiting on it; a completion notice follows. */
	private acceptedAnswer(agent: LocalAgentRecord, turnId: string, delivery: string): LocalAgentAnswer {
		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (!turn) return this.notFound(agent.agentId);
		if (turn.state !== "inProgress") return this.terminalAnswer(agent, turn, delivery);
		return {
			agentId: agent.agentId,
			agentState: "working",
			observation: "accepted",
			turn: { id: turn.id, state: "inProgress" },
			delivery,
			activities: this.activitiesOf(turn),
		};
	}

	private watchProgress(agent: LocalAgentRecord, turn: LocalTurnRecord): void {
		const notify = this.host.spec.notify;
		if (!notify) return;
		const since = this.host.now();
		if (agent.progress) clearInterval(agent.progress);
		agent.progress = setInterval(() => {
			if (turn.state !== "inProgress") return;
			notify({
				kind: "progress",
				family: this.host.spec.backendId,
				agentId: agent.agentId,
				minutes: Math.round((this.host.now() - since) / 60_000),
				notes: [...turn.commentary],
				counts: emptyAgentProgressCounts(),
			});
		}, this.host.spec.progressEveryMs ?? AGENT_PROGRESS_EVERY_MS);
		agent.progress.unref?.();
	}

	private applyTerminal(agent: LocalAgentRecord, turnId: string, terminal: TurnTerminal): void {
		const turn = agent.turns.find((candidate) => candidate.id === turnId);
		if (turn?.state !== "inProgress") return;
		turn.state = terminal.status;
		if (terminal.status === "completed") turn.finalResponse = terminal.finalResponse ?? "";
		// Normalize child errors before schema validation.
		if (terminal.status === "failed") turn.error = errorText(terminal.error || `turn failed`);
		turn.updatedAt = this.host.now();
		if (agent.interruptingTurnId === turnId) agent.interruptingTurnId = undefined;
		if (agent.activeTurnId === turnId) {
			agent.activeTurnId = undefined;
			if (agent.progress) clearInterval(agent.progress);
			agent.progress = undefined;
		}
		agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
		this.host.markUsed(turn.updatedAt);
		this.host.spec.notify?.({
			kind: "done",
			family: this.host.spec.backendId,
			agentId: agent.agentId,
			outcome: turn.state,
		});
	}

	private activitiesOf(turn: LocalTurnRecord): LocalAgentAnswer["activities"] {
		// Keep the truncation marker with the full activity window.
		const kept = turn.commentary.map((text) => ({ kind: "commentary" as const, text }));
		if (turn.omitted === 0) return kept;
		return [...kept, { kind: "truncated" as const, omitted: turn.omitted }];
	}

	private terminalAnswer(agent: LocalAgentRecord, turn: LocalTurnRecord, delivery?: string): LocalAgentAnswer {
		const base: LocalAgentAnswer = {
			agentId: agent.agentId,
			agentState: "idle",
			observation: "terminal",
			turn: { id: turn.id, state: turn.state },
			...(delivery ? { delivery } : {}),
			activities: this.activitiesOf(turn),
		};
		if (turn.state === "completed") return { ...base, finalResponse: turn.finalResponse ?? "" };
		if (turn.state === "failed") {
			return {
				...base,
				error: { code: "turn_failed", message: turn.error || `turn failed`, retryable: false },
			};
		}
		return base;
	}

	private idleAnswer(agent: LocalAgentRecord): LocalAgentAnswer {
		return { agentId: agent.agentId, agentState: "idle", observation: "idle", activities: [] };
	}

	private notFound(agentId: string): LocalAgentAnswer {
		return this.fail(agentId, "not_found", `${this.host.spec.displayName} agent was not found`, false);
	}

	private unavailable(agentId: string, error: unknown): LocalAgentAnswer {
		const text = errorText(error);
		return this.fail(agentId, this.host.spec.failureCode?.(text) ?? "app_server_unavailable", text, true);
	}

	private fail(agentId: string, code: LocalErrorCode, message: string, retryable: boolean): LocalAgentAnswer {
		return {
			agentId,
			agentState: "unavailable",
			observation: "unavailable",
			activities: [],
			error: { code, message, retryable },
		};
	}

	private activeTurn(agent: LocalAgentRecord): LocalTurnRecord | undefined {
		if (!agent.activeTurnId) return undefined;
		const turn = agent.turns.find((candidate) => candidate.id === agent.activeTurnId);
		return turn?.state === "inProgress" ? turn : undefined;
	}

	private stateOf(agent: LocalAgentRecord): LocalAgentState {
		return this.activeTurn(agent) ? "working" : "idle";
	}

	private touch(agent: LocalAgentRecord): number {
		const at = this.host.now();
		agent.updatedAt = Math.max(agent.updatedAt, at);
		this.host.markUsed(at);
		return agent.updatedAt;
	}
}
