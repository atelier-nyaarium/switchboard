// What a sender is told once the session its message waits on comes up or does not.

import { z } from "zod";
import { CliRefusalSchema, cliRefusalText } from "./cli-resolve.js";
import { neutralizeMarkup, oneLine } from "./system-reminder.js";

////////////////////////////////
//  Interfaces & Types

export const LaunchFailureSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("container"),
		spawn: z.string().max(128),
		projectPath: z.string().max(1024).optional(),
	}),
	/** A create's pick, or a woken session's CLI gone. */
	z.object({ kind: z.literal("cli"), refusal: CliRefusalSchema }),
	z.object({ kind: z.literal("timeout") }),
	/** The owner stopped its container meanwhile. */
	z.object({ kind: z.literal("stopped") }),
	z.object({ kind: z.literal("error"), reason: z.string().max(2048) }),
]);

export type LaunchFailure = z.infer<typeof LaunchFailureSchema>;

const Address = z.string().min(1).max(256);

export const LaunchNoticeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("up"), address: Address }),
	z.object({
		kind: z.literal("failed"),
		address: Address,
		failure: LaunchFailureSchema,
		/** A create, as opposed to a wake. */
		created: z.boolean(),
		/** Another Domain gets the reason alone. */
		foreign: z.boolean(),
	}),
]);

export type LaunchNotice = z.infer<typeof LaunchNoticeSchema>;

/** Why a send launched nothing; the plugin words it. */
export const SendRefusalSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("no_label") }),
	z.object({ kind: z.literal("cli"), refusal: CliRefusalSchema }),
]);

export type SendRefusal = z.infer<typeof SendRefusalSchema>;

////////////////////////////////
//  Constants

export const LAUNCH_NOTICE_SOURCE = "launches";

export const PLAIN_LAUNCH_REASON = "the launch failed";

////////////////////////////////
//  Functions & Helpers

const escaped = (text: string): string => neutralizeMarkup(oneLine(text));

/** Another Domain gets no path and no daemon text. */
export function failureFor(failure: LaunchFailure, foreign: boolean): LaunchFailure {
	if (!foreign) return failure;
	if (failure.kind === "container") return { kind: "container", spawn: failure.spawn };
	if (failure.kind === "error") return { kind: "error", reason: PLAIN_LAUNCH_REASON };
	if (failure.kind === "cli") return { kind: "cli", refusal: { cause: "none_installed" } };
	return failure;
}

/** Foreign notice rebuilt; only the job's address is trusted. */
export function foreignNotice(notice: LaunchNotice, address: string): LaunchNotice {
	if (notice.kind === "up") return { kind: "up", address };
	return { kind: "failed", address, failure: failureFor(notice.failure, true), created: false, foreign: true };
}

function failureText(notice: Extract<LaunchNotice, { kind: "failed" }>): string {
	const address = escaped(notice.address);
	const { failure } = notice;
	switch (failure.kind) {
		case "container": {
			const failed = `Devcontainer for \`${escaped(failure.spawn)}\` failed to start.`;
			if (notice.foreign || !failure.projectPath) return failed;
			return `${failed} Investigate \`${escaped(failure.projectPath)}/.devcontainer/\` and talk to the user.`;
		}
		case "cli":
			return notice.created
				? cliRefusalText(failure.refusal, address)
				: `\`${address}\`'s CLI is not installed. Talk to the user.`;
		case "timeout":
			return `\`${address}\` did not come up within 10 minutes. Send again to retry.`;
		case "stopped":
			return `
\`${address}\` did not start: the user stopped its devcontainer.
Ask the user before sending again.
			`.trim();
		case "error":
			return `\`${address}\` did not come up: ${escaped(failure.reason)}. Send again to retry.`;
	}
}

export function sendRefusalText(refusal: SendRefusal, address: string): string {
	if (refusal.kind === "cli") return cliRefusalText(refusal.refusal, escaped(address));
	return `\`${escaped(address)}\` does not exist. Set \`displayLabel\` to create it.`;
}

/** A send's answer while its session starts. */
export function startingText(address: string): string {
	return `Starting \`${escaped(address)}\`. Message will auto-send afterwards. You will be notified by a system reminder when it completes or fails.`;
}

/** A launch's failure for a reader that waited on it. */
export function launchFailureText(
	failure: LaunchFailure,
	address: string,
	at: { created: boolean; foreign: boolean } = { created: false, foreign: false },
): string {
	return failureText({ kind: "failed", address, failure: failureFor(failure, at.foreign), ...at });
}

/** The `session:` line names the address, since some texts do not. */
export function launchNoticeText(notice: LaunchNotice): string {
	const body =
		notice.kind === "up"
			? `\`${escaped(notice.address)}\` started. Your message was sent. No action needed.`
			: failureText(notice);
	return `
session: ${escaped(notice.address)}
${body}
	`.trim();
}
