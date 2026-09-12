// The one reader of a workspace file: regular files only, sized before the read, text or nothing.
//
// Shared by the refs snapshot road and the phone's file road, so neither grows a second set of rules.
// Containment is NOT decided here; a caller passes a path `confine` already admitted.

import fs from "node:fs";

/** What may be OPENED. A sender's own cap bounds what it then ships. */
const MAX_SOURCE_BYTES = 8_000_000;

////////////////////////////////
//  Interfaces & Types

/** Every failure is hard: this tier never degrades. */
export type FileFailure = "missing" | "unreadable" | "binary";

export interface LoadedFile {
	/** As written, kept for messages and manifest keys. */
	shown: string;
	absolute: string;
	/** UTF-8. A UTF-16 source is transcoded, and every coordinate downstream refers to THIS. */
	text: string;
	bytes: number;
}

export type LoadResult = { ok: true; file: LoadedFile } | { ok: false; failure: FileFailure; detail: string };

////////////////////////////////
//  Functions & Helpers

/** A UTF-16 BOM is checked FIRST: those files are full of NULs, which a UTF-8 sniff calls binary. */
function decodeText(buffer: Buffer): string | null {
	if (buffer.length >= 2) {
		if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
		if (buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.subarray(2).swap16().toString("utf16le");
	}

	// toString never fails, so a NUL is the reliable binary tell.
	const head = buffer.subarray(0, 8192);
	if (head.includes(0)) return null;

	const text = buffer.toString("utf8");
	// Round-tripping catches what toString silently replaced.
	return Buffer.from(text, "utf8").equals(buffer) ? text : null;
}

/** Refusals are loud: a silently skipped file leaves the caller believing it was read. */
export function loadWorkspaceFile(absolute: string, shown: string): LoadResult {
	if (shown === "") return { ok: false, failure: "missing", detail: `a path is required` };

	let buffer: Buffer;
	try {
		const stat = fs.statSync(absolute);
		if (!stat.isFile()) return { ok: false, failure: "unreadable", detail: `${shown} is not a file` };
		// Sized BEFORE reading, or a huge file is already in memory.
		if (stat.size > MAX_SOURCE_BYTES) {
			return {
				ok: false,
				failure: "unreadable",
				detail: `${shown} is ${stat.size} bytes, over the ${MAX_SOURCE_BYTES}-byte source limit`,
			};
		}
		buffer = fs.readFileSync(absolute);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { ok: false, failure: "missing", detail: `${shown} does not exist` };
		}
		return { ok: false, failure: "unreadable", detail: `${shown}: ${(err as Error).message}` };
	}

	const text = decodeText(buffer);
	if (text === null) return { ok: false, failure: "binary", detail: `${shown} is not text` };

	return { ok: true, file: { shown, absolute, text, bytes: Buffer.byteLength(text, "utf8") } };
}
