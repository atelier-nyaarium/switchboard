// The assistant's PreToolUse gate: a closed allowlist by exact tool name, and notes-only paths.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNEL_FILES_DIR } from "../channel/channelFiles.js";
import { confine, type Withhold } from "../workspace/confine.js";

export type GateVerdict = { allow: true } | { allow: false; reason: string };

const SWITCHBOARD_TOOL_PREFIX = "mcp__plugin_switchboard_switchboard__";

/** Switchboard tools the assistant may call. */
export const ASSISTANT_SWITCHBOARD_TOOLS: ReadonlySet<string> = new Set(["channel_reply", "switchboard_capabilities"]);

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

/** What the session cannot write: its own instructions and settings, and the rules that sort events. */
const protectedWrite: Withhold = (segments) => {
	const lower = segments.map((segment) => segment.toLowerCase());
	const settings = lower.indexOf(".claude");
	if (settings !== -1) return segments[settings] ?? null;
	const leaf = lower.at(-1);
	if (leaf !== undefined && INSTRUCTION_FILES.has(leaf)) return segments.at(-1) ?? null;
	if (lower[0] === "watchers" || lower[0] === ".mcp.json") return segments[0] ?? null;
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
function refLeaves(full: unknown): boolean {
	if (typeof full !== "string") return false;
	for (const match of full.matchAll(/ref:\/\/([^\s)>]*)/g)) {
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
		if (!ASSISTANT_SWITCHBOARD_TOOLS.has(bare)) return refuse(`${tool} is not on the assistant's allowlist`);
		// A reply uploads its attachments and snapshots its refs.
		if (bare === "channel_reply") {
			const files = params.attachments ?? [];
			if (!Array.isArray(files)) return refuse("channel_reply attachments are not a list");
			for (const file of files) {
				const outside = readable(file);
				if (outside) return refuse(`channel_reply attachment ${String(file)}: ${outside}`);
			}
			if (refLeaves(params.full)) return refuse("channel_reply refs a file outside notes");
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
		return outside ? refuse(outside) : { allow: true };
	}

	return refuse(`${tool} is not on the assistant's allowlist`);
}
