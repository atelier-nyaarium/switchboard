import type { AgentBackendId } from "../../shared/agent-backend.js";
import { AGENT_AGE_PASS_MS } from "../../shared/agent-collect.js";
import type { AgentNotice } from "../../shared/agent-notice.js";
import type { AgentDaemonFailureCode, AgentServiceTier } from "../../shared/agent-state.js";
import type { AgentTurnMarks } from "../../shared/agent-turn-marks.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import { createSingleFlight } from "../../shared/single-flight.js";
import type { AgentBackendSession } from "../agents/backendSession.js";
import type { LocalExchangeRecord } from "./localAgentHandlers.js";
import { LocalAgentHandlers } from "./localAgentHandlers.js";
import { LocalChildSession } from "./localChildSession.js";
import { LocalOperationLedger } from "./localOperationLedger.js";

export { LOCAL_IDLE_REAP_MS } from "./localChildSession.js";

export type LocalAgentState = "idle" | "working" | "unavailable";
export type LocalTurnState = "inProgress" | "completed" | "failed" | "interrupted";
export type LocalObservation = "accepted" | "terminal" | "waitTimedOut" | "idle" | "interruptRequested" | "unavailable";

export type LocalErrorCode = "not_found" | "expired" | "turn_failed" | AgentDaemonFailureCode;

export interface LocalRefusal {
	refused: string;
}

export interface LocalError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface LocalAgentAnswer {
	agentId: string;
	agentState: LocalAgentState;
	observation: LocalObservation;
	turn?: { id: string; state: LocalTurnState };
	delivery?: string;
	activities: Array<{ kind: "commentary"; text: string } | { kind: "truncated"; omitted: number }>;
	finalResponse?: string;
	error?: LocalError;
}

export interface LocalCollectAnswer {
	agentId: string;
	agentState: string;
	running: string | null;
	turns: unknown[];
}

export interface LocalDeleteAnswer {
	agentId: string;
	deleted: boolean;
	note?: string;
}

export type LocalAnswer = LocalAgentAnswer | LocalRefusal | LocalCollectAnswer | LocalDeleteAnswer;

export interface LocalRequest {
	kind: "start" | "message" | "await" | "stop" | "delete" | "list";
	operationId?: string;
	agentId?: string;
	prompt?: string;
	model?: string;
	cwd?: string;
	serviceTier?: AgentServiceTier;
	reasoningEffort?: string;
	outputSchema?: Record<string, unknown>;
}

export interface LocalBackendSpec {
	backendId: AgentBackendId;
	displayName: string;
	/** Classifies driver refusal text. */
	failureCode?: (error: string) => AgentDaemonFailureCode | undefined;
	openSession(): Promise<AgentBackendSession>;
	defaultCwd(): string;
	busyMessage?: string;
	maxActivities: number;
	// Reap only resumable threads.
	threadsResumable: boolean;
	// Local operations reject retries.
	replaysOperations: false;
	notify?: (notice: AgentNotice) => void;
	progressEveryMs?: number;
}

export interface LocalListAgent {
	agentId: string;
	agentState: LocalAgentState;
	model?: string;
	activeTurnId?: string;
	exchanges: Array<Omit<LocalExchangeRecord, never>>;
	turns: Array<{
		id: string;
		state: LocalTurnState;
		activities: LocalAgentAnswer["activities"];
		finalResponse?: string;
		error?: string;
		updatedAt: number;
	}>;
	turnMarks: AgentTurnMarks;
	createdAt: number;
	updatedAt: number;
}

/** Within plugin exit wait. */
export const LOCAL_THREAD_END_MS = 2_000;

/** Local mode's lease, operation claim and per-agent queue. */
export class LocalAgentRuntime {
	private readonly ledger: LocalOperationLedger;
	private readonly child: LocalChildSession;
	private readonly handlers: LocalAgentHandlers;
	/** Serialize messages and stops per agent. */
	private readonly perAgent = createKeyedFifo<string>();
	private readonly listing = createSingleFlight<null, string[] | undefined>();
	private readonly ageTimer: ReturnType<typeof setInterval>;
	private inFlight = 0;

