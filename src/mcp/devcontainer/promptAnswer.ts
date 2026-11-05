import { stripAnsi } from "../../shared/agent-screen.js";
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

// Explicit class: the Windows build emits U+00A0.
const SPACE = "[ \\t\\u00a0]";
const LIMIT_MENU_RE = /wait for limit to reset/u;
const CONTINUE_ROW_RE = new RegExp(`^${SPACE}*(?:[❯>]${SPACE}*)?(\\d+)\\.${SPACE}+.*continue automatically`, "u");
// The dialog's own footer, always the pane's last row.
const CONFIRM_FOOTER_RE = new RegExp(`^${SPACE}*Enter to confirm`, "u");

/** The limit dialog's "continue automatically" digit, or null when no such dialog shows. */
export function limitContinueDigit(screen: string): string | null {
	const rows = stripAnsi(screen)
		.split("\n")
		.filter((row) => row.trim() !== "");
	if (!CONFIRM_FOOTER_RE.test(rows.at(-1) ?? "")) return null;
	const dialog = rows.slice(-12);
	if (!dialog.some((row) => LIMIT_MENU_RE.test(row))) return null;
	for (const row of dialog) {
		const match = CONTINUE_ROW_RE.exec(row);
		if (match) return match[1];
	}
	return null;
}

/**
 * Chooses to wait out the limit and continue on its own, while the dialog still shows.
 *
 * Enter follows only if the digit alone left the dialog up.
 */
export async function continueAfterLimit(hands: PaneHands, timing: AnswerTiming = {}): Promise<boolean> {
	const digit = limitContinueDigit(await hands.read());
	if (!digit) return false;
	await hands.type(digit);
	const gone = async () => limitContinueDigit(await hands.read()) === null;
	if (await settled(gone, timing)) return true;
	await hands.press("Enter");
	if (await settled(gone, timing)) return true;
	throw new Error("the limit dialog is still showing");
}

async function settled(done: () => Promise<boolean>, timing: AnswerTiming): Promise<boolean> {
	const settleMs = timing.settleMs ?? 1_000;
	const pollMs = timing.pollMs ?? POLL_MS;
	const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let waited = 0; ; waited += pollMs) {
		if (await done()) return true;
		if (waited >= settleMs) return false;
		await sleep(pollMs);
	}
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
