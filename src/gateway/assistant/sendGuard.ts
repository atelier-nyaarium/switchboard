// Guarded assistant crosstalk sends.
// Approval precedes delivery.

import type { Ambient } from "../../shared/ambient.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import type { MIGRATING } from "../../shared/migration-fence.js";
import type { DeliveryOrigin, PendingDelivery } from "../../shared/pending-delivery-store.js";
import {
	type AssistantSendAnswer,
	type AssistantSendIntent,
	type AssistantSendRequest,
	type ConsoleAssistantSendAnswerResult,
	SEND_ROUTE_WAIT_CAP_MS,
} from "../../shared/schemasAssistantSend.js";
import { VAULT_REQUEST_DEADLINE_MS } from "../../shared/schemasVault.js";
import type { ChannelFile } from "../../shared/types.js";
import {
	CLAIMED_ANSWER_GRACE_MS,
	createOwnerRequests,
	type OpenStub,
	type OwnerRequestOpened,
} from "../ownerRequests.js";
import { MAX_PLUGIN_ACTION_PAYLOAD_BYTES } from "../routeSchemas.js";
import type { BoundTarget, SendRecord } from "../routes/routesSend.js";

/** Per-owner request cap. */
export const MAX_OPEN_SENDS = 8;
const DEFAULT_WAIT_MS = SEND_ROUTE_WAIT_CAP_MS;
/** Row cap margin. */
const MAX_CARD_BYTES = MAX_PLUGIN_ACTION_PAYLOAD_BYTES - 1_024;

////////////////////////////////
//  Safety setting

/** Approval defaults on. */
export function createSafetyStore(store: Pick<DurableStore, "load" | "saveChecked">) {
	let off = (store.load() as { approveEverySend?: unknown } | null)?.approveEverySend === false;
	return {
		/** Errors require approval. */
		approveEverySend: (): boolean => !off,
		set: (approveEverySend: boolean): boolean =>
			commitChecked(
				store,
				{ v: 1, approveEverySend },
				() => {
					off = !approveEverySend;
				},
				{ label: "assistant safety" },
			).landed,
	};
}

export type SafetyStore = ReturnType<typeof createSafetyStore>;

////////////////////////////////
//  Origin marker

type MarkOrigin = DeliveryOrigin | "reply" | "unknown";

/**
 * Last speaker, by acceptance order. Owner rows mark on ack, others on offer.
 * Memory only; rows from before boot never read owner.
 */
export function createOriginMarker(bootSeq = 0) {
	let mark: { seq: number; origin: MarkOrigin } | null = null;
	const move = (seq: number, origin: MarkOrigin) => {
		if (!mark || seq >= mark.seq) mark = { seq, origin };
	};
	const originOf = (row: PendingDelivery): MarkOrigin => {
		const origin = row.origin ?? "unknown";
		return origin === "owner" && (row.seq ?? 0) < bootSeq ? "unknown" : origin;
	};
	return {
		/** Emitted into context. */
		delivered: (row: PendingDelivery) => {
			if (row.team === ASSISTANT_TEAM) move(row.seq ?? 0, originOf(row));
		},
		/** Non-owner offers mark before ack. */
		offered: (row: PendingDelivery) => {
			if (row.team === ASSISTANT_TEAM && originOf(row) !== "owner") move(row.seq ?? 0, originOf(row));
		},
		/** Replies mark between rows. */
		replyPushed: (lastSeq: number) => move(lastSeq + 0.5, "reply"),
		/** A new session has heard nothing. */
		ended: () => {
			mark = null;
		},
		readsOwner: () => mark?.origin === "owner",
	};
}

export type OriginMarker = ReturnType<typeof createOriginMarker>;

////////////////////////////////
//  Guard

export interface SendGuardRoutes {
	bindTarget: (to: string) => BoundTarget;
	sendFromAssistant: (args: {
		intent: AssistantSendIntent;
		files: ChannelFile[];
		conversationId: string;
		record: SendRecord;
	}) => Promise<Response>;
}

