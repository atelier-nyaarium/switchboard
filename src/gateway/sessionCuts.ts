// A session cut: plan, ask, close, build, repoint, wake.

import type { Ambient } from "../shared/ambient.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { compareVersions } from "../shared/bun-floor.js";
import type { CutMode } from "../shared/claude-session-cut.js";
import type { HostOp, HostOpResult, TmuxTarget } from "../shared/host-op.js";
import { HOST_SPAWN } from "../shared/host-spawn.js";
import {
	type ConsoleSessionCutPlanResult,
	type ConsoleSessionCutStartResult,
	type CutFacts,
	type CutPick,
	type HostSessionCutOp,
	type HostSessionCutResult,
	HostSessionCutResultSchema,
	type SessionCutSummaryAnswer,
} from "../shared/schemasSessionCut.js";
import { SESSION_COMMANDS } from "../shared/session-commands.js";
import { HARNESS } from "../shared/session-harness.js";
import { parseSessionName } from "../shared/session-id.js";
import type { SessionRecord } from "../shared/session-store.js";
import { neutralizeMarkup } from "../shared/system-reminder.js";

////////////////////////////////
//  Interfaces & Types

export interface SessionCutsDeps {
	ambient: Pick<Ambient, "now" | "randomBytes" | "setTimer" | "clearTimer">;
	relayToHost(op: HostOp): Promise<HostOpResult>;
	record(team: string): SessionRecord | undefined;
	/** This Gateway launched its terminal. */
	ownTerminal(record: SessionRecord): boolean;
	isLive(team: string): boolean;
	/** Undefined when unknown. */
	busy(team: string): boolean | undefined;
	/** The live plugin's version. */
	pluginVersion(team: string): string | undefined;
	/** The conversation the live CLI runs. */
	liveConversation(team: string): string | undefined;
	launching(team: string): boolean;
	/** Makes a launch of the team wait until the release. */
	holdWakes(team: string): () => void;
	/** The request to the session. Null when it landed. */
	ask(request: { from: string; to: string; body: string; deliveryId: string }): Promise<string | null>;
	/** False when no record holds the team. */
	repoint(team: string, conversationId: string): boolean;
	wake(team: string): Promise<{ ok: boolean; error?: string }>;
	/** Queues a replaced conversation's delete. */
	discard(team: string, conversationId: string): void;
	/** What a close ends. */
	closed(team: string): void;
	tellOwner(team: string, told: { title: string; body: string }, identity: string): void;
}

interface Refusal {
	reason: string;
	detail: string;
}

interface Place {
	target: TmuxTarget;
	op: Pick<HostSessionCutOp, "kind" | "hostSpawn" | "conversationId">;
}

interface Cut {
	cutId: string;
	team: string;
	mode: CutMode;
	place: Place;
	facts: CutFacts;
	/** Clears on the summary or the deadline. */
	waiting?: ReturnType<Ambient["setTimer"]>;
	summary?: string;
}

export interface SessionCuts {
	plan(target: string, mode: CutMode, pick: CutPick | undefined): Promise<ConsoleSessionCutPlanResult>;
	start(
		target: string,
		mode: CutMode,
		pick: CutPick | undefined,
		device: string,
	): Promise<ConsoleSessionCutStartResult>;
	/** The session's own answer. */
	submit(team: string | null, cutId: string, summary: string): SessionCutSummaryAnswer;
	/** A close or a forget waits it out. */
	running(team: string): boolean;
	sessionEnded(team: string): void;
	stop(): void;
}

////////////////////////////////
//  Constants

const COMMAND = SESSION_COMMANDS.sessionCutSummary;
export const SUMMARY_WAIT_MS = 10 * 60_000;
const TURN_END_WAIT_MS = 20_000;
const CLOSE_WAIT_MS = 15_000;
const DONE_TITLE = "Compacted";
const FAILED_TITLE = "Compact failed";

