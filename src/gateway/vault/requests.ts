// Vault request adapter.

import type { Ambient } from "../../shared/ambient.js";
import { capFifo } from "../../shared/cap-fifo.js";
import type { DurableStore } from "../../shared/durable-store.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import {
	type PolicyRef,
	VAULT_REQUEST_DEADLINE_MS,
	type VaultAnswering,
	type VaultAnswerRefusal,
	type VaultApprovedDecision,
	type VaultDecision,
	type VaultEntryTier,
	type VaultRequest,
	type VaultTypedWhy,
} from "../../shared/schemasVault.js";
import { createOwnerRequests, type Held, type OpenStub, type OwnerRequestOpened } from "../ownerRequests.js";
import { displayShape, type GrantScope } from "./decisions.js";
import { operationSet } from "./operationSet.js";

export type VaultRequestInput =
	| {
			kind: "entry";
			entryId: string;
			operation: string;
			sessionTarget: string;
			asker?: string;
			policy?: PolicyRef;
			replaces?: string;
			deadlineAt?: number;
	  }
	| {
			kind: "typed";
			operation: string;
			sessionTarget: string;
			asker?: string;
			why?: VaultTypedWhy;
			runsAnything?: boolean;
			cannotRemember?: boolean;
			answering?: VaultAnswering[];
	  };

type TypedRequest = Extract<VaultRequest, { kind: "typed" }>;
export type EntryRequest = Extract<VaultRequest, { kind: "entry" }>;

/** What a policy write does to an open entry request it resolved. */
export type EntryVerdict = "keep" | "refuse" | { revision: number };

/** Bounds the moved-id memory. */
const MAX_MOVES = 256;

/** What hands the value over; `covered` is read again as it leaves. */
export type VaultAnswerSource =
	| { kind: "typed"; value: string }
	| { kind: "entry"; entryId: string; covered?: GrantScope };

export type VaultRequestAnswer =
	| { kind: "approved"; decision: VaultApprovedDecision; source: VaultAnswerSource }
	| { kind: "refused"; note?: string }
	/** An entry request took over; the waiter follows it. */
	| { kind: "moved"; requestId: string; deadlineAt: number };

/** What a policy change does to a waiting typed request. */
export type TakeOver = "covered" | "moved" | "kept";

export type VaultRequestOpened = OwnerRequestOpened<VaultRequest, VaultRequestAnswer>;

/** One caller's share of the owner's attention; a loop cannot bury the phone. */
export const MAX_OPEN_PER_TARGET = 8;

export interface VaultRequestsDeps {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	/** Only queued rows open requests. */
	deliver: (request: VaultRequest) => boolean | typeof MIGRATING;
	/** Opens typed values with request AAD. */
	openTyped: (envelope: ContentEnvelope, requestId: string) => string | null;
	/** Runs before `onApproved`; a refusal settles the request refused and mints no grant. */
	validate?: (scope: GrantScope) => string | null;
	onApproved?: (scope: GrantScope, decision: VaultDecision) => void;
	/** Once per request; false keeps its stub to retract later. */
	onSettled?: (request: VaultRequest) => boolean;
	/** The deadline passed with nobody having decided, which a deny is not. */
	onUnanswered?: (request: VaultRequest) => void;
	deadlineMs?: number;
	/** Restart retraction ledger. */
	ledger?: Pick<DurableStore, "load" | "save">;
}

const REFUSED: VaultRequestAnswer = { kind: "refused" };

const scopeOf = (request: VaultRequest, entryId: string, policy: PolicyRef | undefined): GrantScope => ({
	entryId,
	displayShape: request.displayShape,
	coveredShapes: request.coveredShapes,
	sessionTarget: request.sessionTarget,
	...(policy ? { policy } : {}),
});

