import type { z } from "zod";
import { mintEpoch } from "../../shared/epoch.js";
import { MAX_STREAMS_PER_OWNER, mergeReadAnchor, type ReadAnchorEntry } from "../../shared/read-anchor-rules.js";
import { ReadAnchorsResultSchema } from "../../shared/schemasTier1.js";
import { Address, parseQualifiedTarget } from "../../shared/session-id.js";
import { foldWriteResult } from "../../shared/write-result.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { StateRecord } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

export interface ReadAnchorsServiceDeps {
	registry: OwnerStoreRegistry;
	/** Whether a Gateway still reports the session. Absent sweeps nothing. */
	reported?: (domainId: string, gatewayId: string, sessionId: string) => boolean;
	pokeOwner?: (domainId: string, result: ReadAnchorsResult) => void;
}

type ReadAnchorsResult = z.infer<typeof ReadAnchorsResultSchema>;

// Keep version outside streams.
const VERSION_ID = "readAnchor.version";
const anchorId = (stream: string): string => `readAnchor:${stream}`;
const SCHEDULED_STREAM = "scheduled:";
/** A session's conversation, and its scheduled results. */
const sessionStreams = (sessionTarget: string): string[] => [sessionTarget, `${SCHEDULED_STREAM}${sessionTarget}`];
/** An anchor of a session no Gateway reports goes once unreported this long. */
export const ORPHAN_ANCHOR_MS = 24 * 60 * 60 * 1000;

/** The session a stream names; undefined for any other stream. */
function sessionOfStream(stream: string): Address | undefined {
	const target = stream.startsWith(SCHEDULED_STREAM) ? stream.slice(SCHEDULED_STREAM.length) : stream;
	try {
		const parsed = parseQualifiedTarget(target);
		return parsed instanceof Address ? parsed : undefined;
	} catch {
		return undefined;
	}
}
const write = (result: Parameters<typeof foldWriteResult>[0]) => foldWriteResult(result);

export function createReadAnchorsService(deps: ReadAnchorsServiceDeps) {
	const ensureVersion = (domainId: string): StateRecord | { outcome: ReturnType<typeof write>["outcome"] } => {
		const store = deps.registry.for(domainId);
		const current = store.get("readAnchor", VERSION_ID);
		if (current) return current;
		const result = write(
			store.put("readAnchor", VERSION_ID, null, {
				clear: { epoch: mintEpoch(), version: 0 },
			}),
		);
		if (!result.applied) return { outcome: result.outcome } as never;
		return store.get("readAnchor", VERSION_ID) as StateRecord;
	};

	const read = (domainId: string): ReadAnchorsResult => {
		const store = deps.registry.for(domainId);
		const version = ensureVersion(domainId);
		if ("outcome" in version) return version as never;
		return ReadAnchorsResultSchema.parse({
			version: { epoch: Number(version.clear.epoch), version: Number(version.clear.version) },
			anchors: store
				.list("readAnchor")
				.filter((record) => record.id !== VERSION_ID)
				.map((record) => ({ stream: record.id.slice("readAnchor:".length), ...record.clear }))
				.sort((a, b) => a.stream.localeCompare(b.stream)),
		});
	};

	const reportResult = (domainId: string, stream: string, entry: ReadAnchorEntry) => {
		const store = deps.registry.for(domainId);
		const version = ensureVersion(domainId);
		if ("outcome" in version) return version as never;
		const currentRecords = store.list("readAnchor").filter((record) => record.id !== VERSION_ID);
		const state: Record<string, Record<string, ReadAnchorEntry>> = {
			[domainId]: Object.fromEntries(
				currentRecords.map((record) => [
					record.id.slice("readAnchor:".length),
					record.clear as unknown as ReadAnchorEntry,
				]),
			),
		};
		const merged = mergeReadAnchor(state, domainId, stream, entry);
		if (!merged.advanced) {
			if (!state[domainId][stream] && currentRecords.length >= MAX_STREAMS_PER_OWNER)
				throw new OwnerOpRefused("read-anchor stream limit");
			return { advanced: false, outcome: "accepted" as const };
		}
		const current = store.get("readAnchor", anchorId(stream));
		const nextVersion = Number(version.clear.version) + 1;
		const result = store.batch((tx) => {
			tx.put("readAnchor", anchorId(stream), current?.version ?? null, {
				clear: merged.state[domainId][stream] as unknown as Record<string, unknown>,
			});
			tx.put("readAnchor", VERSION_ID, version.version, {
				clear: { epoch: version.clear.epoch, version: nextVersion },
			});
		});
		const folded = write(result);
		if (!folded.applied) return { advanced: false, outcome: folded.outcome };
		return { advanced: true, outcome: folded.outcome };
	};
	const report = (domainId: string, stream: string, entry: ReadAnchorEntry): boolean =>
		reportResult(domainId, stream, entry).advanced;

	/** One write, with a version advance a reader takes as it takes a report. False when it did not land. */
	const drop = (domainId: string, held: StateRecord[]): boolean => {
		if (held.length === 0) return true;
		const store = deps.registry.for(domainId);
		const version = ensureVersion(domainId);
		if ("outcome" in version) return false;
		const dropped = write(
			store.batch((tx) => {
				for (const record of held) tx.del("readAnchor", record.id, record.version);
				tx.put("readAnchor", VERSION_ID, version.version, {
					clear: { epoch: version.clear.epoch, version: Number(version.clear.version) + 1 },
				});
			}),
		);
		if (!dropped.applied) return false;
		deps.pokeOwner?.(domainId, read(domainId));
		return true;
	};

	/** Deletes the anchors of every stream that names a session. False asks for another try. */
	const forgetSession = (domainId: string, sessionTarget: string): boolean => {
		const store = deps.registry.for(domainId);
		return drop(
			domainId,
			sessionStreams(sessionTarget)
				.map((stream) => store.get("readAnchor", anchorId(stream)))
				.filter((record): record is StateRecord => record !== null),
		);
	};

	/** Anchors of this Domain's sessions that no Gateway reports, a day past their last report. */
	const sweepOrphans = (domainId: string, now: number): number => {
		const reported = deps.reported;
		if (!reported) return 0;
		const store = deps.registry.for(domainId);
		if (store.health().quarantined) return 0;
		const orphaned = store.list("readAnchor").filter((record) => {
			if (record.id === VERSION_ID) return false;
			const session = sessionOfStream(record.id.slice("readAnchor:".length));
			// A friend's shared session is its own Domain's to report.
			if (!session || session.domain !== domainId) return false;
			if (now - Number(record.clear.at) < ORPHAN_ANCHOR_MS) return false;
			return !reported(domainId, session.gateway, `${session.spawn}.${session.session}`);
		});
		return drop(domainId, orphaned) ? orphaned.length : 0;
	};

	return {
		report,
		read,
		forgetSession,
		sweepOrphans,
		register(hooks: OwnerServiceHooks): void {
			hooks.ownerOp("report_read", async (op, value) => {
				// Router stamps time; epochs use equality, never ordering.
				const at = deps.registry.now();
				const result = reportResult(op.domainId, value.stream, { ...value, at });
				if ("advanced" in result) deps.pokeOwner?.(op.domainId, read(op.domainId));
				return result;
			});
			hooks.ownerOp("read_anchors_read", async (op) => read(op.domainId));
			hooks.onSessionForgotten((reg, sessionId) =>
				forgetSession(reg.domainId, `${reg.domainId}.${reg.gatewayId}.${sessionId}`),
			);
			hooks.onSweep("orphan read anchor sweep", (domainId, now) => {
				sweepOrphans(domainId, now);
			});
		},
	};
}
