import type { z } from "zod";
import { mintEpoch } from "../../shared/epoch.js";
import { MAX_STREAMS_PER_OWNER, mergeReadAnchor, type ReadAnchorEntry } from "../../shared/read-anchor-rules.js";
import { ReadAnchorsResultSchema } from "../../shared/schemasTier1.js";
import { foldWriteResult } from "../../shared/write-result.js";
import { OwnerOpRefused } from "../inbox/ownerOpIntake.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { StateRecord } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";

export interface ReadAnchorsServiceDeps {
	registry: OwnerStoreRegistry;
	pokeOwner?: (domainId: string, result: ReadAnchorsResult) => void;
}

type ReadAnchorsResult = z.infer<typeof ReadAnchorsResultSchema>;

// Keep version outside streams.
const VERSION_ID = "readAnchor.version";
const anchorId = (stream: string): string => `readAnchor:${stream}`;
/** A session's conversation, and its scheduled results. */
const sessionStreams = (sessionTarget: string): string[] => [sessionTarget, `scheduled:${sessionTarget}`];
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

	/** Deletes the anchors of every stream that names a session. False asks for another try. */
	const forgetSession = (domainId: string, sessionTarget: string): boolean => {
		const store = deps.registry.for(domainId);
		const held = sessionStreams(sessionTarget)
			.map((stream) => store.get("readAnchor", anchorId(stream)))
			.filter((record): record is StateRecord => record !== null);
		if (held.length === 0) return true;
		const version = ensureVersion(domainId);
		if ("outcome" in version) return false;
		const dropped = write(
			store.batch((tx) => {
				for (const record of held) tx.del("readAnchor", record.id, record.version);
				// A reader takes the removal as it takes a report.
				tx.put("readAnchor", VERSION_ID, version.version, {
					clear: { epoch: version.clear.epoch, version: Number(version.clear.version) + 1 },
				});
			}),
		);
		if (!dropped.applied) return false;
		deps.pokeOwner?.(domainId, read(domainId));
		return true;
	};

	return {
		report,
		read,
		forgetSession,
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
		},
	};
}
