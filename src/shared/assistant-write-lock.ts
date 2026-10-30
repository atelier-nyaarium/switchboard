// The assistant's write lock: open while the owner is around, locked once it acts alone.

import { z } from "zod";

export const ASSISTANT_WRITE_LOCK_PATH = "/assistant/write-lock";

/** Owner away this long locks writes. */
export const WRITE_IDLE_MS = 30 * 60_000;

export const WriteLockAnswerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("open") }),
	/** Null: nothing from the owner since it started. */
	z.object({ kind: z.literal("locked"), idleMs: z.number().int().nonnegative().nullable() }),
	z.object({ kind: z.literal("not_assistant") }),
	z.object({ kind: z.literal("unauthenticated") }),
]);

export type WriteLockAnswer = z.infer<typeof WriteLockAnswerSchema>;

export type WriteLock = Extract<WriteLockAnswer, { kind: "open" | "locked" }>;