export function createVaultRequests(deps: VaultRequestsDeps) {
	const core = createOwnerRequests<VaultRequest, VaultRequestAnswer>({
		ambient: deps.ambient,
		deadlineMs: deps.deadlineMs ?? VAULT_REQUEST_DEADLINE_MS,
		maxOpenPerTarget: MAX_OPEN_PER_TARGET,
		deliver: deps.deliver,
		lapsed: () => REFUSED,
		onSettled: deps.onSettled,
		onUnanswered: deps.onUnanswered,
		ledger: deps.ledger,
		collectUntil: ({ cause, at, deadlineAt }) => (cause === "answered" ? deadlineAt : at),
	});

	const open = (input: VaultRequestInput): VaultRequestOpened => {
		const shape = displayShape(input.operation);
		if (!shape) return { kind: "undeliverable", reason: "unreachable" };
		return core.open({
			sessionTarget: input.sessionTarget,
			payload: undefined,
			...(input.kind === "entry" && input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
			...(input.kind === "entry" && input.replaces !== undefined ? { replacing: input.replaces } : {}),
			build: (requestId, deadlineAt) => {
				const common = {
					v: 1 as const,
					requestId,
					operation: input.operation,
					displayShape: shape,
					coveredShapes: operationSet(input.operation),
					sessionTarget: input.sessionTarget,
					deadlineAt,
					...(input.asker === undefined ? {} : { asker: input.asker }),
				};
				return input.kind === "entry"
					? {
							kind: "entry",
							entryId: input.entryId,
							...common,
							...(input.policy ? { policy: input.policy } : {}),
							...(input.replaces ? { replaces: input.replaces } : {}),
						}
					: {
							kind: "typed",
							...common,
							...(input.why ? { why: input.why } : {}),
							...(input.runsAnything ? { runsAnything: true as const } : {}),
							...(input.cannotRemember ? { cannotRemember: true as const } : {}),
							...(input.answering?.length ? { answering: input.answering } : {}),
						};
			},
		});
	};

	/** A retry joins the open request. */
	const find = (input: VaultRequestInput): Held<VaultRequest, VaultRequestAnswer> | undefined =>
		core.find((request) => {
			if (request.kind !== input.kind || request.sessionTarget !== input.sessionTarget) return false;
			if (request.operation !== input.operation) return false;
			if (input.kind !== "entry") return true;
			return (
				request.kind === "entry" &&
				request.entryId === input.entryId &&
				request.policy?.policyId === input.policy?.policyId &&
				request.policy?.policyRevision === input.policy?.policyRevision
			);
		});

	/** Answers are single-use. A deny's note steers the asker. */
	const answer = (
		requestId: string,
		decision: VaultDecision,
		value?: ContentEnvelope,
		note?: string,
	): { ok: true } | { ok: false; reason: string; refusal?: VaultAnswerRefusal } => {
		// Prose for an older phone.
		const gone = () =>
			core.answered(requestId)
				? { ok: false as const, reason: "already answered", refusal: { code: "answered" as const } }
				: { ok: false as const, reason: "request expired", refusal: { code: "expired" as const } };
		const request = core.live(requestId);
		if (!request) return gone();
		if (decision === "deny") {
			return core.settle(requestId, note ? { kind: "refused", note } : REFUSED) ? { ok: true } : gone();
		}
		if (request.kind === "typed") {
			const typedValue = value ? deps.openTyped(value, requestId) : null;
			if (typedValue === null) return { ok: false, reason: "typed value unreadable" };
			// A typed value is handed over once; no grant outlives it.
			return core.settle(requestId, {
				kind: "approved",
				decision: "once",
				source: { kind: "typed", value: typedValue },
			})
				? { ok: true }
				: gone();
		}
		const scope = scopeOf(request, request.entryId, request.policy);
		const refusal = deps.validate?.(scope) ?? null;
		if (refusal !== null) {
			core.settle(requestId, { kind: "refused", note: refusal });
			return { ok: false, reason: refusal };
		}
		deps.onApproved?.(scope, decision);
		return core.settle(requestId, {
			kind: "approved",
			decision,
			source: { kind: "entry", entryId: request.entryId },
		})
			? { ok: true }
			: gone();
	};

	/** A waiting typed request, or why not. */
	const typedLive = (requestId: string): TypedRequest | VaultAnswerRefusal => {
		const request = core.live(requestId);
		if (!request) return { code: core.answered(requestId) ? "answered" : "expired" };
		return request.kind === "typed" ? request : { code: "not_typed" };
	};

	/**
	 * A claimed request never lapses: answered or given back, never `expired`.
	 */
	const claimTyped = (requestId: string): TypedRequest | VaultAnswerRefusal => {
		const request = typedLive(requestId);
		if ("code" in request) return request;
		return core.claim(requestId) ? request : { code: core.answered(requestId) ? "answered" : "expired" };
	};

	/** Waiting again, its deadline read on the next tick. */
	const unclaim = (requestId: string): void => {
		core.unclaim(requestId);
	};

	/** The caller holds the claim, the entry usable and the policy written. */
	const answerEntry = (
		request: TypedRequest,
		decision: VaultEntryTier,
		entryId: string,
		policy?: PolicyRef,
	): VaultAnswerRefusal | null => {
		deps.onApproved?.(scopeOf(request, entryId, policy), decision);
		const source = { kind: "entry" as const, entryId };
		return core.settle(request.requestId, { kind: "approved", decision, source }) ? null : { code: "answered" };
	};

	/** A typed id that moved names its replacement, so a withdraw reaches it. */
	const moves = new Map<string, string>();

	const typedWaiting = (): TypedRequest[] =>
		core.waiting(() => true).filter((request): request is TypedRequest => request.kind === "typed");

	/**
	 * A covering grant answers it; else an entry request opens first, so a refused open leaves the typed one.
	 */
	const takeOver = (
		requestId: string,
		entryId: string,
		policy: PolicyRef,
		covering: (scope: GrantScope) => VaultApprovedDecision | null,
	): TakeOver => {
		const request = typedLive(requestId);
		if ("code" in request) return "kept";
		const scope = scopeOf(request, entryId, policy);
		const tier = covering(scope);
		if (tier !== null) {
			const source = { kind: "entry" as const, entryId, covered: scope };
			return core.settle(requestId, { kind: "approved", decision: tier, source }) ? "covered" : "kept";
		}
		const input = {
			kind: "entry" as const,
			entryId,
			operation: request.operation,
			sessionTarget: request.sessionTarget,
			...(request.asker === undefined ? {} : { asker: request.asker }),
			policy,
			replaces: requestId,
			deadlineAt: request.deadlineAt,
		};
		const existing = find(input);
		const opened = existing ? { kind: "opened" as const, ...existing } : open(input);
		if (opened.kind !== "opened") return "kept";
		const moved = {
			kind: "moved" as const,
			requestId: opened.request.requestId,
			deadlineAt: opened.request.deadlineAt,
		};
		if (!core.settle(requestId, moved)) return "kept";
		moves.set(requestId, opened.request.requestId);
		capFifo(moves, MAX_MOVES);
		return "moved";
	};

	const withdraw = (requestId: string, sessionTarget: string): boolean => {
		if (core.withdraw(requestId, sessionTarget)) return true;
		const replacement = moves.get(requestId);
		return replacement !== undefined && core.withdraw(replacement, sessionTarget);
	};

	/**
	 * Per waiting entry request: `keep`, restate at the new revision, or refuse.
	 */
	const reviseEntries = (verdict: (request: EntryRequest, policy: PolicyRef) => EntryVerdict): void => {
		const refused = new Set<string>();
		for (const request of core.waiting(() => true)) {
			if (request.kind !== "entry" || request.policy === undefined) continue;
			const said = verdict(request, request.policy);
			if (said === "refuse") refused.add(request.requestId);
			else if (said !== "keep") {
				core.revise({ ...request, policy: { ...request.policy, policyRevision: said.revision } });
			}
		}
		if (refused.size === 0) return;
		core.closeWhere((request) => refused.has(request.requestId), {
			kind: "refused",
			note: "the policy changed; ask again",
		});
	};

	return {
		open,
		find,
		answer,
		typedLive,
		claimTyped,
		unclaim,
		answerEntry,
		typedWaiting,
		takeOver,
		collect: core.collect,
		take: core.take,
		withdraw,
		sessionEnded: core.sessionEnded,
		reviseEntries,
		retractStale: (retract: (stub: OpenStub) => boolean) => core.retractStale(retract),
	};
}

export type VaultRequests = ReturnType<typeof createVaultRequests>;
