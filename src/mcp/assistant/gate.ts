// The assistant's PreToolUse gate: a closed allowlist by exact tool name, and notes-only paths.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ASSISTANT_CROSSTALK_TOOLS,
	ASSISTANT_REPLY_TOOLS,
	ASSISTANT_SWITCHBOARD_TOOLS,
	SWITCHBOARD_TOOL_PREFIX,
} from "../../shared/assistant-session.js";
import { CHANNEL_FILES_DIR } from "../channel/channelFiles.js";
import { confine, type Withhold } from "../workspace/confine.js";

/** `lock`: its `AGENTS.md`, so the write lock decides. */
export type GateVerdict = { allow: true; lock?: true } | { allow: false; reason: string };

const SWITCHBOARD_TOOLS: ReadonlySet<string> = new Set(ASSISTANT_SWITCHBOARD_TOOLS);

/** Uploading tools, by ref field. */
const UPLOADING_TOOLS: Readonly<Record<string, string>> = {
	[ASSISTANT_REPLY_TOOLS.reply]: "full",
	[ASSISTANT_REPLY_TOOLS.notify]: "full",
	[ASSISTANT_CROSSTALK_TOOLS.send]: "body",
};

/** Built-ins that take no path. `ToolSearch` loads a deferred tool's schema. */
const FREE_TOOLS: ReadonlySet<string> = new Set(["ToolSearch"]);

/** Path and glob inputs per read tool; an absent path means the working directory. */
const READ_TOOLS: Readonly<Record<string, { key: string; optional: boolean; glob?: string }>> = {
	Read: { key: "file_path", optional: false },
	Glob: { key: "path", optional: true, glob: "pattern" },
	Grep: { key: "path", optional: true, glob: "glob" },
};

/** A refusal reason stays well under a pipe buffer. */
const MAX_REASON_CHARS = 400;

const WRITE_TOOLS: Readonly<Record<string, string>> = {
	Write: "file_path",
	Edit: "file_path",
	MultiEdit: "file_path",
	NotebookEdit: "notebook_path",
};

/** Files Claude Code loads as instructions, at any depth. */
const INSTRUCTION_FILES: ReadonlySet<string> = new Set(["agents.md", "claude.md", "claude.local.md"]);

/** What the session cannot write: settings, and instructions but its own `AGENTS.md`. */
const protectedWrite: Withhold = (segments) => {
	const lower = segments.map((segment) => segment.toLowerCase());
	const settings = lower.indexOf(".claude");
	if (settings !== -1) return segments[settings] ?? null;
	const leaf = lower.at(-1);
	if (leaf === "agents.md" && segments.length === 1) return null;
	if (leaf !== undefined && INSTRUCTION_FILES.has(leaf)) return segments.at(-1) ?? null;
	if (lower[0] === ".mcp.json") return segments[0] ?? null;
	return null;
};

function refuse(reason: string): GateVerdict {
	return { allow: false, reason: `assistant gate: ${reason}`.slice(0, MAX_REASON_CHARS) };
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** A leading `~` names home, as the tools read it. Another user's `~` is refused. */
function expandHome(written: string, home: string): string | null {
	if (written === "~") return home;
	if (written.startsWith("~/")) return path.join(home, written.slice(2));
	return written.startsWith("~") ? null : written;
}

/** A dangling link is followed by a write, so containment of its parent proves nothing. */
function danglingLink(root: string, absolute: string): string | null {
	for (let at = absolute; at !== root && at !== path.dirname(at); at = path.dirname(at)) {
		try {
			if (fs.lstatSync(at).isSymbolicLink() && !fs.existsSync(at)) return at;
		} catch {
			// Absent, so nothing to follow.
		}
	}
	return null;
}

/** A second name for one file, which resolving the path cannot see. */
function hardlinked(absolute: string): boolean {
	try {
		const stat = fs.statSync(absolute);
		return stat.isFile() && stat.nlink > 1;
	} catch {
		return false;
	}
}

/** Judged by what it resolves to. */
function placeIn(root: string, cwd: string, home: string, written: string, withhold?: Withhold): string | null {
	const expanded = expandHome(written, home);
	if (expanded === null) return `${written} names another user's home`;
	const absolute = path.resolve(cwd, expanded);
	const relative = path.relative(root, absolute);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return `${written} is outside notes`;
	}
	const placed = confine(root, relative, process.platform, withhold);
	if (!placed.ok) return `${written}: ${placed.refusal.detail}`;
	if (danglingLink(root, absolute)) return `${written} goes through a dangling link`;
	return hardlinked(absolute) ? `${written} has another name` : null;
}

