// Requests settle once and expire at their deadline.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { MIGRATING } from "../../shared/migration-fence.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import {
	type PolicyRef,
	VAULT_REQUEST_DEADLINE_MS,
	type VaultApprovedDecision,
	type VaultDecision,
	type VaultRequest,
} from "../../shared/schemasVault.js";
import { displayShape } from "./decisions.js";
import { operationSet } from "./operationSet.js";

export type VaultRequestInput =
	| { kind: "entry"; entryId: string; operation: string; sessionTarget: string; asker?: string; policy?: PolicyRef }
	| { kind: "typed"; operation: string; sessionTarget: string; asker?: string };

export type VaultRequestAnswer =
	| { kind: "approved"; decision: VaultApprovedDecision; typedValue?: string }
	| { kind: "refused"; note?: string };

export type VaultRequestOpened =
	| { kind: "opened"; request: VaultRequest; answer: Promise<VaultRequestAnswer> }
	| { kind: "undeliverable"; reason: "migrating" | "unreachable" | "flooded" };

/** One caller's share of the owner's attention; a loop cannot bury the phone. */
export const MAX_OPEN_PER_TARGET = 8;

export interface VaultRequestsDeps {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	/** Only queued rows open requests. */
	deliver: (request: VaultRequest) => boolean | typeof MIGRATING;
	/** Opens typed values with request AAD. */
	openTyped: (envelope: ContentEnvelope, requestId: string) => string | null;
	/** Runs before `onApproved`; a refusal settles the request refused and mints no grant. */
	validate?: (request: VaultRequest) => string | null;
	onApproved?: (request: VaultRequest, decision: VaultDecision) => void;
	/** Once per request, however it settled. */
	onSettled?: (request: VaultRequest) => void;
	/** The deadline passed with nobody having decided, which a deny is not. */
	onUnanswered?: (request: VaultRequest) => void;
	deadlineMs?: number;
}

interface Pending {
	request: VaultRequest;
	timer: TimerHandle;
	answer: Promise<VaultRequestAnswer>;
	settle: (answer: VaultRequestAnswer) => void;
	settled: boolean;
}

