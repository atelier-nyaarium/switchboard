// Launches a session's send waits on: each one's stage, and who to tell how it ended.

import { z } from "zod";
import type { AwarenessObservation, AwarenessSubscriber } from "../shared/awareness-types.js";
import { commitChecked, type DurableStore } from "../shared/durable-store.js";
import {
	failureFor,
	LAUNCH_NOTICE_SOURCE,
	type LaunchFailure,
	LaunchFailureSchema,
	type LaunchNotice,
	launchNoticeText,
	PLAIN_LAUNCH_REASON,
} from "../shared/launch-notice.js";
import type { WakeResult } from "./wake.js";

////////////////////////////////
//  Interfaces & Types

const DeliverySchema = z.object({
	deliveryId: z.string(),
	channelJobId: z.string(),
	/** The job held an earlier message's reply. */
	keepsJob: z.literal(true).optional(),
});

const RelaySchema = z.object({ srcGateway: z.string(), srcSession: z.string(), dstDomainId: z.string().nullable() });

const RecordSchema = z.object({
	team: z.string(),
	address: z.string(),
	created: z.boolean(),
	startedAt: z.number(),
	settledAt: z.number().optional(),
	stage: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("launching") }),
		z.object({ kind: z.literal("up") }),
		z.object({ kind: z.literal("failed"), failure: LaunchFailureSchema }),
	]),
	requesters: z.array(
		z.object({
			sessionKey: z.string(),
			/** A relayed send's way back, told on its reply road rather than the bank. */
			relay: RelaySchema.optional(),
			deliveries: z.array(DeliverySchema),
			told: z.boolean(),
			foreign: z.boolean(),
		}),
	),
});

export type LaunchDelivery = z.infer<typeof DeliverySchema>;
export type LaunchRelay = z.infer<typeof RelaySchema>;
export type LaunchRecord = z.infer<typeof RecordSchema>;

export interface LaunchJoin {
	team: string;
	address: string;
	created: boolean;
	sessionKey: string;
	relay?: LaunchRelay;
	delivery: LaunchDelivery;
	foreign: boolean;
}

export interface LaunchRecordsDeps {
	durable: Pick<DurableStore, "saveChecked" | "load">;
	now(): number;
	/** How long a launch may take before it reads as never up. */
	timeoutMs: number;
	/** Countdown start; null while building. */
	countdownFrom(team: string): number | null;
	isLive(team: string): boolean;
	/** Sender has a record, maybe reconnecting. */
	senderKnown(sessionKey: string): boolean;
	/** A launch this process still waits on; its own timeout decides. */
	inFlight(team: string): boolean;
	/** Retires a row and its reply job. */
	withdraw(delivery: LaunchDelivery): void;
	/** A create's record, still unconfirmed. */
	forgetCreated(team: string): void;
	/** The host link, compared by identity. */
	hostLink(): object | undefined;
	/** True once the daemon is told to open no pane. */
	cancel(team: string): boolean;
	observe(observations: readonly AwarenessObservation<LaunchNotice>[]): void;
	/** Tells a relayed send's Gateway; true once it took it. */
	relay(relay: LaunchRelay, notice: LaunchNotice): Promise<boolean>;
}

export type LaunchOutcome = { up: true } | { failure: LaunchFailure };

export interface LaunchRecords {
	/** False when it could not be written; nothing changed. */
	join(input: LaunchJoin): boolean;
	settle(team: string, outcome: LaunchOutcome | undefined): void;
	tick(): void;
	markTold(identity: string, sessionKey: string): void;
	/** The bank gave a notice up undelivered. */
	dropped(identity: string, sessionKey: string): void;
}

////////////////////////////////
//  Constants

/** A settled launch whose senders never took their notice. */
const SETTLED_HOLD_MS = 30 * 60_000;

/** Between asks of a sender that is away. */
export const AWAY_RETRY_MS = 30_000;

////////////////////////////////
//  Functions & Helpers

