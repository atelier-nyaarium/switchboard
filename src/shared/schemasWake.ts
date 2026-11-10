// What the daemon tells the Gateway about a wake as it runs.

import { z } from "zod";
import { SESSION_HARNESSES } from "./session-harness.js";

////////////////////////////////
//  Constants

/** A container build stops the countdown; it starts at `container_up`. */
export const WAKE_STAGES = ["building", "container_up", "cli_found"] as const;

////////////////////////////////
//  Interfaces & Types

/** Minted by the Gateway per launch; every frame about the launch names it. */
export const LaunchIdSchema = z.string().min(8).max(64);

const Team = z.string().min(1).max(256);

// FIXME 2026-11-24: `launchId` required on every frame, once every daemon and Gateway names it.
export const WakeStageFrameSchema = z.object({
	type: z.literal("wake_stage"),
	team: Team,
	launchId: LaunchIdSchema.optional(),
	stage: z.enum(WAKE_STAGES),
	/** With `cli_found`. */
	harness: z.enum(SESSION_HARNESSES).optional(),
	/** Session id it launched under. */
	sessionId: z.string().max(128).optional(),
});

export const WakeResultFrameSchema = z.object({
	type: z.literal("wake_result"),
	team: Team,
	launchId: LaunchIdSchema.optional(),
	success: z.boolean(),
	error: z.string().optional(),
	/** Parsed alone; an unknown kind drops the reason only. */
	failure: z.unknown().optional(),
});

/** Gateway to daemon: the launch was given up. */
export const WakeCancelFrameSchema = z.object({
	type: z.literal("wake_cancel"),
	team: Team,
	launchId: LaunchIdSchema.optional(),
});

/** Gateway to daemon: a result landed; stop replaying it. */
export const WakeResultAckFrameSchema = z.object({
	type: z.literal("wake_result_ack"),
	launchId: LaunchIdSchema,
});

export type WakeStage = (typeof WAKE_STAGES)[number];
export type WakeStageFrame = z.infer<typeof WakeStageFrameSchema>;
export type WakeResultFrame = z.infer<typeof WakeResultFrameSchema>;
export type WakeCancelFrame = z.infer<typeof WakeCancelFrameSchema>;
