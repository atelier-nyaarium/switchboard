// The one sweep's route: its path, its request and what it answers.

import { z } from "zod";
import type { AgentBackendId } from "./agent-backend.js";

////////////////////////////////
//  Constants

/** Host token only, like a retire. */
export const PURGE_SWEEP_PATH = "/purge/sweep";

/** A dry run unless `apply` names the fingerprint a dry run showed. */
export const PurgeSweepRequestSchema = z
	.object({ apply: z.boolean().optional(), expect: z.string().min(1).max(64).optional() })
	.strict();

////////////////////////////////
//  Interfaces & Types

/** One backend's store at one place. */
export interface SweepRow {
	/** `host`, or a container's project. */
	place: string;
	backend: AgentBackendId;
	listed: number;
	/** A roster session's own conversation, and what it spawned. */
	kept: number;
	/** A turn runs, or a running workflow names it. */
	running: number;
	/** No record names it and its store does not say it is at rest. */
	unreadable: number;
	/** Threads an agent record names. Their agents end first. */
	agents: number;
	/** Threads no record names. */
	unnamed: number;
	/**
	 * A session's own CLI runs here and may have moved to another conversation, so unnamed threads touched
	 * since this time are left. 0 leaves them all.
	 */
	liveSince?: number;
	/** The store could not be listed, so nothing here is swept. */
	error?: string;
}

/** What earlier forgets left in the Gateway's own stores. */
export interface SweepOrphans {
	claims: number;
	jobs: number;
}

/** The names behind a `SweepOrphans` count. */
export interface SweepOrphanNames {
	claims: string[];
	teams: string[];
	jobs: number;
}

export interface SweepPlan {
	rows: SweepRow[];
	/** Containers not swept: not running, or absent from the daemon's catalog. */
	stopped: string[];
	/** Host spawn points whose stores are not listed, and so not swept. */
	unreached: string[];
	orphans: SweepOrphans;
	/** Names the exact set an apply would delete. */
	fingerprint: string;
}

export type SweepAnswer =
	| { applied: false; reason: "dry_run" | "changed" | "no_daemon"; plan?: SweepPlan }
	| { applied: true; plan: SweepPlan; queued: number; ended: number; orphans: SweepOrphans };