export interface SendGuardDeps {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	/** Errors require approval. */
	approveEverySend: () => boolean;
	readsOwner: () => boolean;
	routes: () => SendGuardRoutes;
	/** Null unless fully staged. */
	blobSize: (blobId: string) => number | null;
	/** Queue before opening. */
	deliverCard: (request: AssistantSendRequest) => boolean | typeof MIGRATING;
	/** True once queued. */
	retractCard: (stub: OpenStub) => boolean;
	ledger?: Pick<DurableStore, "load" | "save">;
	deadlineMs?: number;
}

export interface SendInput {
	to: string;
	body: string;
	displayLabel?: string;
	disposition?: AssistantSendIntent["disposition"];
	files?: ChannelFile[];
	waitMs?: number;
}

export interface SendCaller {
	team: string;
	conversationId: string;
}

export type GuardReply = { status: number; body: AssistantSendAnswer | { error: string } | { withdrawn: boolean } };

type Bound =
	| { ok: true; intent: AssistantSendIntent; files: ChannelFile[] }
	| { ok: false; status: number; error: string };

/** Repeat identity. */
const intentKey = (intent: AssistantSendIntent): string =>
	JSON.stringify([
		intent.target,
		intent.friendDomain ?? null,
		intent.body,
		intent.disposition ?? null,
		intent.displayLabel ?? null,
		intent.createsSession,
		intent.files.map((file) => [file.digest, file.filename, file.mime, file.size]),
	]);

const failed = (reason: string): AssistantSendAnswer => ({ outcome: "failed", reason });

