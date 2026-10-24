// Vault request adapter.

import type { Ambient } from "../../shared/ambient.js";
import type { DurableStore } from "../../shared/durable-store.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import type { ContentEnvelope } from "../../shared/schemasContentKey.js";
import {
	type PolicyRef,
	VAULT_REQUEST_DEADLINE_MS,
	type VaultApprovedDecision,
	type VaultDecision,
	type VaultRequest,
} from "../../shared/schemasVault.js";
import { createOwnerRequests, type Held, type OpenStub, type OwnerRequestOpened } from "../ownerRequests.js";
import { displayShape } from "./decisions.js";
import { operationSet } from "./operationSet.js";

export type VaultRequestInput =
	| { kind: "entry"; entryId: string; operation: string; sessionTarget: string; asker?: string; policy?: PolicyRef }
	| { kind: "typed"; operation: string; sessionTarget: string; asker?: string };

export type VaultRequestAnswer =
	| { kind: "approved"; decision: VaultApprovedDecision; typedValue?: string }
	| { kind: "refused"; note?: string };

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
	validate?: (request: VaultRequest) => string | null;
	onApproved?: (request: VaultRequest, decision: VaultDecision) => void;
	/** Once per request; false keeps its stub to retract later. */
	onSettled?: (request: VaultRequest) => boolean;
	/** The deadline passed with nobody having decided, which a deny is not. */
	onUnanswered?: (request: VaultRequest) => void;
	deadlineMs?: number;
	/** Restart retraction ledger. */
	ledger?: Pick<DurableStore, "load" | "save">;
}

const REFUSED: VaultRequestAnswer = { kind: "refused" };

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
	});

	const open = (input: VaultRequestInput): VaultRequestOpened => {
		const shape = displayShape(input.operation);
		if (!shape) return { kind: "undeliverable", reason: "unreachable" };
		return core.open({
			sessionTarget: input.sessionTarget,
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
						}
					: { kind: "typed", ...common };
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
	): { ok: true } | { ok: false; reason: string } => {
		const request = core.live(requestId);
		if (!request) return { ok: false, reason: "request expired" };
		if (decision === "deny") {
			core.settle(requestId, note ? { kind: "refused", note } : REFUSED);
			return { ok: true };
		}
		if (request.kind === "typed") {
			const typedValue = value ? deps.openTyped(value, requestId) : null;
			if (typedValue === null) return { ok: false, reason: "typed value unreadable" };
			// A typed value is handed over once; no grant outlives it.
			core.settle(requestId, { kind: "approved", decision: "once", typedValue });
			return { ok: true };
		}
		const refusal = deps.validate?.(request) ?? null;
		if (refusal !== null) {
			core.settle(requestId, { kind: "refused", note: refusal });
			return { ok: false, reason: refusal };
		}
		deps.onApproved?.(request, decision);
		core.settle(requestId, { kind: "approved", decision });
		return { ok: true };
	};

	/** Refuses what the policy resolved. */
	const policyMoved = (policyId: string): void =>
		core.closeWhere((request) => request.kind === "entry" && request.policy?.policyId === policyId, {
			kind: "refused",
			note: "the policy changed; ask again",
		});

	return {
		open,
		find,
		answer,
		collect: core.collect,
		forget: core.forget,
		withdraw: core.withdraw,
		sessionEnded: core.sessionEnded,
		policyMoved,
		retractStale: (retract: (stub: OpenStub) => boolean) => core.retractStale(retract),
	};
}

export type VaultRequests = ReturnType<typeof createVaultRequests>;
