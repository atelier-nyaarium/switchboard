// Session baseline after compaction.

import { z } from "zod";
import { AGENT_BACKEND_IDS } from "./agent-backend.js";
import { neutralizeMarkup, oneLine, reminderBlock } from "./system-reminder.js";

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
	runningRuns: z
		.array(
			z.object({ runId: z.string(), phase: z.string().nullable(), stepsRunning: z.number().int().nonnegative() }),
		)
		.optional(),
	/** With a turn running. */
	agents: z.array(z.object({ family: z.enum(AGENT_BACKEND_IDS), agentId: z.string() })),
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
export type BaselineHold = NonNullable<NonNullable<SessionBaseline["assistant"]>["hold"]>;

////////////////////////////////
//  Functions & Helpers

export function holdLine(hold: BaselineHold): string {
	if (hold.kind === "held") return `phone hold: held by ${oneLine(hold.label)}, ${hold.remainingMs}ms remaining`;
	if (hold.kind === "lapsed") return `phone hold: lapsed ${hold.lapsedMs}ms ago, last held by ${oneLine(hold.label)}`;
	return "phone hold: none";
}

const WRAPPER_CHARS = reminderBlock(["-"]).length - 1;

function linesOf(baseline: SessionBaseline): string[] {
	return [
		...baseline.conversations.map(({ sessionId, peer }) =>
			peer.kind === "owner"
				? `conversation: ${sessionId} owner`
				: `conversation: ${sessionId} ${oneLine(peer.name)}`,
		),
		...baseline.routines.map(({ occurrenceId, routine }) => `routine: ${occurrenceId} ${oneLine(routine)}`),
		...(baseline.runningRuns ?? []).map(
			({ runId, phase, stepsRunning }) =>
				`workflow: ${runId} running, phase ${oneLine(phase ?? "not started")}, ${stepsRunning} step(s) running`,
		),
		...baseline.agents.map(({ family, agentId }) => `agent: ${family} ${agentId} turn running`),
		...(baseline.assistant?.hold === undefined ? [] : [holdLine(baseline.assistant.hold)]),
		...(baseline.assistant?.watchers ?? []).map(
			({ label, unread, capped, checked, stopped, waiting }) =>
				`watcher: ${oneLine(label)} ${checked === false ? "not checked yet" : `${unread}${capped ? "+" : ""} unread`}` +
				(stopped === undefined ? "" : `, stopped: ${oneLine(stopped)}`) +
				(waiting === undefined ? "" : `, waiting: ${oneLine(waiting)}`),
		),
		...(baseline.board === null
			? ["board: unavailable"]
			: baseline.board.map(
					({ id, title, state, parent }) =>
						`board: ${id} ${state}${parent === undefined ? "" : ` parent ${parent}`} ${oneLine(title)}`,
				)),
	];
}

export function baselineLines(baseline: SessionBaseline): string[] {
	const lines = linesOf(baseline).map(neutralizeMarkup);
	if (lines.length === 0) return [];
	const kept = ["baseline: compaction"];
	let size = WRAPPER_CHARS + kept[0].length;
	for (const [index, line] of lines.entries()) {
		const left = lines.length - index;
		const note = `truncated: ${left} more`;
		if (size + line.length + note.length + 2 > MAX_BASELINE_CHARS) {
			kept.push(note);
			break;
		}
		kept.push(line);
		size += line.length + 1;
	}
	return kept;
}
