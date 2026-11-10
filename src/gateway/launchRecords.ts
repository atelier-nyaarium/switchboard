// Launch stages and requesters.

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

const RoutineRunSchema = z.object({ routineId: z.string(), scheduledAt: z.number() });

const RecordSchema = z.object({
	team: z.string(),
	/** Absent on a launch no send joined. */
	address: z.string().optional(),
	// FIXME 2026-11-24: required, once no record predates it.
	launchId: z.string().optional(),
	created: z.boolean(),
	/** The owner asked for it: never given up or forgotten. */
	retained: z.literal(true).optional(),
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
			/** Told by a thread line. */
			owner: z.literal(true).optional(),
			/** A routine run waiting on it. */
			routine: RoutineRunSchema.optional(),
			deliveries: z.array(DeliverySchema),
			told: z.boolean(),
			foreign: z.boolean(),
		}),
	),
});

export type LaunchDelivery = z.infer<typeof DeliverySchema>;
export type LaunchRelay = z.infer<typeof RelaySchema>;
export type LaunchRecord = z.infer<typeof RecordSchema>;
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export interface LaunchJoin {
	team: string;
	address: string;
	launchId?: string;
	created: boolean;
	sessionKey: string;
	relay?: LaunchRelay;
	owner?: true;
	routine?: RoutineRun;
	/** Absent when only the outcome is owed. */
	delivery?: LaunchDelivery;
	foreign: boolean;
}

export interface LaunchRecordsDeps {
	durable: Pick<DurableStore, "saveChecked" | "load">;
	now(): number;
	/** How long a launch may take before it reads as never up. */
	timeoutMs: number;
	/** Countdown start; null while building. */
	countdownFrom(team: string, launchId?: string): number | null;
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
	cancel(team: string, launchId?: string): boolean;
	observe(observations: readonly AwarenessObservation<LaunchNotice>[]): void;
	/** Tells a relayed send's Gateway; true once it took it. */
	relay(relay: LaunchRelay, notice: LaunchNotice): Promise<boolean>;
	/** Thread line; true once stored. */
	tellOwner(team: string, outcome: LaunchOutcome, identity: string): boolean;
	/** True once the run took it. */
	tellRoutine(run: RoutineRun, outcome: LaunchOutcome, team: string): boolean;
}

export type LaunchOutcome = { up: true } | { failure: LaunchFailure };

export interface LaunchRecords {
	/** Before dispatch; false when it could not be written. */
	open(team: string, launchId: string, created: boolean, retained: boolean): boolean;
	/** False when it could not be written; nothing changed. */
	join(input: LaunchJoin): boolean;
	/** False when it could not be written. */
	retain(launchId: string): boolean;
	settle(team: string, outcome: LaunchOutcome | undefined, launchId?: string): void;
	tick(): void;
	markTold(identity: string, sessionKey: string): void;
	/** The bank gave a notice up undelivered. */
	dropped(identity: string, sessionKey: string): void;
	/** A launch of the team still unsettled. */
	launching(team: string): boolean;
	/** A run still owed its launch's end. */
	awaits(run: RoutineRun): boolean;
	/** Never dispatched; nothing to settle. */
	abandon(launchId: string): void;
}

////////////////////////////////
//  Constants

/** A settled launch whose senders never took their notice. */
const SETTLED_HOLD_MS = 30 * 60_000;

/** The owner's requester on any launch. */
export const OWNER_LAUNCH_KEY = "owner";

/** Between asks of a sender that is away. */
export const AWAY_RETRY_MS = 30_000;

////////////////////////////////
//  Functions & Helpers

const identityOf = (record: LaunchRecord): string =>
	`launch:${record.launchId ?? `${record.team}:${record.startedAt}`}`;

/** Untagged side matches its team. */
const holds = (record: LaunchRecord, team: string, launchId: string | undefined): boolean =>
	record.team === team && (launchId === undefined || record.launchId === undefined || record.launchId === launchId);

