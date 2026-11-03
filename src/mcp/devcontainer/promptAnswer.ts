import type { PromptDecision, PromptOutcome } from "../../shared/host-op.js";
import { noOption, type SeenPrompt } from "./permissionPrompt.js";
import type { PaneHands } from "./tmuxCore.js";

////////////////////////////////
//  Interfaces & Types

/** Reads a pane's prompt with its occurrence id. */
export type PromptSight = (screen: string) => SeenPrompt | null;

export interface AnswerTiming {
	settleMs?: number;
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

////////////////////////////////
//  Functions & Helpers

const SETTLE_MS = 3_000;
const POLL_MS = 100;
const MAX_REASON_CHARS = 2_000;

/**
 * Answers the prompt `promptId` names; stale when the pane holds another.
 *
 * Counts as answered only once the prompt has left the pane.
 */
export async function answerPrompt(
	hands: PaneHands,
	sight: PromptSight,
	promptId: string,
	decision: PromptDecision,
	reason: string | undefined,
	timing: AnswerTiming = {},
): Promise<PromptOutcome> {
	const settle = settler(hands, sight, timing);
	const first = await settle.read();
	if (first?.id !== promptId) return "stale";
	const no = noOption(first.options);
	if (no === null) throw new Error("the prompt has no No option");
	const steer = typeable(reason ?? "")
		.trim()
		.slice(0, MAX_REASON_CHARS);
	if (decision === "approve") await hands.type("1");
	else if (!steer) await hands.type(String(no));
	else {
		const key = no > first.cursor ? "Down" : "Up";
		for (let at = first.cursor; at !== no; at += key === "Down" ? 1 : -1) await hands.press(key);
		await settle.until((p) => p?.id === promptId && p.cursor === no, "the cursor did not reach No");
		const opened = (p: SeenPrompt | null) => p?.id === promptId && labelOf(p, no).startsWith("No,");
		// Tab toggles an open field.
		if (!opened(await settle.read())) {
			await hands.press("Tab");
			await settle.until(opened, "the reason field did not open");
		}
		await hands.type(steer);
		// Enter on a composer would send the reason.
		await settle.until(opened, "the prompt left while typing");
		await hands.press("Enter");
	}
	await settle.until((p) => p?.id !== promptId, "the prompt is still waiting");
	return "answered";
}

/** Down then Up: stops a countdown and leaves the cursor where it was. */
export async function stopAutoDeny(hands: PaneHands, sight: PromptSight, promptId: string): Promise<boolean> {
	const prompt = sight(await hands.read());
	if (prompt?.id !== promptId || !prompt.autoDeny) return false;
	await hands.press("Down");
	await hands.press("Up");
	return true;
}

/** Control characters act as keys. */
function typeable(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : ch;
	}
	return out;
}

function labelOf(prompt: SeenPrompt, digit: number): string {
	return prompt.options.find((option) => option.digit === digit)?.label ?? "";
}

function settler(hands: PaneHands, sight: PromptSight, timing: AnswerTiming) {
	const settleMs = timing.settleMs ?? SETTLE_MS;
	const pollMs = timing.pollMs ?? POLL_MS;
	const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const read = async () => sight(await hands.read());
	return {
		read,
		async until(done: (prompt: SeenPrompt | null) => boolean, failure: string): Promise<void> {
			for (let waited = 0; ; waited += pollMs) {
				if (done(await read())) return;
				if (waited >= settleMs) throw new Error(failure);
				await sleep(pollMs);
			}
		},
	};
}