const identityOf = (record: LaunchRecord): string => `launch:${record.team}:${record.startedAt}`;

function noticeOf(record: LaunchRecord, foreign: boolean): LaunchNotice | undefined {
	if (record.stage.kind === "up") return { kind: "up", address: record.address };
	if (record.stage.kind === "failed") {
		return {
			kind: "failed",
			address: record.address,
			failure: failureFor(record.stage.failure, foreign),
			created: record.created,
			foreign,
		};
	}
	return undefined;
}

/** A wake's end, read for a launch; undefined leaves it to the tick. */
export function launchOutcome(result: WakeResult): LaunchOutcome | undefined {
	if (result.ok) return { up: true };
	if (result.failure) return { failure: result.failure };
	// A dropped host link proves nothing.
	if (result.errorKind === "disconnected") return undefined;
	if (result.errorKind === "timeout") return { failure: { kind: "timeout" } };
	return { failure: { kind: "error", reason: result.error ?? PLAIN_LAUNCH_REASON } };
}

export function createLaunchSubscriber(
	records: () => Pick<LaunchRecords, "markTold" | "dropped"> | null,
): AwarenessSubscriber<LaunchNotice> {
	return {
		source: LAUNCH_NOTICE_SOURCE,
		pushAfterMs: 0,
		act: (_sessionKey, _pre, post) => (post?.kind === "failed" ? "act_now" : "no_act"),
		push: (_sessionKey, _pre, post) => post?.kind === "up",
		render: (_sessionKey, changes) =>
			changes.flatMap((change) => (change.post ? [launchNoticeText(change.post)] : [])).join("\n\n"),
		delivered: (sessionKey, change) => records()?.markTold(change.identity, sessionKey),
		dropped: (sessionKey, change) => records()?.dropped(change.identity, sessionKey),
	};
}

