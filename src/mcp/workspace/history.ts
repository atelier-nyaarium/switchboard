// What git says about a symbol's lines and a file's commits.
//
// git runs from the workspace root with an argument array, never a shell string, and is killed at the
// op's deadline. A file git does not track answers `untracked`, and a root outside any repository
// answers `notRepository`, before any history is read.

import { type ChildProcess, spawn } from "node:child_process";
import type { HistoryCommit, WorkspaceOpResult } from "../../shared/workspace-op.js";
import { confine } from "./confine.js";
import { byDeadline, type OpContext, refused } from "./handlerKit.js";

////////////////////////////////
//  Interfaces & Types

interface GitRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

type Tracking = "tracked" | "untracked" | "notRepository";

////////////////////////////////
//  Constants

export const MAX_HISTORY_COMMITS = 200;

/** Killed past this. */
const MAX_GIT_OUTPUT_BYTES = 32_000_000;

const RECORD = String.fromCharCode(0);
const FIELD = String.fromCharCode(0x1f);

/** Hash, author time, author, subject. */
const LINE_LOG_FORMAT = "%x00%H%x1f%at%x1f%an%x1f%s";

/** Tracked, lines never committed. */
const NO_HISTORY = /has only \d+ lines?|there is no path|does not have any commits/i;

const GIT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_LITERAL_PATHSPECS: "1",
	GIT_PAGER: "cat",
	LC_ALL: "C",
};

/** Windows has no process groups to signal. */
const GROUPS = process.platform !== "win32";

////////////////////////////////
//  Functions & Helpers

/**
 * A hook, a pager or a credential helper outlives the git this spawned, and it inherits the pipes, so
 * killing the direct child alone leaves the answer waiting on a grandchild. Git leads its own process
 * group, and the whole group is signalled.
 */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	try {
		if (GROUPS && pid !== undefined) process.kill(-pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function runGit(root: string, args: readonly string[], deadline: number): Promise<GitRun> {
	return new Promise((resolve, reject) => {
		const left = deadline - Date.now();
		if (left <= 0) {
			reject(new Error("git did not answer in time"));
			return;
		}
		const child = spawn("git", args, {
			cwd: root,
			env: { ...process.env, ...GIT_ENV },
			stdio: ["ignore", "pipe", "pipe"],
			detached: GROUPS,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const settle = (answer: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			answer();
		};
		// The group dies, the pipes are dropped, and the answer does not wait for either.
		const stop = (reason: Error) => {
			killTree(child);
			child.stdout.destroy();
			child.stderr.destroy();
			settle(() => reject(reason));
		};
		const timer = setTimeout(() => stop(new Error("git did not answer in time")), left);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_GIT_OUTPUT_BYTES) stop(new Error("git's history is too large to read"));
			else out.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (err.length < 64) err.push(chunk);
		});
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code) => {
			settle(() =>
				resolve({
					code,
					stdout: Buffer.concat(out).toString("utf8"),
					stderr: Buffer.concat(err).toString("utf8"),
				}),
			);
		});
	});
}

async function trackingOf(root: string, relative: string, deadline: number): Promise<Tracking> {
	const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"], deadline);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") return "notRepository";
	const listed = await runGit(root, ["ls-files", "--error-unmatch", "--", relative], deadline);
	if (listed.code === 0) return "tracked";
	if (listed.code === 1) return "untracked";
	throw new Error(`git could not list ${relative}: ${listed.stderr.trim()}`);
}

