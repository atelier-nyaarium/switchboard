// Launcher status for the daemon, in an owner-only file.

import { z } from "zod";

const Pid = z.number().int().positive();

export const LaunchStatusSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("starting"), pid: Pid }),
	z.object({ state: z.literal("ready"), pid: Pid, version: z.string().max(64) }),
	z.object({ state: z.literal("failed"), pid: Pid, error: z.string().max(2048) }),
	z.object({ state: z.literal("exited"), pid: Pid, code: z.number().int() }),
]);

export type LaunchStatus = z.infer<typeof LaunchStatusSchema>;

/** Whether its launcher may still be running. */
export function launchGoing(status: LaunchStatus): boolean {
	return status.state === "starting" || status.state === "ready";
}

/** Undefined until a whole, valid status is written. */
export function readLaunchStatus(text: string | undefined): LaunchStatus | undefined {
	if (!text) return undefined;
	try {
		const parsed = LaunchStatusSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}
