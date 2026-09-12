// Path decisions for the phone's file road.
//
// NOT a security boundary: the session here can already run commands, so this adds no authority. It
// buys a tree that cannot wander and a refused mis-tap.
//
// An admitted path is a decision, not a handle. A mutating caller re-compares `fileIdentity`.

import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

export type ConfineRefusal =
	| { kind: "outside"; detail: string }
	| { kind: "excluded"; detail: string }
	| { kind: "unspellable"; detail: string };

/** POSIX-separated, matching a Lexicon module path. Empty is the root. */
export type Confined = { ok: true; absolute: string; relative: string } | { ok: false; refusal: ConfineRefusal };

/** The bytes, not the name, so two names for one inode compare equal. */
export type FileIdentity = { dev: number; ino: number };

////////////////////////////////
//  Constants

/** Withheld at any depth, from reads and listings alike. */
const WITHHELD_SEGMENTS = new Set([".git"]);

/** Bulk rather than secrets, so hidden from a listing and served when named. */
const UNLISTED_SEGMENTS = new Set(["node_modules"]);

/** Committed and secretless. */
const ENV_SUFFIXES_SERVED = new Set(["example", "sample", "template"]);

const RESERVED_NAMES = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

////////////////////////////////
//  Functions & Helpers

function withheldLeaf(lower: string): boolean {
	if (lower === ".env") return true;
	if (!lower.startsWith(".env.")) return false;
	return !ENV_SUFFIXES_SERVED.has(lower.slice(".env.".length));
}

function controlCharacters(segment: string): boolean {
	for (const char of segment) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Windows only: the plugin serves its OWN filesystem, and a colon is legal elsewhere. Trailing dots
 * and spaces are trimmed first, since Windows drops them and `CON ` reaches the device.
 */
function windowsUnspellable(segment: string): string | null {
	if (segment.includes(":")) return `"${segment}" names an alternate data stream`;
	const base = (segment.split(".")[0] ?? "").replace(/[. ]+$/, "").toLowerCase();
	if (RESERVED_NAMES.has(base)) return `"${segment}" is a reserved device name`;
	return null;
}

/** Only what resolution cannot settle. A short name or junction resolves, so containment covers it. */
function unspellable(segment: string, windows: boolean): string | null {
	if (controlCharacters(segment)) return `"${segment}" holds a control character`;
	return windows ? windowsUnspellable(segment) : null;
}

/** The nearest ancestor that exists, so a path being created still gets a canonical check. */
function nearestExisting(start: string): string {
	let at = start;
	for (;;) {
		if (fs.existsSync(at)) return at;
		const up = path.dirname(at);
		if (up === at) return at;
		at = up;
	}
}

function realOrSelf(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return target;
	}
}

/**
 * ONE resolution answers all three, so they cannot disagree. A separate existence check left a window
 * where a link created between the two calls was admitted.
 */
function resolveTarget(absolute: string): { real: string; exists: boolean; directory: boolean } {
	try {
		const real = fs.realpathSync.native(absolute);
		return { real, exists: true, directory: fs.statSync(real).isDirectory() };
	} catch {
		return { real: realOrSelf(nearestExisting(absolute)), exists: false, directory: false };
	}
}

function escapes(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function segmentsOf(root: string, absolute: string): string[] {
	const relative = path.relative(root, absolute);
	return relative === "" ? [] : relative.split(path.sep);
}

/** Null when every segment is servable. */
function withheld(segments: string[], leafIsTarget: boolean): string | null {
	for (const [index, segment] of segments.entries()) {
		const lower = segment.toLowerCase();
		const last = index === segments.length - 1;
		if (WITHHELD_SEGMENTS.has(lower) || (last && leafIsTarget && withheldLeaf(lower))) return segment;
	}
	return null;
}

/**
 * Every rule runs against what the path RESOLVES to, not how it was spelled, because a link defeats
 * either check applied to the spelling alone.
 *
 * An empty path is the root, which a listing needs; a read of it fails as not-a-file at load.
 */
export function confine(root: string, relativeWritten: string, platform: string = process.platform): Confined {
	if (path.isAbsolute(relativeWritten) || /^[A-Za-z]:/.test(relativeWritten)) {
		return { ok: false, refusal: { kind: "outside", detail: `${relativeWritten} is not workspace-relative` } };
	}

	const absolute = path.resolve(root, relativeWritten);
	if (escapes(root, absolute)) {
		return { ok: false, refusal: { kind: "outside", detail: `${relativeWritten} leaves the workspace` } };
	}

	const segments = segmentsOf(root, absolute);

	for (const segment of segments) {
		const reason = unspellable(segment, platform === "win32");
		if (reason) return { ok: false, refusal: { kind: "unspellable", detail: reason } };
	}

	const realRoot = realOrSelf(root);
	const target = resolveTarget(absolute);

	// A directory holds no bytes, so withholding its name would only block listing it.
	const leafRule = !target.directory;

	const spelled = withheld(segments, leafRule);
	if (spelled) return { ok: false, refusal: { kind: "excluded", detail: `${spelled} is not served` } };

	if (target.real !== realRoot && escapes(realRoot, target.real)) {
		return { ok: false, refusal: { kind: "outside", detail: `${relativeWritten} resolves outside the workspace` } };
	}

	// Creation resolves to an ancestor, whose leaf is not this target's leaf.
	const resolved = withheld(segmentsOf(realRoot, target.real), target.exists && leafRule);
	if (resolved)
		return { ok: false, refusal: { kind: "excluded", detail: `${relativeWritten} resolves to ${resolved}` } };

	return { ok: true, absolute, relative: segments.join("/") };
}

/** Null when unstattable, which a caller reads as nothing to compare against. */
export function fileIdentity(absolute: string): FileIdentity | null {
	try {
		const stat = fs.lstatSync(absolute);
		return { dev: stat.dev, ino: stat.ino };
	} catch {
		return null;
	}
}

/** A mutation names the bytes it read, so a hardlink is caught by identity. */
export function sameFile(a: FileIdentity | null, b: FileIdentity | null): boolean {
	return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/** Hides bulk as well as what `confine` refuses. */
export function listable(name: string, last: boolean, platform: string = process.platform): boolean {
	const lower = name.toLowerCase();
	if (WITHHELD_SEGMENTS.has(lower) || UNLISTED_SEGMENTS.has(lower)) return false;
	if (last && withheldLeaf(lower)) return false;
	return unspellable(name, platform === "win32") === null;
}