/** Counts hunk lines only. */
export function parseLineLog(stdout: string): HistoryCommit[] {
	const commits: HistoryCommit[] = [];
	for (const record of stdout.split(RECORD)) {
		const newline = record.indexOf("\n");
		const header = newline === -1 ? record : record.slice(0, newline);
		const [hash = "", at = "", author = "", subject = ""] = header.split(FIELD);
		if (hash === "") continue;
		let added = 0;
		let removed = 0;
		let inHunk = false;
		for (const line of newline === -1 ? [] : record.slice(newline + 1).split("\n")) {
			if (line.startsWith("diff --git ")) inHunk = false;
			else if (line.startsWith("@@")) inHunk = true;
			else if (inHunk && line.startsWith("+")) added++;
			else if (inHunk && line.startsWith("-")) removed++;
		}
		commits.push({
			hash,
			at: Number.parseInt(at, 10) || 0,
			...(author === "" ? {} : { author: author.slice(0, 512) }),
			subject: subject.slice(0, 4096),
			added,
			removed,
		});
	}
	return commits;
}

/** Newest first. */
export async function symbolHistoryOf(
	context: OpContext,
	symbolId: string,
	module: string,
): Promise<WorkspaceOpResult> {
	const { deps, root, deadline } = context;
	const session = await byDeadline(deadline, deps.session);
	const declared = await byDeadline(deadline, () => session.declarationOf({ symbolId }));
	if (declared === null) return refused("no symbol with that id is indexed");
	// Lexicon counts lines from zero.
	const startLine = declared.range.start.line + 1;
	const endLine = declared.range.end.line + 1;
	const answer = (
		outcome: "commits" | "untracked" | "notRepository" | "none",
		commits: HistoryCommit[],
		truncated: boolean,
	): WorkspaceOpResult => ({
		ok: true,
		answer: {
			kind: "symbolFacet",
			symbolId,
			facet: { kind: "history", outcome, module, startLine, endLine, commits, truncated },
		},
	});

	const tracking = await trackingOf(root, module, deadline);
	if (tracking !== "tracked") return answer(tracking, [], false);

	const log = await runGit(
		root,
		[
			"-c",
			"core.quotePath=false",
			"log",
			"--no-color",
			"--no-show-signature",
			"--no-ext-diff",
			`-n${MAX_HISTORY_COMMITS + 1}`,
			`--format=${LINE_LOG_FORMAT}`,
			`-L${startLine},${endLine}:${module}`,
		],
		deadline,
	);
	if (log.code !== 0) {
		if (NO_HISTORY.test(log.stderr)) return answer("none", [], false);
		throw new Error(`git could not read the history of ${module}: ${log.stderr.trim()}`);
	}
	const commits = parseLineLog(log.stdout);
	if (commits.length === 0) return answer("none", [], false);
	return answer("commits", commits.slice(0, MAX_HISTORY_COMMITS), commits.length > MAX_HISTORY_COMMITS);
}

export async function fileHistoryOf(context: OpContext, written: string): Promise<WorkspaceOpResult> {
	const { deps, root, deadline } = context;
	const place = confine(root, written);
	if (!place.ok) return refused(place.refusal.detail);
	if (place.relative === "") return refused("a module path is required");
	const empty = { commits: [], count: 0, added: 0, removed: 0, truncated: false };

	const tracking = await trackingOf(root, place.relative, deadline);
	if (tracking !== "tracked") {
		return { ok: true, answer: { kind: "fileHistory", path: place.relative, outcome: tracking, ...empty } };
	}
	const session = await byDeadline(deadline, deps.session);
	const history = await byDeadline(deadline, () => session.fileHistory({ module: place.relative }));
	if (history.commits === 0) {
		return { ok: true, answer: { kind: "fileHistory", path: place.relative, outcome: "none", ...empty } };
	}
	return {
		ok: true,
		answer: {
			kind: "fileHistory",
			path: place.relative,
			outcome: "commits",
			commits: history.recent.map((commit) => ({
				hash: commit.hash,
				at: commit.at,
				subject: commit.subject,
				added: commit.added,
				removed: commit.deleted,
			})),
			count: history.commits,
			added: history.linesAdded,
			removed: history.linesDeleted,
			...(history.firstSeen === null ? {} : { firstSeen: history.firstSeen }),
			...(history.lastTouched === null ? {} : { lastTouched: history.lastTouched }),
			truncated: history.truncated,
		},
	};
}