/** Every alternative's start can name a root, not only the pattern's. */
function patternEscapes(pattern: unknown): boolean {
	if (pattern === undefined) return false;
	if (typeof pattern !== "string") return true;
	if (pattern.split(/[\\/{},]/).includes("..")) return true;
	for (let at = 0; at < pattern.length; at++) {
		const starts = at === 0 || pattern[at - 1] === "{" || pattern[at - 1] === ",";
		if (starts && "/\\~".includes(pattern[at] as string)) return true;
	}
	return path.isAbsolute(pattern);
}

/** A `ref://` resolves bare paths against notes, but `/` and `~` reach anywhere. */
function refLeaves(text: unknown): boolean {
	if (text === undefined) return false;
	if (typeof text !== "string") return true;
	for (const match of text.matchAll(/ref:\/\/([^\s)>]*)/g)) {
		let destination = match[1] ?? "";
		try {
			destination = decodeURIComponent(destination);
		} catch {
			return true;
		}
		if (/^[/\\~]/.test(destination) || destination.split(/[\\/:#]/).includes("..")) return true;
	}
	return false;
}

export interface GatePlaces {
	/** The notes directory. */
	notes: string;
	/** Where sent attachments land, also readable. */
	attachments?: string;
	home?: string;
}

export function gateVerdict(input: unknown, places: GatePlaces): GateVerdict {
	const { notes: root, attachments = CHANNEL_FILES_DIR, home = os.homedir() } = places;
	const hook = record(input);
	const tool = hook?.tool_name;
	if (typeof tool !== "string") return refuse("no tool named");
	const params = record(hook?.tool_input) ?? {};
	const cwd = typeof hook?.cwd === "string" ? hook.cwd : root;

	if (FREE_TOOLS.has(tool)) return { allow: true };

	const readable = (written: unknown): string | null => {
		if (typeof written !== "string" || written === "") return "names no path";
		const outside = placeIn(root, cwd, home, written);
		return !outside || !placeIn(attachments, cwd, home, written) ? null : outside;
	};

	if (tool.startsWith(SWITCHBOARD_TOOL_PREFIX)) {
		const bare = tool.slice(SWITCHBOARD_TOOL_PREFIX.length);
		if (!SWITCHBOARD_TOOLS.has(bare)) return refuse(`${tool} is not on the assistant's allowlist`);
		const textField = Object.hasOwn(UPLOADING_TOOLS, bare) ? UPLOADING_TOOLS[bare] : undefined;
		if (textField) {
			const files = params.attachments ?? [];
			if (!Array.isArray(files)) return refuse(`${bare} attachments are not a list`);
			for (const file of files) {
				const outside = readable(file);
				if (outside) return refuse(`${bare} attachment ${String(file)}: ${outside}`);
			}
			if (refLeaves(params[textField])) return refuse(`${bare} refs a file outside notes`);
		}
		return { allow: true };
	}

	const read = READ_TOOLS[tool];
	if (read) {
		if (read.glob && patternEscapes(params[read.glob])) return refuse(`${tool} pattern leaves notes`);
		const given = params[read.key];
		const outside = readable(given === undefined && read.optional ? "." : given);
		return outside ? refuse(`${tool} ${outside}`) : { allow: true };
	}

	const writeKey = WRITE_TOOLS[tool];
	if (writeKey) {
		const written = params[writeKey];
		if (typeof written !== "string" || written === "") return refuse(`${tool} names no path`);
		const outside = placeIn(root, cwd, home, written, protectedWrite);
		if (outside) return refuse(outside);
		return ownInstructions(root, cwd, home, written) ? { allow: true, lock: true } : { allow: true };
	}

	return refuse(`${tool} is not on the assistant's allowlist`);
}

/** Its root `AGENTS.md`, by name or through a link. */
function ownInstructions(root: string, cwd: string, home: string, written: string): boolean {
	const expanded = expandHome(written, home);
	if (expanded === null) return false;
	const real = (at: string) => {
		try {
			return fs.realpathSync.native(at);
		} catch {
			// Not there yet: as written.
			return at;
		}
	};
	return path.relative(real(root), real(path.resolve(cwd, expanded))).toLowerCase() === "agents.md";
}

/** The refusal a locked `AGENTS.md` write gets; null idle is since it started. */
export function writeLockReason(idleMs: number | null): string {
	const minutes = idleMs === null ? null : Math.floor(idleMs / 60_000);
	const idle =
		minutes === null
			? "has not heard from the owner since it started"
			: `has been idle for ${minutes < 120 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} hours`}`;
	return `
AGENTS.md is locked: this session ${idle}. The owner must reply once to unlock it. Ask in any form that shows what is changing, for example:

Can I adjust my rules about:
- XXX to YYY

Once they reply with approval, try the write again.
	`.trim();
}