export function createLaunchRecords(deps: LaunchRecordsDeps): LaunchRecords {
	let records: LaunchRecord[] = restore(deps.durable.load());
	const relaying = new Set<string>();
	/** Away senders by flight, until next ask. */
	const away = new Map<string, number>();
	/** Host link each cancel reached. */
	const cancelledOn = new Map<string, object>();
	let markTold: LaunchRecords["markTold"] = () => {};

	function restore(raw: unknown): LaunchRecord[] {
		const parsed = z.array(RecordSchema).safeParse(raw);
		return parsed.success ? parsed.data : [];
	}

	function expired(record: LaunchRecord, now: number): boolean {
		const from = deps.countdownFrom(record.team);
		return from !== null && now - Math.max(record.startedAt, from) >= deps.timeoutMs;
	}

	const commit = (next: LaunchRecord[]): boolean =>
		commitChecked(
			deps.durable,
			next,
			(landed) => {
				records = landed;
			},
			{ label: "launches" },
		).landed;

	const replace = (record: LaunchRecord, next: LaunchRecord): LaunchRecord[] =>
		records.map((held) => (held === record ? next : held));

	function settleRecord(record: LaunchRecord, stage: LaunchRecord["stage"]): void {
		if (record.stage.kind !== "launching") return;
		const settled: LaunchRecord = { ...record, stage, settledAt: deps.now() };
		if (!commit(replace(record, settled))) return;
		if (stage.kind !== "failed") return;
		cancelGivenUp(settled);
		// Nothing reached the session.
		for (const requester of record.requesters) for (const delivery of requester.deliveries) deps.withdraw(delivery);
		if (record.created) deps.forgetCreated(record.team);
	}

	const givenUp = (record: LaunchRecord): boolean => record.created && record.stage.kind === "failed";

	/** Once per host link. */
	function cancelGivenUp(record: LaunchRecord): void {
		if (!givenUp(record)) return;
		const link = deps.hostLink();
		const identity = identityOf(record);
		if (!link || cancelledOn.get(identity) === link) return;
		if (deps.cancel(record.team)) cancelledOn.set(identity, link);
	}

	const requesterOf = (input: LaunchJoin): LaunchRecord["requesters"][number] => ({
		sessionKey: input.sessionKey,
		...(input.relay ? { relay: input.relay } : {}),
		deliveries: [input.delivery],
		told: false,
		foreign: input.foreign,
	});

	const api: LaunchRecords = {
		join(input) {
			const active = records.find((record) => record.team === input.team && record.stage.kind === "launching");
			if (!active) {
				const fresh: LaunchRecord = {
					team: input.team,
					address: input.address,
					created: input.created,
					startedAt: deps.now(),
					stage: { kind: "launching" },
					requesters: [requesterOf(input)],
				};
				return commit([...records, fresh]);
			}
			const held = active.requesters.find((requester) => requester.sessionKey === input.sessionKey);
			const requesters = held
				? active.requesters.map((requester) =>
						requester === held ? { ...held, deliveries: [...held.deliveries, input.delivery] } : requester,
					)
				: [...active.requesters, requesterOf(input)];
			return commit(replace(active, { ...active, created: active.created || input.created, requesters }));
		},

		settle(team, outcome) {
			if (!outcome) return;
			const active = records.find((record) => record.team === team && record.stage.kind === "launching");
			if (!active) return;
			settleRecord(active, "up" in outcome ? { kind: "up" } : { kind: "failed", failure: outcome.failure });
		},

		tick() {
			const now = deps.now();
			for (const record of [...records]) {
				if (record.stage.kind !== "launching") continue;
				// Read each tick, so a restart mid-launch still settles.
				if (deps.isLive(record.team)) settleRecord(record, { kind: "up" });
				else if (!deps.inFlight(record.team) && expired(record, now)) {
					settleRecord(record, { kind: "failed", failure: { kind: "timeout" } });
				}
			}
			for (const record of records) cancelGivenUp(record);
			const kept = records.filter(
				(record) =>
					record.stage.kind === "launching" ||
					((record.requesters.some((requester) => !requester.told) ||
						(givenUp(record) && !cancelledOn.has(identityOf(record)))) &&
						now - (record.settledAt ?? now) < SETTLED_HOLD_MS),
			);
			if (kept.length !== records.length) {
				for (const record of records) {
					if (kept.includes(record)) continue;
					cancelledOn.delete(identityOf(record));
					for (const requester of record.requesters)
						away.delete(`${identityOf(record)}\n${requester.sessionKey}`);
				}
				commit(kept);
			}
			const observations: AwarenessObservation<LaunchNotice>[] = [];
			for (const record of records) {
				const identity = identityOf(record);
				for (const requester of record.requesters) {
					if (requester.told) continue;
					const post = noticeOf(record, requester.foreign);
					if (!post) continue;
					const flight = `${identity}\n${requester.sessionKey}`;
					if (!requester.relay) {
						const until = away.get(flight);
						if (until !== undefined && until > now) continue;
						away.delete(flight);
						observations.push({ sessionKey: requester.sessionKey, identity, pre: undefined, post });
						continue;
					}
					if (relaying.has(flight)) continue;
					relaying.add(flight);
					const key = requester.sessionKey;
					void deps
						.relay(requester.relay, post)
						.catch(() => false)
						.then((took) => {
							relaying.delete(flight);
							if (took) markTold(identity, key);
						});
				}
			}
			if (observations.length > 0) deps.observe(observations);
		},

		markTold(identity, sessionKey) {
			const record = records.find((held) => identityOf(held) === identity);
			if (!record) return;
			const requesters = record.requesters.map((requester) =>
				requester.sessionKey === sessionKey ? { ...requester, told: true } : requester,
			);
			commit(replace(record, { ...record, requesters }));
		},

		dropped(identity, sessionKey) {
			// Forgotten sender skipped; reconnecting one asked again.
			if (!deps.senderKnown(sessionKey)) api.markTold(identity, sessionKey);
			else away.set(`${identity}\n${sessionKey}`, deps.now() + AWAY_RETRY_MS);
		},
	};
	markTold = api.markTold;
	return api;
}