export function createSendGuard(deps: SendGuardDeps) {
	const { ambient } = deps;
	/** Delivery-only held data. */
	const held = new Map<string, { files: ChannelFile[]; conversationId: string }>();

	const core = createOwnerRequests<AssistantSendRequest, AssistantSendAnswer>({
		ambient,
		deadlineMs: deps.deadlineMs ?? VAULT_REQUEST_DEADLINE_MS,
		maxOpenPerTarget: MAX_OPEN_SENDS,
		deliver: deps.deliverCard,
		lapsed: (why) =>
			why === "ended"
				? failed("the session ended")
				: why === "withdrawn"
					? { outcome: "withdrawn" }
					: { outcome: "expired" },
		onSettled: (request) => {
			held.delete(request.requestId);
			return deps.retractCard(request);
		},
		ledger: deps.ledger,
		// Settled answers remain collectible.
		holdSettledMs: CLAIMED_ANSWER_GRACE_MS,
	});

	const stagedAsBound = (files: readonly { digest: string; size: number }[]): boolean =>
		files.every((file) => deps.blobSize(file.digest) === file.size);

	const bind = (input: SendInput): Bound => {
		let target: BoundTarget;
		try {
			target = deps.routes().bindTarget(input.to);
		} catch {
			return { ok: false, status: 503, error: "this Gateway has no active Domain yet" };
		}
		if (!target.ok) return target;
		const files = input.files ?? [];
		// A line break forges a card line.
		const oneLiners = [input.displayLabel ?? "", ...files.flatMap((file) => [file.filename, file.mime])];
		if (oneLiners.some((text) => /[\r\n]/.test(text))) {
			return { ok: false, status: 400, error: "a label, file name or file type may not span lines" };
		}
		if (target.friendDomain && files.length > 0) {
			return { ok: false, status: 400, error: "attachments do not reach a friend Domain; send without them" };
		}
		for (const file of files) {
			if (!file.blobId)
				return { ok: false, status: 400, error: `attachment "${file.filename}" carries no digest` };
			if (deps.blobSize(file.blobId) !== file.size) {
				return { ok: false, status: 409, error: `attachment "${file.filename}" does not match its upload` };
			}
		}
		const intent: AssistantSendIntent = {
			target: target.target,
			...(target.friendDomain ? { friendDomain: target.friendDomain } : {}),
			body: input.body,
			...(input.disposition ? { disposition: input.disposition } : {}),
			...(input.displayLabel ? { displayLabel: input.displayLabel } : {}),
			createsSession: input.displayLabel !== undefined && target.exists !== true,
			files: files.map((file) => ({
				digest: file.blobId as string,
				filename: file.filename,
				mime: file.mime,
				size: file.size,
			})),
		};
		return { ok: true, intent, files };
	};

	/** An unreadable setting asks. */
	const asks = (): boolean => {
		try {
			if (deps.approveEverySend()) return true;
		} catch {
			return true;
		}
		return !deps.readsOwner();
	};

	const deliver = async (
		intent: AssistantSendIntent,
		files: ChannelFile[],
		conversationId: string,
		record: SendRecord,
	): Promise<AssistantSendAnswer> => {
		// Require bound bytes.
		if (!stagedAsBound(intent.files)) return failed("an attachment changed or is gone; send again");
		try {
			// Revalidate the approved target.
			const now = deps.routes().bindTarget(intent.target);
			if (!now.ok || now.target !== intent.target || now.friendDomain !== intent.friendDomain) {
				return failed("the target changed since it was bound; send again");
			}
			if (!intent.createsSession && now.exists === false) return failed("the target is gone; send again");
			const response = await deps.routes().sendFromAssistant({ intent, files, conversationId, record });
			const body = (await response.json().catch(() => ({}))) as {
				session_id?: string;
				target?: string;
				error?: string;
			};
			// Relay failures may follow delivery.
			if (response.status === 502) {
				return failed(`it may have arrived; check before sending again (${body.error ?? "relay failed"})`);
			}
			if (!response.ok) return failed(body.error ?? `the send failed (${response.status})`);
			return {
				outcome: "sent",
				sessionId: body.session_id ?? "",
				target: body.target ?? intent.target,
				guard: record.guard,
			};
		} catch (error) {
			return failed(error instanceof Error ? error.message : String(error));
		}
	};

	/** Wait ends on answer, timeout, or abort. */
	const waitAnswer = async (
		answer: Promise<AssistantSendAnswer>,
		waitMs: number,
		signal: AbortSignal,
	): Promise<AssistantSendAnswer | null> => {
		if (signal.aborted) return null;
		let onAbort: () => void = () => undefined;
		let timer: ReturnType<typeof ambient.setTimer> | null = null;
		const stop = new Promise<null>((resolve) => {
			onAbort = () => resolve(null);
			signal.addEventListener("abort", onAbort, { once: true });
			timer = ambient.setTimer(() => resolve(null), waitMs);
		});
		try {
			return await Promise.race([answer, stop]);
		} finally {
			signal.removeEventListener("abort", onAbort);
			if (timer) ambient.clearTimer(timer);
		}
	};

	const replyOf = (answer: AssistantSendAnswer | null, request: AssistantSendRequest): GuardReply => {
		if (answer === null) {
			return {
				status: 200,
				body: { outcome: "pending", requestId: request.requestId, deadlineAt: request.deadlineAt },
			};
		}
		return { status: 200, body: answer };
	};

	const unopened = (opened: Exclude<OwnerRequestOpened<unknown, unknown>, { kind: "opened" }>): GuardReply =>
		opened.reason === "flooded"
			? { status: 429, body: { error: "too many sends are already waiting on the owner" } }
			: {
					status: 503,
					body: {
						error:
							opened.reason === "migrating" ? "this Gateway is migrating" : "the owner cannot be reached",
					},
				};

	const waitFor = (requested: number | undefined) => Math.min(requested ?? DEFAULT_WAIT_MS, SEND_ROUTE_WAIT_CAP_MS);

	/** Owner-last bypass; retries join. */
	const send = async (caller: SendCaller, input: SendInput, signal: AbortSignal): Promise<GuardReply> => {
		const bound = bind(input);
		if (!bound.ok) return { status: bound.status, body: { error: bound.error } };
		// Retries join before rechecking approval.
		const key = intentKey(bound.intent);
		const joined = core.find(
			(request) => request.sessionTarget === caller.team && intentKey(request.intent) === key,
		);
		if (joined) {
			const extra = held.get(joined.request.requestId);
			// Joined replies use the latest caller.
			if (extra) extra.conversationId = caller.conversationId;
			return replyOf(await waitAnswer(joined.answer, waitFor(input.waitMs), signal), joined.request);
		}
		if (!asks()) {
			const record: SendRecord = { key: ambient.newId(), guard: "unasked" };
			return { status: 200, body: await deliver(bound.intent, bound.files, caller.conversationId, record) };
		}
		const cardBytes = Buffer.byteLength(
			JSON.stringify({ v: 1, requestId: "", deadlineAt: 0, intent: bound.intent }),
		);
		if (cardBytes > MAX_CARD_BYTES) {
			return { status: 413, body: { error: "too long for an approval card; send it shorter or in parts" } };
		}
		let minted = null as string | null;
		let opened: OwnerRequestOpened<AssistantSendRequest, AssistantSendAnswer>;
		try {
			opened = core.open({
				sessionTarget: caller.team,
				build: (requestId, deadlineAt) => {
					minted = requestId;
					held.set(requestId, { files: bound.files, conversationId: caller.conversationId });
					return { v: 1, requestId, sessionTarget: caller.team, deadlineAt, intent: bound.intent };
				},
			});
		} finally {
			// Failed opens release held data.
			if (minted !== null && !core.find((request) => request.requestId === minted)) held.delete(minted);
		}
		if (opened.kind !== "opened") return unopened(opened);
		return replyOf(await waitAnswer(opened.answer, waitFor(input.waitMs), signal), opened.request);
	};

	const collect = async (
		caller: string,
		requestId: string,
		waitMs: number | undefined,
		signal: AbortSignal,
	): Promise<GuardReply> => {
		const entry = core.collect(requestId, caller);
		if (!entry) return { status: 404, body: { error: "no send waiting under that id" } };
		return replyOf(await waitAnswer(entry.answer, waitFor(waitMs), signal), entry.request);
	};

	const withdraw = (caller: string, requestId: string): GuardReply => ({
		status: 200,
		body: { withdrawn: core.withdraw(requestId, caller) },
	});

	/** Async approval; collect resolves. */
	const answer = (
		requestId: string,
		decision: "approve" | "deny",
		note?: string,
	): ConsoleAssistantSendAnswerResult => {
		const gone = (): ConsoleAssistantSendAnswerResult => ({
			ok: false,
			reason: core.answered(requestId) ? "already answered" : "request expired",
		});
		if (decision === "deny") {
			if (!core.live(requestId)) return gone();
			core.settle(requestId, note ? { outcome: "denied", note } : { outcome: "denied" });
			return { ok: true };
		}
		const request = core.claim(requestId);
		const extra = held.get(requestId);
		if (!request) return gone();
		if (!extra) {
			core.settle(requestId, failed("the send's held state is gone"));
			return { ok: false, reason: "the send's held state is gone" };
		}
		void deliver(request.intent, extra.files, extra.conversationId, { key: requestId, guard: "approved" }).then(
			(outcome) => core.settle(requestId, outcome),
			(error) => core.settle(requestId, failed(String(error))),
		);
		return { ok: true };
	};

	return {
		send,
		collect,
		withdraw,
		answer,
		sessionEnded: (team: string) => core.sessionEnded(team),
		retractStale: () => core.retractStale(deps.retractCard),
		/** Held send blob reference. */
		namesBlob: (blobId: string) =>
			[...held.values()].some((entry) => entry.files.some((file) => file.blobId === blobId)),
	};
}

export type SendGuard = ReturnType<typeof createSendGuard>;
