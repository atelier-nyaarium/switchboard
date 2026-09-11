// The flush every writer takes part in, and the tick that runs it.

import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import { createPersistRunner } from "../../shared/durable-store.js";
import { fenced, MIGRATION_SETTLE_MS } from "../../shared/migration-fence.js";
import { fireAndForget } from "../fireAndForget.js";
import { resolveLiveIncarnation } from "../wsTypes.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { FederationContext } from "./federationContext.js";

const SESSION_RESUME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_RESUME_ENTRIES = 2_000;

export interface PersistenceStageDeps {
	ambient: Pick<Ambient, "now" | "setInterval">;
	stores: Pick<
		StoresStage,
		| "jobs"
		| "jobsDurable"
		| "durableOpStore"
		| "boardReplays"
		| "capabilityStore"
		| "blobStore"
		| "maxBlobStoreBytes"
		| "sessionResumeDurable"
	>;
	sessions: Pick<SessionsStage, "sessionStore" | "registry" | "presence" | "sessionResumeSnapshot">;
	context: FederationContext;
	/** Swept sessions end like closed ones. */
	sessionEnded?: (team: string) => void;
	/**
	 * Whether a routine reserves that session. Read late, since routines compose after this. A
	 * reserved record is a reachability root: sweeping it leaves the routine unable to reach a
	 * session whose shell is still there, holding a token this gateway no longer knows.
	 */
	reservedByRoutine?: (team: string) => boolean;
	/** After sockets; reports expiries. */
	sweepDeliveries?: () => number | undefined;
	/** Queued data names bytes. */
	namesBlob?: (blobId: string) => boolean;
	// Remove-by: 2026-09-25, with the blob migration route; the age sweep then always runs.
	/** False while a migration may still need every local blob. */
	ageStaging?: boolean;
}

/** Unreferenced staging lifetime. */
const STAGED_BLOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PersistenceStage {
	/** Runs every writer's step in order. A clean shutdown writes checked snapshots. */
	persistDelivery: (cleanShutdown: boolean) => void;
	persistTimer: IntervalHandle;
}

export function composePersistence({
	ambient,
	stores,
	sessions,
	context,
	sessionEnded,
	reservedByRoutine,
	sweepDeliveries,
	namesBlob,
	ageStaging = true,
}: PersistenceStageDeps): PersistenceStage {
	const runPersistSteps = createPersistRunner();
	const persistDelivery = (cleanShutdown: boolean) =>
		runPersistSteps([
			{
				name: "pending-jobs",
				run: () =>
					cleanShutdown
						? stores.jobsDurable.saveChecked(stores.jobs.snapshot())
						: stores.jobsDurable.save(stores.jobs.snapshot()),
			},
			{
				name: "session-sweep",
				run: () => {
					const sweptTeams = sessions.sessionStore.sweep(SESSION_RESUME_TTL_MS, {
						maxEntries: MAX_SESSION_RESUME_ENTRIES,
						isLive: (team) =>
							resolveLiveIncarnation(sessions.registry, sessions.sessionStore, team) !== undefined ||
							reservedByRoutine?.(team) === true,
					});
					if (sweptTeams.length === 0) return;
					for (const team of sweptTeams) {
						const released = context.slice()?.boardClient.sessionEnded(team, "release");
						if (released) fireAndForget(`board release for ${team}`, released);
						sessionEnded?.(team);
					}
					sessions.presence.markDirty();
				},
			},
			{ name: "op-idempotency-sweep", run: () => stores.durableOpStore.sweep() },
			{ name: "board-idempotency-sweep", run: () => stores.boardReplays.sweep() },
			{ name: "console-capabilities-sweep", run: () => stores.capabilityStore.sweep() },
			{
				name: "delivery-sweep",
				run: () => {
					const expired = sweepDeliveries?.() ?? 0;
					if (expired > 0) console.log(`[delivery] ${expired} held message(s) expired unread`);
				},
			},
			{
				name: "blob-sweep",
				run: () => {
					const freed = stores.blobStore.sweep({
						maxBytes: stores.maxBlobStoreBytes,
						...(ageStaging ? { completeMaxAgeMs: STAGED_BLOB_MAX_AGE_MS } : {}),
						keep: (blobId) => namesBlob?.(blobId) ?? true,
					});
					if (freed > 0) console.error(`[blobs] swept ${freed} bytes`);
				},
			},
			{
				name: "session-resume",
				run: () =>
					cleanShutdown
						? stores.sessionResumeDurable.saveChecked(sessions.sessionResumeSnapshot(cleanShutdown))
						: stores.sessionResumeDurable.save(sessions.sessionResumeSnapshot(cleanShutdown)),
			},
			{ name: "replay-guard", run: () => context.slice()?.replayPersist() },
		]);

	// Shutdown flush persists under the fence. Shut down before cutting.
	let fencedSince: number | null = null;
	let settled = false;
	const persistTimer = ambient.setInterval(() => {
		if (!fenced()) {
			fencedSince = null;
			settled = false;
			persistDelivery(false);
			return;
		}
		fencedSince ??= ambient.now();
		if (settled || ambient.now() - fencedSince < MIGRATION_SETTLE_MS) return;
		settled = true;
		const dropped = stores.durableOpStore.failInFlight(true);
		console.log(`[migration] settled: ${dropped} in-flight op(s) dropped for the client to re-run`);
	}, 3_000);

	return { persistDelivery, persistTimer };
}