export function createVaultRequests(deps: VaultRequestsDeps) {
	const deadlineMs = deps.deadlineMs ?? VAULT_REQUEST_DEADLINE_MS;
	const pending = new Map<string, Pending>();

	/** Only one collector removes a request. */
	const forget = (requestId: string): boolean => {
		const entry = pending.get(requestId);
		if (!entry) return false;
		deps.ambient.clearTimer(entry.timer);
		pending.delete(requestId);
		return true;
	};

	const openFor = (sessionTarget: string): number => {
		let count = 0;
		for (const entry of pending.values())
			if (!entry.settled && entry.request.sessionTarget === sessionTarget) count += 1;
		return count;
	};

	const open = (input: VaultRequestInput): VaultRequestOpened => {
		const requestId = deps.ambient.newId();
		const shape = displayShape(input.operation);
		if (!shape) return { kind: "undeliverable", reason: "unreachable" };
		if (openFor(input.sessionTarget) >= MAX_OPEN_PER_TARGET) return { kind: "undeliverable", reason: "flooded" };
		const common = {
			v: 1 as const,
			requestId,
			operation: input.operation,
			displayShape: shape,
			coveredShapes: operationSet(input.operation),
			sessionTarget: input.sessionTarget,
			deadlineAt: deps.ambient.now() + deadlineMs,
			...(input.asker === undefined ? {} : { asker: input.asker }),
		};
		const request: VaultRequest =
			input.kind === "entry"
				? {
						kind: "entry",
						entryId: input.entryId,
						...common,
						...(input.policy ? { policy: input.policy } : {}),
					}
				: { kind: "typed", ...common };
		const delivered = deps.deliver(request);
		if (delivered !== true)
			return { kind: "undeliverable", reason: delivered === MIGRATING ? "migrating" : "unreachable" };
		let settle: (answer: VaultRequestAnswer) => void = () => undefined;
		const answer = new Promise<VaultRequestAnswer>((resolve) => {
			settle = resolve;
		});
		const entry: Pending = {
			request,
			answer,
			settle: (result) => {
				if (entry.settled) return;
				entry.settled = true;
				settle(result);
				// A listener's failure never leaves a settled entry behind.
				try {
					deps.onSettled?.(request);
				} catch {}
			},
			settled: false,
			// The deadline ends an uncollected answer too. Unanswered is not the same as denied, so
			// only this road says so; a deny is the owner having decided.
			timer: deps.ambient.setTimer(() => {
				entry.settle({ kind: "refused" });
				pending.delete(requestId);
				try {
					deps.onUnanswered?.(request);
				} catch {}
			}, deadlineMs),
		};
		pending.set(requestId, entry);
		return { kind: "opened", request, answer };
	};

	/** A retry joins the open request. */
	const find = (input: VaultRequestInput): Pick<Pending, "request" | "answer"> | undefined => {
		for (const entry of pending.values()) {
			const { request } = entry;
			if (entry.settled || request.kind !== input.kind || request.sessionTarget !== input.sessionTarget) continue;
			if (request.operation !== input.operation) continue;
			if (input.kind === "entry") {
				if (request.kind !== "entry" || request.entryId !== input.entryId) continue;
				if (
					request.policy?.policyId !== input.policy?.policyId ||
					request.policy?.policyRevision !== input.policy?.policyRevision
				)
					continue;
			}
			return entry;
		}
		return undefined;
	};

	/** Answers are single-use. A deny's note steers the asker. */
	const answer = (
		requestId: string,
		decision: VaultDecision,
		value?: ContentEnvelope,
		note?: string,
	): { ok: true } | { ok: false; reason: string } => {
		const entry = pending.get(requestId);
		if (!entry || entry.settled) return { ok: false, reason: "request expired" };
		if (deps.ambient.now() >= entry.request.deadlineAt) {
			entry.settle({ kind: "refused" });
			forget(requestId);
			return { ok: false, reason: "request expired" };
		}
		if (decision === "deny") {
			entry.settle(note ? { kind: "refused", note } : { kind: "refused" });
			return { ok: true };
		}
		if (entry.request.kind === "typed") {
			const typedValue = value ? deps.openTyped(value, requestId) : null;
			if (typedValue === null) return { ok: false, reason: "typed value unreadable" };
			// A typed value is handed over once; no grant outlives it.
			entry.settle({ kind: "approved", decision: "once", typedValue });
			return { ok: true };
		}
		const refusal = deps.validate?.(entry.request) ?? null;
		if (refusal !== null) {
			entry.settle({ kind: "refused", note: refusal });
			return { ok: false, reason: refusal };
		}
		deps.onApproved?.(entry.request, decision);
		entry.settle({ kind: "approved", decision });
		return { ok: true };
	};

	/** Collect only by session before deadline. */
	const collect = (requestId: string, sessionTarget: string): Pending | undefined => {
		const entry = pending.get(requestId);
		if (!entry || entry.request.sessionTarget !== sessionTarget) return undefined;
		if (deps.ambient.now() >= entry.request.deadlineAt) {
			entry.settle({ kind: "refused" });
			forget(requestId);
			return undefined;
		}
		return entry;
	};

	/** The opener withdraws a pending request; a later answer reads as expired. */
	const withdraw = (requestId: string, sessionTarget: string): boolean => {
		const entry = pending.get(requestId);
		if (!entry || entry.settled || entry.request.sessionTarget !== sessionTarget) return false;
		entry.settle({ kind: "refused" });
		return forget(requestId);
	};

	/** Session end refuses open requests. */
	const sessionEnded = (sessionTarget: string): void => {
		for (const [requestId, entry] of [...pending]) {
			if (entry.request.sessionTarget !== sessionTarget) continue;
			entry.settle({ kind: "refused" });
			forget(requestId);
		}
	};

	/** Refuses what the policy resolved. */
	const policyMoved = (policyId: string): void => {
		for (const [requestId, entry] of [...pending]) {
			if (entry.settled || entry.request.kind !== "entry" || entry.request.policy?.policyId !== policyId)
				continue;
			entry.settle({ kind: "refused", note: "the policy changed; ask again" });
			forget(requestId);
		}
	};

	return { open, find, answer, collect, forget, withdraw, sessionEnded, policyMoved };
}

export type VaultRequests = ReturnType<typeof createVaultRequests>;
