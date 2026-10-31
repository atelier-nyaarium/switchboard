// What a session holds through Switchboard, re-sent after its context is compacted.

import { z } from "zod";

////////////////////////////////
//  Constants

export const SESSION_BASELINE_PATH = "/session/baseline";

/** The whole block, under Claude Code's 10,000 for hook context. */
export const MAX_BASELINE_CHARS = 9_000;

////////////////////////////////
//  Schemas

const PeerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("owner") }),
	z.object({ kind: z.literal("session"), name: z.string() }),
]);

export const SessionBaselineSchema = z.object({
	/** Addressed to this session, newest first. */
	conversations: z.array(z.object({ sessionId: z.string(), peer: PeerSchema })),
	/** Null when the Router could not be read. */
	board: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				state: z.string(),
				parent: z.string().optional(),
			}),
		)
		.nullable(),
	routines: z.array(z.object({ occurrenceId: z.string(), routine: z.string() })),
	/** With a turn running. */
	agents: z.array(z.object({ family: z.enum(["codex", "copilot"]), agentId: z.string() })),
	/** The assistant's session alone. */
	assistant: z
		.object({
			/** Optional for Gateway compatibility. */
			hold: z
				.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("held"),
						/** Holder's device name. */
						label: z.string(),
						remainingMs: z.number().int().nonnegative(),
					}),
					z.object({
						kind: z.literal("lapsed"),
						label: z.string(),
						lapsedMs: z.number().int().nonnegative(),
					}),
					z.object({ kind: z.literal("none") }),
				])
				.optional(),
			watchers: z.array(
				z.object({
					label: z.string(),
					unread: z.number().int().nonnegative(),
					/** More unread than a poll reads. */
					capped: z.boolean().optional(),
					/** False until a poll has read the count; absent from an older Gateway. */
					checked: z.boolean().optional(),
					// Sent as 0 for older plugins; remove 2026-11-02.
					evicted: z.number().int().nonnegative().optional(),
					stopped: z.string().optional(),
					waiting: z.string().optional(),
				}),
			),
		})
		.optional(),
});
export type SessionBaseline = z.infer<typeof SessionBaselineSchema>;