	constructor(
		private readonly spec: LocalBackendSpec,
		private readonly now: () => number = () => Date.now(),
	) {
		this.ledger = new LocalOperationLedger(spec.backendId);
		this.handlers = new LocalAgentHandlers({
			spec: this.spec,
			now: this.now,
			open: () => this.child.open(),
			drop: (session) => this.child.drop(session),
			markUsed: (at) => this.child.markUsed(at),
		});
		this.child = new LocalChildSession({
			spec: this.spec,
			now: this.now,
			inFlight: () => this.inFlight,
			hasActiveTurn: () => this.handlers.hasActiveTurn(),
			onClosed: (session) => this.handlers.closed(session),
		});
		this.ageTimer = setInterval(() => {
			void this.expireThreads().catch((error) =>
				console.error(`[${spec.backendId}-local] thread age pass failed:`, error),
			);
		}, AGENT_AGE_PASS_MS);
		this.ageTimer.unref?.();
	}

	/** Expiry shares per-agent lanes. */
	async expireThreads(): Promise<void> {
		const now = this.now();
		const aged = this.handlers.aged(now);
		if (aged.length === 0) return;
		this.inFlight += 1;
		try {
			for (const agentId of aged) await this.perAgent.run(agentId, () => this.handlers.expire(agentId, now));
		} finally {
			this.inFlight -= 1;
			this.child.markUsed();
		}
	}

	reapIfIdle(): boolean {
		return this.child.reapIfIdle();
	}

	async handle(request: LocalRequest): Promise<LocalAnswer> {
		// Count the entire dispatch as in flight.
		this.inFlight += 1;
		try {
			// Claim before dispatch to serialize retries.
			const claim = this.ledger.claim(request);
			if (claim) return claim;
			const answer = await this.dispatch(request);
			if (this.unstarted(answer)) this.ledger.release(request);
			return answer;
		} finally {
			this.inFlight -= 1;
			this.child.markUsed();
		}
	}

	private async dispatch(request: LocalRequest): Promise<LocalAnswer> {
		switch (request.kind) {
			case "start":
				return await this.handlers.start(request);
			case "message":
				return await this.perAgent.run(request.agentId ?? "", () => this.handlers.message(request));
			case "await":
				return this.handlers.collect(request);
			case "stop":
				return await this.perAgent.run(request.agentId ?? "", () => this.handlers.stop(request));
			case "delete":
				return await this.perAgent.run(request.agentId ?? "", () => this.handlers.delete(request));
			default:
				return { refused: `unsupported request: ${request.kind}` };
		}
	}

	private unstarted(answer: LocalAnswer): boolean {
		if ("refused" in answer || "running" in answer || "deleted" in answer) return false;
		return answer.observation === "unavailable" && answer.error?.retryable === true;
	}

	list(): LocalListAgent[] {
		return this.handlers.list();
	}

	/** Share concurrent model listings. */
	listModels(): Promise<string[] | undefined> {
		return this.listing.run(null, async () => {
			this.inFlight += 1;
			const opens = !this.child.isOpen();
			let session: AgentBackendSession | undefined;
			try {
				session = await this.child.open();
				return (await session.listModels?.())?.map((model) => model.id);
			} finally {
				this.inFlight -= 1;
				this.child.markUsed();
				// Nothing reaps a child whose threads cannot be resumed.
				const unused = opens && this.inFlight === 0 && !this.spec.threadsResumable;
				if (session && unused && !this.handlers.uses(session)) this.child.drop(session);
			}
		});
	}

	/** Bounded thread deletion first; always end child. */
	async shutdown(): Promise<void> {
		clearInterval(this.ageTimer);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, LOCAL_THREAD_END_MS);
		});
		try {
			await Promise.race([this.handlers.endAll(), late]);
		} finally {
			clearTimeout(timer);
			this.child.shutdown();
		}
	}
}