function noticeOf(record: LaunchRecord, foreign: boolean): LaunchNotice | undefined {
	const address = record.address ?? record.team;
	if (record.stage.kind === "up") return { kind: "up", address };
	if (record.stage.kind === "failed") {
		return {
			kind: "failed",
			address,
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
	// A dropped link or a waiter's timeout proves nothing; the countdown decides.
	if (result.errorKind === "disconnected" || result.errorKind === "timeout") return undefined;
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
		const from = deps.countdownFrom(record.team, record.launchId);
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
		if (record.created && !record.retained) deps.forgetCreated(record.team);
	}

	/** Owner claim keeps running launches. */
	const retainTeam = (held: LaunchRecord[], team: string): LaunchRecord[] =>
		held.map((record) =>
			record.team === team && record.stage.kind === "launching" && !record.retained
				? { ...record, retained: true as const }
				: record,
		);

	const givenUp = (record: LaunchRecord): boolean =>
		record.created && !record.retained && record.stage.kind === "failed";

	/** Once per host link. */
	function cancelGivenUp(record: LaunchRecord): void {
		if (!givenUp(record)) return;
		const link = deps.hostLink();
		const identity = identityOf(record);
		if (!link || cancelledOn.get(identity) === link) return;
		if (deps.cancel(record.team, record.launchId)) cancelledOn.set(identity, link);
	}

	const requesterOf = (input: LaunchJoin): LaunchRecord["requesters"][number] => ({
		sessionKey: input.sessionKey,
		...(input.relay ? { relay: input.relay } : {}),
		...(input.owner ? { owner: true as const } : {}),
		...(input.routine ? { routine: input.routine } : {}),
		deliveries: input.delivery ? [input.delivery] : [],
		told: false,
		foreign: input.foreign,
	});

	/** Own launch first, then untagged. */
	const launchingFor = (team: string, launchId: string | undefined): LaunchRecord | undefined => {
		const launching = records.filter(
			(record) => record.stage.kind === "launching" && holds(record, team, launchId),
		);
		return launching.find((record) => record.launchId === launchId) ?? launching[0];
	};

	const api: LaunchRecords = {
		open(team, launchId, created, retained) {
			const fresh: LaunchRecord = {
				team,
				// Older restore requires it.
				address: team,
				launchId,
				created,
				startedAt: deps.now(),
				stage: { kind: "launching" },
				requesters: [],
			};
			const opened = [...records, fresh];
			return commit(retained ? retainTeam(opened, team) : opened);
		},

		retain(launchId) {
			const record = records.find((held) => held.launchId === launchId);
			if (!record) return true;
			return commit(retainTeam(records, record.team));
		},

		join(input) {
			const active = launchingFor(input.team, input.launchId);
			// Settled before its join; still answers.
			const ended =
				active || !input.launchId
					? undefined
					: records.find((r) => r.launchId === input.launchId && r.team === input.team);
			if (ended) {
				const held = ended.requesters.find((requester) => requester.sessionKey === input.sessionKey);
				const requesters = held
					? ended.requesters.map((requester) =>
							requester === held && input.delivery
								? { ...held, deliveries: [...held.deliveries, input.delivery] }
								: requester,
						)
					: [...ended.requesters, requesterOf(input)];
				if (!commit(replace(ended, { ...ended, requesters }))) return false;
				if (ended.stage.kind === "failed" && input.delivery) deps.withdraw(input.delivery);
				return true;
			}
			// A watch alone never invents a launch.
			if (!active && !input.launchId && !input.delivery) return false;
			if (!active) {
				const fresh: LaunchRecord = {
					team: input.team,
					address: input.address,
					...(input.launchId ? { launchId: input.launchId } : {}),
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
						requester === held && input.delivery
							? { ...held, deliveries: [...held.deliveries, input.delivery] }
							: requester,
					)
				: [...active.requesters, requesterOf(input)];
			// Holds team until a send names the address.
			const address = active.address && active.address !== active.team ? active.address : input.address;
			const created = active.created || input.created;
			return commit(replace(active, { ...active, address, created, requesters }));
		},

		settle(team, outcome, launchId) {
			if (!outcome) return;
			const active = launchingFor(team, launchId);
			if (!active) return;
			// A registered session is up, whatever followed.
			if ("up" in outcome || deps.isLive(team)) settleRecord(active, { kind: "up" });
			else settleRecord(active, { kind: "failed", failure: outcome.failure });
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
				const pruned = records.filter((record) => !kept.includes(record));
				// Memory follows disk, or cancels resend.
				if (commit(kept)) {
					for (const record of pruned) {
						cancelledOn.delete(identityOf(record));
						for (const requester of record.requesters)
							away.delete(`${identityOf(record)}\n${requester.sessionKey}`);
					}
				}
			}
			const observations: AwarenessObservation<LaunchNotice>[] = [];
			for (const record of records) {
				const identity = identityOf(record);
				for (const requester of record.requesters) {
					if (requester.told) continue;
					const post = noticeOf(record, requester.foreign);
					if (!post) continue;
					const flight = `${identity}\n${requester.sessionKey}`;
					const outcome: LaunchOutcome =
						record.stage.kind === "failed" ? { failure: record.stage.failure } : { up: true };
					if (requester.owner) {
						if (deps.tellOwner(record.team, outcome, identity)) markTold(identity, requester.sessionKey);
						continue;
					}
					if (requester.routine) {
						if (deps.tellRoutine(requester.routine, outcome, record.team))
							markTold(identity, requester.sessionKey);
						continue;
					}
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

		launching(team) {
			return records.some((record) => record.team === team && record.stage.kind === "launching");
		},

		awaits(run) {
			return records.some((record) =>
				record.requesters.some(
					(requester) =>
						!requester.told &&
						requester.routine?.routineId === run.routineId &&
						requester.routine.scheduledAt === run.scheduledAt,
				),
			);
		},

		abandon(launchId) {
			const kept = records.filter(
				(record) =>
					record.launchId !== launchId || record.stage.kind !== "launching" || record.requesters.length > 0,
			);
			if (kept.length !== records.length) commit(kept);
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