/** Inside the host op's own wait. */
const BUILD_WAIT_MS = 120_000;
const POLL_MS = 500;
/** The first plugin with `submit_session_summary`. */
export const CUT_TOOL_SINCE = "8.14.74";

////////////////////////////////
//  Functions & Helpers

/** Its `cutId` marks where kept rows end. */
export function summaryRequest(cutId: string, facts: CutFacts): string {
	const sent = facts.keepAt === null ? "" : `, sent ${new Date(facts.keepAt).toISOString()}`;
	return `
Owner asked to compact this session above one of their messages.

The message it keeps from${sent}: "${neutralizeMarkup(facts.keepText)}"

Write the summary that replaces everything before that message: the summary this session started from, and all the work since then up to that message. Leave out that message and everything after it. Those stay in the session word for word.

Call ${COMMAND.tool} with cutId "${cutId}" and the summary. The session then closes and resumes compacted, so do nothing else this turn.
	`.trim();
}

/** Capitalized and closed, for text another layer wrote. */
export function sentence(text: string): string {
	const trimmed = text.trim();
	const opened = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

/** One decimal past a megabyte. */
const sizeText = (bytes: number) =>
	bytes >= 2 ** 30
		? `${(bytes / 2 ** 30).toFixed(1)} GB`
		: bytes >= 2 ** 20
			? `${(bytes / 2 ** 20).toFixed(1)} MB`
			: `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function doneLine(mode: CutMode, facts: CutFacts): string {
	const sizes = `Session file: ${sizeText(facts.sourceBytes)} before, about ${sizeText(facts.keptBytes)} now.`;
	if (mode === "trim") return `Trimmed to what the session still loads. ${sizes}`;
	const above = mode === "compact" ? "Compacted" : "Cleared";
	return `${above} above "${facts.keepText}". ${sizes}`;
}

export function createSessionCuts(deps: SessionCutsDeps): SessionCuts {
	const cuts = new Map<string, Cut>();
	/** Teams whose start has not planned yet. */
	const starting = new Set<string>();
	let stopped = false;

	const sleep = (ms: number) => new Promise<void>((resolve) => deps.ambient.setTimer(resolve, ms));
	/** Whether `met` held before `ms` passed. */
	async function until(met: () => boolean, ms: number): Promise<boolean> {
		for (let waited = 0; !met(); waited += POLL_MS) {
			if (waited >= ms || stopped) return false;
			await sleep(POLL_MS);
		}
		return true;
	}

	function placeOf(team: string): Place | Refusal {
		const record = deps.record(team);
		if (!record) return { reason: "no_session", detail: "This session is not on this Gateway." };
		if (team === ASSISTANT_TEAM)
			return { reason: "assistant", detail: "The assistant's session cannot be compacted." };
		if (!record.harness || !HARNESS[record.harness].cuts)
			return { reason: "cli", detail: "Only Claude sessions can be compacted." };
		if (record.spawn !== HOST_SPAWN)
			return { reason: "place", detail: "Only sessions on the host can be compacted for now." };
		if (!deps.ownTerminal(record))
			return {
				reason: "foreign_terminal",
				detail: "This session was started by hand, so the Gateway cannot reopen it.",
			};
		if (!record.claudeSessionId)
			return { reason: "no_transcript", detail: "This session has not reported its conversation yet." };
		const { project, session } = parseSessionName(team);
		return {
			target: { kind: "host", name: project, sessionName: session },
			op: { kind: "sessionCut", conversationId: record.claudeSessionId },
		};
	}

	async function relay(op: HostSessionCutOp): Promise<HostSessionCutResult> {
		let answer: HostOpResult;
		try {
			answer = await deps.relayToHost(op);
		} catch (error) {
			return {
				kind: "refused",
				reason: "host",
				detail: sentence(`The host failed: ${error instanceof Error ? error.message : String(error)}`),
			};
		}
		if (!answer.ok) {
			return {
				kind: "refused",
				reason: "host",
				detail: sentence(`The host refused: ${answer.error ?? answer.errorKind ?? "no reason given"}`),
			};
		}
		const parsed = HostSessionCutResultSchema.safeParse(answer.result);
		return parsed.success
			? parsed.data
			: { kind: "refused", reason: "host", detail: "The host's answer could not be read." };
	}

	async function planned(
		team: string,
		mode: CutMode,
		pick: CutPick | undefined,
	): Promise<{ place: Place; facts: CutFacts } | Refusal> {
		const place = placeOf(team);
		if ("reason" in place) return place;
		const answer = await relay({ ...place.op, mode, ...(pick ? { pick } : {}) });
		if (answer.kind === "refused") return { reason: answer.reason, detail: answer.detail };
		const { kind: _kind, ...facts } = answer;
		return { place, facts };
	}

	/** What stops a start now, the same for a plan. */
	function gate(team: string, mode: CutMode): Refusal | null {
		if (cuts.has(team) || starting.has(team)) {
			return { reason: "in_flight", detail: "A compact of this session is already running." };
		}
		if (deps.launching(team))
			return { reason: "launching", detail: "This session is starting. Try again once it is up." };
		const live = deps.isLive(team);
		if (live && deps.busy(team) === true) {
			return { reason: "busy", detail: "This session is working. Try again once it is idle." };
		}
		if (mode !== "compact") return null;
		if (!live)
			return {
				reason: "not_live",
				detail: "This session is closed. Wake it first, since it writes its own summary.",
			};
		const version = deps.pluginVersion(team);
		if (!version || compareVersions(version, CUT_TOOL_SINCE) < 0) {
			return {
				reason: "plugin",
				detail: "This session's plugin is too old to compact. Update its plugins first.",
			};
		}
		return null;
	}

	/** Never writes the source file; deletes it once woken on the new. Every check that can refuse runs before the close. */
	async function run(cut: Cut): Promise<void> {
		const { team, place } = cut;
		let line: string;
		let title = FAILED_TITLE;
		let closed = false;
		let replacement: string | undefined;
		const wasLive = deps.isLive(team);
		// A wake would resume the old file.
		const release = deps.holdWakes(team);
		const op: HostSessionCutOp = {
			...place.op,
			mode: cut.mode,
			...(cut.facts.target ? { pick: { uuid: cut.facts.target } } : {}),
			...(cut.mode === "compact" ? { endBefore: cut.cutId } : {}),
		};
		try {
			if (deps.launching(team)) throw new Error("The session was starting.");
			if (!(await until(() => deps.busy(team) !== true, TURN_END_WAIT_MS))) {
				throw new Error(
					stopped ? "The Gateway is shutting down." : "The session kept working after writing its summary.",
				);
			}
			const checked = await relay(op);
			if (checked.kind === "refused") throw new Error(checked.detail);
			if (stopped) throw new Error("The Gateway is shutting down.");
			// Missing pane is success.
			closed = wasLive;
			const killed = await deps.relayToHost({ kind: "killSession", target: place.target, dedupKey: cut.cutId });
			if (!killed.ok)
				throw new Error(sentence(`The session could not be closed: ${killed.error ?? "no reason given"}`));
			deps.closed(team);
			if (!(await until(() => !deps.isLive(team), CLOSE_WAIT_MS))) {
				throw new Error("The session did not shut down in time.");
			}
			const built = await relay({
				...op,
				build: {
					deadline: deps.ambient.now() + BUILD_WAIT_MS,
					...(cut.summary ? { summary: cut.summary } : {}),
				},
			});
			if (built.kind === "refused") throw new Error(built.detail);
			if (built.kind !== "built") throw new Error("The host planned where it should have built.");
			if (!deps.repoint(team, built.conversationId)) {
				throw new Error("The new session file was built but could not be recorded.");
			}
			const { kind: _kind, conversationId, ...facts } = built;
			replacement = conversationId;
			line = doneLine(cut.mode, facts);
			title = DONE_TITLE;
		} catch (error) {
			line = `${sentence(error instanceof Error ? error.message : String(error))} Nothing was changed.`;
		} finally {
			cuts.delete(team);
			release();
		}
		if (closed) {
			const woke = await deps.wake(team).catch((error: Error) => ({ ok: false, error: error.message }));
			if (!woke.ok)
				line += ` ${sentence(`The session did not restart: ${woke.error ?? "no reason given"}`)} Wake it from here.`;
			// Back up on the new file.
			else if (replacement && deps.liveConversation(team) === replacement)
				deps.discard(team, place.op.conversationId);
		}
		deps.tellOwner(team, { title, body: line }, `${cut.cutId}:end`);
	}

	const background = (cut: Cut): void => {
		void run(cut).catch((error) => console.error(`[cut] ${cut.team} ${cut.cutId}:`, error));
	};

	return {
		async plan(target, mode, pick) {
			const stopped = gate(target, mode);
			if (stopped) return { planned: false, ...stopped };
			const held = await planned(target, mode, pick);
			if ("reason" in held) return { planned: false, ...held };
			const { target: _target, keepAt, ...facts } = held.facts;
			return { planned: true, ...facts, ...(keepAt === null ? {} : { keepAt }) };
		},

		async start(target, mode, pick, device) {
			const refuse = (reason: string, detail: string) => ({ started: false, reason, detail });
			const stopped = gate(target, mode);
			if (stopped) return refuse(stopped.reason, stopped.detail);
			starting.add(target);
			const held = await planned(target, mode, pick).finally(() => starting.delete(target));
			if ("reason" in held) return refuse(held.reason, held.detail);
			const cutId = `cut-${deps.ambient.randomBytes(8).toString("hex")}`;
			const cut: Cut = { cutId, team: target, mode, place: held.place, facts: held.facts };
			cuts.set(target, cut);
			if (mode !== "compact") {
				background(cut);
				return { started: true };
			}
			cut.waiting = deps.ambient.setTimer(() => {
				if (cuts.get(target) !== cut || cut.summary !== undefined) return;
				cuts.delete(target);
				deps.tellOwner(
					target,
					{
						title: FAILED_TITLE,
						body: "The session did not hand over a summary within 10 minutes. Nothing was changed.",
					},
					`${cutId}:end`,
				);
			}, SUMMARY_WAIT_MS);
			const refused = await deps
				.ask({ from: device, to: target, body: summaryRequest(cutId, cut.facts), deliveryId: cutId })
				.catch((error: Error) => error.message);
			if (refused) {
				deps.ambient.clearTimer(cut.waiting);
				cuts.delete(target);
				return refuse("ask", sentence(`The compact request was not delivered: ${refused}`));
			}
			return { started: true };
		},

		submit(team, cutId, summary) {
			if (!team) return { kind: "unauthenticated" };
			const cut = cuts.get(team);
			if (!cut || cut.cutId !== cutId || cut.mode !== "compact") return { kind: "unknown_cut" };
			// Repeat submit ignored.
			if (cut.summary !== undefined) return { kind: "taken" };
			cut.summary = summary;
			if (cut.waiting) deps.ambient.clearTimer(cut.waiting);
			background(cut);
			return { kind: "taken" };
		},

		running(team) {
			return cuts.has(team) || starting.has(team);
		},

		sessionEnded(team) {
			const cut = cuts.get(team);
			// A run closes it itself.
			if (!cut || cut.summary !== undefined || cut.mode !== "compact") return;
			if (cut.waiting) deps.ambient.clearTimer(cut.waiting);
			cuts.delete(team);
		},

		stop() {
			stopped = true;
			for (const cut of cuts.values()) if (cut.waiting) deps.ambient.clearTimer(cut.waiting);
		},
	};
}
