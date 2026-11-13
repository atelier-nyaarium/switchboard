// The daemon's cut of one Claude session file.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createFileExclusiveFromLines } from "../../shared/atomic-write.js";
import { channelBodyOf } from "../../shared/channel-row.js";
import {
	type CutPlan,
	type CutRequest,
	cutSession,
	indexSession,
	pickTurn,
	planCut,
	type SessionIndex,
} from "../../shared/claude-session-cut.js";
import {
	CUT_KEEP_TEXT_MAX,
	type CutFacts,
	type HostSessionCutOp,
	type HostSessionCutResult,
} from "../../shared/schemasSessionCut.js";
import { oneLine } from "../../shared/system-reminder.js";
import type { PurgeHome } from "./sessionPurge.js";

////////////////////////////////
//  Interfaces & Types

export interface SessionCutDeps {
	/** Undefined while that spawn point's home cannot be reached. Absent names the daemon's own. */
	homeOf(hostSpawn: string | undefined): PurgeHome | undefined;
	/** The installed Claude Code's version. */
	cliVersion(): Promise<string>;
	newId(): string;
	now(): Date;
}

////////////////////////////////
//  Constants

const CLAUDE_PROJECTS = "projects";
const READ_CHUNK_BYTES = 1 << 20;
const VERSION_WAIT_MS = 15_000;

////////////////////////////////
//  Functions & Helpers

const refusal = (reason: string, detail: string): HostSessionCutResult => ({ kind: "refused", reason, detail });

/** The host's installed Claude Code, as it names itself. */
export async function claudeCliVersion(): Promise<string> {
	const { stdout } = await promisify(execFile)("claude", ["--version"], { timeout: VERSION_WAIT_MS });
	return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
}

/** Splits on LF; drops an unterminated tail. */
export async function* sessionLines(file: string): AsyncGenerator<string> {
	let rest = "";
	for await (const chunk of fs.createReadStream(file, { encoding: "utf8", highWaterMark: READ_CHUNK_BYTES })) {
		const parts = (rest + chunk).split("\n");
		rest = parts.pop() ?? "";
		yield* parts;
	}
}

/** Regular files only. */
function transcriptOf(claudeDir: string, id: string): string | undefined {
	const projects = path.join(claudeDir, CLAUDE_PROJECTS);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(projects, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const file = path.join(projects, entry.name, `${id}.jsonl`);
		if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return file;
	}
	return undefined;
}

/** Never ends on half a surrogate pair. */
function quoteOf(text: string): string {
	const cut = oneLine(channelBodyOf(text)).slice(0, CUT_KEEP_TEXT_MAX);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function factsOf(plan: CutPlan, target: string | null, exact: boolean, sourceBytes: number): CutFacts {
	const at = plan.from?.at ? Date.parse(plan.from.at) : Number.NaN;
	return {
		target,
		keepAt: Number.isFinite(at) ? at : null,
		keepText: quoteOf(plan.from?.text ?? ""),
		snapped: !exact,
		keptRows: plan.keptLines.length,
		foldedRows: plan.droppedRows,
		keptBytes: plan.keptBytes,
		sourceBytes,
	};
}

/** Never writes the source. */
export function createSessionCut(deps: SessionCutDeps): (op: HostSessionCutOp) => Promise<HostSessionCutResult> {
	return async (op) => {
		const home = deps.homeOf(op.hostSpawn);
		if (!home) return refusal("place_down", "that spawn point's home is out of reach");
		const source = transcriptOf(home.claudeDir, op.conversationId);
		if (!source) return refusal("no_transcript", "the session's file is not on this machine");
		const read = () => sessionLines(source);
		let held: Promise<SessionIndex> | undefined;
		const index = () => {
			held ??= indexSession(read());
			return held;
		};

		let targetUuid: string | undefined;
		let exact = true;
		if (op.mode !== "trim") {
			if (!op.pick) return refusal("target_missing", "no message was picked");
			if ("uuid" in op.pick) targetUuid = op.pick.uuid;
			else {
				const picked = pickTurn(await index(), op.pick, channelBodyOf);
				if (!picked)
					return refusal("target_missing", "no turn of the session starts at or before that message");
				targetUuid = picked.uuid;
				exact = picked.exact;
			}
		}
		const request: CutRequest = {
			mode: op.mode,
			...(targetUuid ? { targetUuid } : {}),
			...(op.endBefore ? { endBefore: op.endBefore } : {}),
			...(op.build?.summary ? { summaryText: op.build.summary } : {}),
		};
		const version = await deps.cliVersion();
		const sourceBytes = fs.statSync(source).size;
		if (!op.build) {
			// Unbounded, a live file ends mid-call.
			const liveTail = op.mode === "compact" && !op.endBefore;
			const plan = planCut(await index(), { ...request, liveTail }, version);
			return plan.ok
				? { kind: "planned", ...factsOf(plan, targetUuid ?? null, exact, sourceBytes) }
				: refusal(plan.reason, plan.detail);
		}

		const built = (id: string) => path.join(path.dirname(source), `${id}.jsonl`);
		const done = await cutSession(
			{
				read,
				sourcePath: source,
				create: (id, lines) => createFileExclusiveFromLines(built(id), lines, { mode: 0o600 }),
				readBuilt: (id) => sessionLines(built(id)),
				discard: async (id) => fs.rmSync(built(id), { force: true }),
				newId: deps.newId,
				now: deps.now,
				cliVersion: async () => version,
			},
			request,
		);
		if (!done.ok) return refusal(done.reason, done.detail);
		// The Gateway stopped waiting; nothing would name it.
		if (deps.now().getTime() > op.build.deadline) {
			fs.rmSync(built(done.sessionId), { force: true });
			return refusal("late", "the build finished after the Gateway stopped waiting");
		}
		return {
			kind: "built",
			conversationId: done.sessionId,
			...factsOf(done.plan, targetUuid ?? null, exact, sourceBytes),
		};
	};
}
