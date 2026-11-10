// Which CLI a launch runs, once its place reports what is installed.

import { z } from "zod";
import {
	foldHarness,
	type HarnessWord,
	type LaunchPlace,
	launchRefusal,
	olderThanSender,
	SESSION_HARNESSES,
	type SessionHarness,
} from "./session-harness.js";
import { neutralizeMarkup, oneLine } from "./system-reminder.js";

////////////////////////////////
//  Interfaces & Types

const Available = z.array(z.enum(SESSION_HARNESSES)).max(SESSION_HARNESSES.length);

export const CliRefusalSchema = z.discriminatedUnion("cause", [
	z.object({ cause: z.literal("needs_pick"), available: Available }),
	z.object({
		cause: z.literal("not_installed"),
		available: Available,
		/** The CLI asked for. */
		named: z.enum(SESSION_HARNESSES).optional(),
	}),
	z.object({ cause: z.literal("none_installed") }),
	/** Placement or an unknown word. */
	z.object({ cause: z.literal("refused"), reason: z.string().max(512) }),
]);

export type CliRefusal = z.infer<typeof CliRefusalSchema>;

export type CliResolution = { readonly harness: SessionHarness } | { readonly refused: CliRefusal };

////////////////////////////////
//  Functions & Helpers

/** The CLIs a place may run, in offer order. */
export function placeCandidates(at: { place: LaunchPlace; assistant: boolean }): SessionHarness[] {
	return SESSION_HARNESSES.filter((harness) => launchRefusal(harness, at) === null);
}

export function resolveCli(word: HarnessWord, available: readonly SessionHarness[]): CliResolution {
	return foldHarness<CliResolution>(word, {
		named: (harness) => {
			if (available.includes(harness)) return { harness };
			return {
				refused: available.length
					? { cause: "not_installed", available: [...available], named: harness }
					: { cause: "none_installed" },
			};
		},
		// FIXME 2026-11-23: goes with `unnamed`.
		unnamed: (assumed) => ({ harness: assumed }),
		unpicked: () => {
			const [only, ...rest] = available;
			if (only && rest.length === 0) return { harness: only };
			return { refused: only ? { cause: "needs_pick", available: [...available] } : { cause: "none_installed" } };
		},
		unknown: (unknown) => ({ refused: { cause: "refused", reason: olderThanSender(unknown) } }),
	});
}

/** A create's CLI where its place's are known; no harness waits on the place. */
export function pickAt(
	at: { place: LaunchPlace; assistant: boolean },
	named: SessionHarness | undefined,
	installed: readonly SessionHarness[] | undefined,
): { harness?: SessionHarness } | { refused: CliRefusal } {
	if (named) {
		const placement = launchRefusal(named, at);
		if (placement) return { refused: { cause: "refused", reason: placement } };
	}
	if (!installed) return named ? { harness: named } : {};
	const word: HarnessWord = named ? { read: "named", harness: named } : { read: "unpicked" };
	const resolved = resolveCli(
		word,
		installed.filter((harness) => launchRefusal(harness, at) === null),
	);
	return "harness" in resolved ? { harness: resolved.harness } : resolved;
}

export function cliListText(available: readonly SessionHarness[]): string {
	const lines = [`This spawn point has:`];
	for (const harness of available) lines.push(`- ${harness}`);
	return lines.join("\n");
}

/** One wording per cause, on every road. */
export function cliRefusalText(refusal: CliRefusal, address: string): string {
	switch (refusal.cause) {
		case "needs_pick":
			return `
\`${address}\` has multiple CLIs. You must choose which. Ask the user if not sure.
${cliListText(refusal.available)}
			`.trim();
		case "not_installed":
			return `
The specified CLI is not installed.
${cliListText(refusal.available)}
			`.trim();
		case "none_installed":
			return `This spawn point has no CLI installed. Talk to the user.`;
		case "refused":
			return neutralizeMarkup(oneLine(refusal.reason));
	}
}
