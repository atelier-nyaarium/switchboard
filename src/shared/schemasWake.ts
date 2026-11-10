// What the daemon tells the Gateway about a wake as it runs.

import { z } from "zod";
import { SESSION_HARNESSES } from "./session-harness.js";

////////////////////////////////
//  Constants

/** A container build stops the countdown; it starts at `container_up`. */
export const WAKE_STAGES = ["building", "container_up", "cli_found"] as const;

////////////////////////////////
//  Interfaces & Types

export const WakeStageFrameSchema = z.object({
	type: z.literal("wake_stage"),
	team: z.string().min(1).max(256),
	stage: z.enum(WAKE_STAGES),
	/** With `cli_found`. */
	harness: z.enum(SESSION_HARNESSES).optional(),
});

export type WakeStage = (typeof WAKE_STAGES)[number];
export type WakeStageFrame = z.infer<typeof WakeStageFrameSchema>;
