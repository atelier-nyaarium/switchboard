import crypto from "node:crypto";
import { collectAnswer } from "../../shared/agent-collect.js";
import { emptyAgentProgressCounts } from "../../shared/agent-counter.js";
import { AGENT_PROGRESS_EVERY_MS } from "../../shared/agent-notice.js";
import { AGENT_ERROR_MAX_BYTES, agentIdForOperation, sanitizeAgentErrorText } from "../../shared/agent-record.js";
import { agentResultDelivery, type AgentServiceTier as CodexServiceTier } from "../../shared/agent-state.js";
import { type AgentTurnMarks, collectTurns } from "../../shared/agent-turn-marks.js";
import {
	type AgentBackendSession,
	settledNow,
	type TurnHandle,
	type TurnOptions,
	type TurnTerminal,
} from "../agents/backendSession.js";
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
	settled?: Promise<TurnTerminal>;
	progress?: ReturnType<typeof setInterval>;
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return sanitizeAgentErrorText(text, AGENT_ERROR_MAX_BYTES) || `agent command failed`;
}

export class LocalAgentHandlers {
	private readonly agents = new Map<string, LocalAgentRecord>();

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

		const createdAt = this.host.now();
		let threadId: string;
		try {
			threadId = await session.openThread({
				cwd: request.cwd ?? this.host.spec.defaultCwd(),
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
			createdAt,
			updatedAt: createdAt,
			...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
			...(request.model === undefined ? {} : { model: request.model }),
			turns: [],
			turnMarks: { collected: [], notified: [] },
			exchanges: [],
		};
		this.agents.set(agentId, agent);
		return this.dispatchTurn(session, agent, prompt, "start", {
			outputSchema: request.outputSchema,
			key: operationId,
		});
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

		// One key for the steer and the turn it may fall back to: one prompt.
		const key = request.operationId ?? crypto.randomUUID();
		const active = this.activeTurn(agent);
		if (active) {
			if (agent.interruptingTurnId === active.id)
				return { refused: `agent cannot accept a message while interrupting` };
			// Refuse busy requests when steering is unavailable.
			if (!session.steerTurn) return { refused: this.host.spec.busyMessage ?? `agent is still working` };
			let steerError: unknown;
			let taken = false;
			try {
				taken = (await session.steerTurn(agent.threadId, active.id, prompt, key)) === "taken";
			} catch (error) {
				steerError = error;
			}
			if (!taken && agent.settled) await settledNow(agent.settled);
			if (steerError !== undefined && this.activeTurn(agent) === active) {
				// Driver may retain terminal.
				const seen = await session.inspectTurn?.(agent.threadId, active.id).catch(() => undefined);
				if (seen?.known === "settled") this.applyTerminal(agent, active.id, seen.terminal);
			}
			if (taken || this.activeTurn(agent) === active) {
				if (steerError !== undefined) return this.unavailable(agent.agentId, steerError);
				const at = this.touch(agent);
				agent.exchanges.push({
					kind: "message",
					prompt,
					status: "accepted",
					delivery: "steered",
					turnId: active.id,
					createdAt: at,
					acceptedAt: at,
				});
				if (request.serviceTier !== undefined) agent.serviceTier = request.serviceTier;
				return this.acceptedAnswer(agent, active.id, "steered");
			}
			// The turn ended under the steer, so the prompt opens a new one.
		}

		const serviceTier = request.serviceTier ?? agent.serviceTier;
		const answer = await this.dispatchTurn(session, agent, prompt, "message", {
			model: agent.model,
			serviceTier,
			outputSchema: request.outputSchema,
			key,
		});
		if (serviceTier !== undefined && answer.observation !== "unavailable") agent.serviceTier = serviceTier;
		return answer;
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
		try {
			await session.interruptTurn(agent.threadId, active.id);
		} catch (error) {
			if (agent.interruptingTurnId === active.id) agent.interruptingTurnId = undefined;
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

	recordActivity(turnId: string, text: string): void {
		if (!text) return;
		for (const agent of this.agents.values()) {
			const turn = agent.turns.find((candidate) => candidate.id === turnId);
			if (turn?.state !== "inProgress") continue;
			turn.commentary.push(text);
			while (turn.commentary.length > this.host.spec.maxActivities) {
				turn.commentary.shift();
				turn.omitted += 1;
			}
			turn.updatedAt = this.host.now();
			agent.updatedAt = Math.max(agent.updatedAt, turn.updatedAt);
			return;
		}
	}

	private async dispatchTurn(
		session: AgentBackendSession,
		agent: LocalAgentRecord,
		prompt: string,
		kind: "start" | "message",
		settings: TurnOptions = {},
	): Promise<LocalAgentAnswer> {
		let handle: TurnHandle;
		try {
			handle = await session.startTurn(agent.threadId, prompt, settings);
		} catch (error) {
			const running = await session.adoptTurn?.(agent.threadId).catch(() => undefined);
			// A turn already held is another prompt's.
			if (!running || agent.turns.some((turn) => turn.id === running.turnId))
				return this.unavailable(agent.agentId, error);
			handle = running;
		}

		const at = this.touch(agent);
		const turn: LocalTurnRecord = {
			id: handle.turnId,
			state: "inProgress",
			commentary: [],
			omitted: 0,
			updatedAt: at,
		};
		agent.turns.push(turn);
		agent.activeTurnId = turn.id;
		// Register the turn before racing its terminal.
		const settled = handle.settled.catch((error): TurnTerminal => ({ status: "failed", error: errorText(error) }));
		agent.settled = settled;
		const delivery = agentResultDelivery(kind, "started") ?? "started";
		agent.exchanges.push({
			kind,
			prompt,
			status: "accepted",
			delivery,
			turnId: turn.id,
			createdAt: at,
			acceptedAt: at,
		});
		void settled.then((terminal) => this.applyTerminal(agent, turn.id, terminal));
		this.watchProgress(agent, turn);

		return this.acceptedAnswer(agent, turn.id, delivery);
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
		// Apply the terminal once because listener and waiter paths race.
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
			agent.settled = undefined;
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
