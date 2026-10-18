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
			watchers: z.array(
				z.object({
					label: z.string(),
					unread: z.number().int().nonnegative(),
					evicted: z.number().int().nonnegative(),
					stopped: z.string().optional(),
					waiting: z.string().optional(),
				}),
			),
		})
		.optional(),
});
export type SessionBaseline = z.infer<typeof SessionBaselineSchema>;
