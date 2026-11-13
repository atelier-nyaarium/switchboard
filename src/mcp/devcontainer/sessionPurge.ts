// The daemon's delete of one thing at one place.

import fs from "node:fs";
import path from "node:path";
import type { AgentBackendId } from "../../shared/agent-backend.js";
import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import { classifyPeekError, type HostPurgeOp, type PurgeOutcome, type TmuxTarget } from "../../shared/host-op.js";
import { ownSessionFiles } from "../../shared/session-files.js";
import { composeSessionName } from "../../shared/session-id.js";
import { CONTAINER_HOME, type PlaceExec } from "./containerSite.js";

////////////////////////////////
//  Interfaces & Types

/** Host-side file access. */
export interface PurgeHostFiles {
	/** Names only, never links. Empty when absent. */
	directories(dir: string): string[];
	exists(file: string): boolean;
	/** Removes links without following them. */
	remove(file: string): void;
}

/** A host spawn point's home and its Claude Code directory. */
export interface PurgeHome {
	home: string;
	/** Its Claude Code directory. */
	claudeDir: string;
}

export interface PurgeDeps {
	/** Undefined while that spawn point's home cannot be reached. Absent names the daemon's own. */
	homeOf(hostSpawn: string | undefined): PurgeHome | undefined;
	files: PurgeHostFiles;
	exec: PlaceExec;
	/** Closes first. Runs `then` before later launches. */
	closePane(pane: TmuxTarget, then?: () => Promise<void>): Promise<void>;
	deleteThread(backend: AgentBackendId, target: AgentExecutionTarget, threadId: string): Promise<"deleted" | "gone">;
}

type Place = Pick<TmuxTarget, "kind" | "name">;

/** The host's own disk. */
export function hostPurgeFiles(): PurgeHostFiles {
	return {
		directories: (dir) => {
			try {
				return fs
					.readdirSync(dir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw err;
			}
		},
		exists: (file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined,
		remove: (file) => fs.rmSync(file, { recursive: true, force: true }),
	};
}

////////////////////////////////
//  Constants

const CLAUDE_PROJECTS = "projects";
// $1 projects folder, $2 conversation id. Prints removed paths.
const CONTAINER_CLAUDE_DELETE = [
	'[ -d "$1" ] || exit 0',
	'find "$1" -mindepth 2 -maxdepth 2 \\( -name "$2.jsonl" -o -name "$2" \\) -print -exec rm -rf -- {} +',
].join("\n");

// Prints removed paths.
const CONTAINER_FILES_DELETE = [
	"failed=0",
	'for file; do [ -e "$file" ] || continue; rm -f -- "$file" && echo "$file" || failed=1; done',
	"exit $failed",
].join("\n");

////////////////////////////////
//  Functions & Helpers

function placeOf(target: AgentExecutionTarget): Place {
	return target.kind === "host" ? { kind: "host", name: "host" } : { kind: "devcontainer", name: target.project };
}

function isAbsent(error: unknown): boolean {
	return classifyPeekError(error instanceof Error ? error.message : String(error)) === "absent";
}

/** Transcript and side folder. */
function deleteHostConversation(files: PurgeHostFiles, claudeDir: string, id: string): PurgeOutcome {
	const projects = path.join(claudeDir, CLAUDE_PROJECTS);
	let found = false;
	for (const project of files.directories(projects)) {
		for (const name of [`${id}.jsonl`, id]) {
			const file = path.join(projects, project, name);
			if (!files.exists(file)) continue;
			files.remove(file);
			found = true;
		}
	}
	return found ? "deleted" : "gone";
}

/** Throws on failure. Caller retries. */
export function createPurge(deps: PurgeDeps): (op: HostPurgeOp) => Promise<PurgeOutcome> {
	/** `home` is a host spawn point's. */
	const ownFiles = async (place: Place, home: PurgeHome | undefined, session: TmuxTarget): Promise<PurgeOutcome> => {
		const files = ownSessionFiles(composeSessionName(session.name, session.sessionName));
		if (home) {
			const held = files.map((file) => path.join(home.home, file)).filter((file) => deps.files.exists(file));
			for (const file of held) deps.files.remove(file);
			return held.length > 0 ? "deleted" : "gone";
		}
		const held = files.map((file) => `${CONTAINER_HOME}/${file}`);
		const removed = await deps.exec(place, ["sh", "-c", CONTAINER_FILES_DELETE, "sh", ...held]);
		return removed.trim() ? "deleted" : "gone";
	};

	const conversation = async (place: Place, home: PurgeHome | undefined, id: string): Promise<PurgeOutcome> => {
		if (home) return deleteHostConversation(deps.files, home.claudeDir, id);
		const projects = `${CONTAINER_HOME}/.claude/${CLAUDE_PROJECTS}`;
		const removed = await deps.exec(place, ["sh", "-c", CONTAINER_CLAUDE_DELETE, "sh", projects, id]);
		return removed.trim() ? "deleted" : "gone";
	};

	return async (op) => {
		const place = placeOf(op.target);
		const what = op.what;
		if (place.kind === "devcontainer") {
			try {
				await deps.exec(place, ["true"]);
			} catch (error) {
				if (isAbsent(error)) return "place_down";
				throw error;
			}
		}
		if (what.kind === "thread") {
			if (op.pane) await deps.closePane(op.pane);
			return deps.deleteThread(what.backend, op.target, what.threadId);
		}
		const home = place.kind === "host" ? deps.homeOf(op.hostSpawn) : undefined;
		// Only a home that was found can answer gone.
		if (place.kind === "host" && !(home && deps.files.exists(home.home))) return "place_down";
		// Throws for a container whose home is elsewhere.
		if (place.kind === "devcontainer") await deps.exec(place, ["test", "-d", CONTAINER_HOME]);
		if (what.kind === "files") {
			if (!op.pane) return ownFiles(place, home, what.session);
			// Purge precedes same-name launches.
			let outcome: PurgeOutcome = "gone";
			await deps.closePane(op.pane, async () => {
				outcome = await ownFiles(place, home, what.session);
			});
			return outcome;
		}
		if (op.pane) await deps.closePane(op.pane);
		return conversation(place, home, what.conversationId);
	};
}
