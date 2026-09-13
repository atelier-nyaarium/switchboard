// File mutations the phone asks for: plain file work over confined paths, never through Lexicon.
//
// Each kind names what it expects to find, and nothing lands unless it does.

import fs from "node:fs";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import {
	type FileMutation,
	type FileMutationAnswer,
	MAX_RAW_EDIT_BYTES,
	MAX_WORKSPACE_OP_BYTES,
	type WorkspaceOpResult,
} from "../../shared/workspace-op.js";
import { confine } from "./confine.js";
import { hashBytes, type LoadedFile, loadWorkspaceFile } from "./loadFile.js";

////////////////////////////////
//  Functions & Helpers

const refused = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "refused", detail });

const answered = (answer: FileMutationAnswer): WorkspaceOpResult => ({ ok: true, answer });

/** Thrown inside the atomic write, so its temp is removed on the way out. */
class MovedUnderWrite extends Error {}

/** Null when a write may be offered. A write refuses what a read would not offer. */
export function readOnlyReason(file: LoadedFile): string | null {
	if (file.encoding !== "utf8") return `${file.shown} is UTF-16, which a save would rewrite as UTF-8`;
	if (file.bytes > MAX_RAW_EDIT_BYTES) return `${file.shown} is over the ${MAX_RAW_EDIT_BYTES}-byte editing limit`;
	return null;
}

function hashNow(file: string): string | null {
	try {
		return hashBytes(fs.readFileSync(file));
	} catch {
		return null;
	}
}

/**
 * Hash compared, text written to a sibling temp, file hashed again, temp renamed over it. The gap between
 * the last hash and the rename stays open, since only a lock every writer honours would close it. The
 * rename gives the path a new inode, so a hardlink keeps the old bytes.
 */
function writeOf(root: string, write: Extract<FileMutation, { kind: "write" }>): WorkspaceOpResult {
	const place = confine(root, write.path);
	if (!place.ok) return refused(place.refusal.detail);
	if (place.relative === "") return refused("a file path is required");
	const text = Buffer.from(write.text, "utf8");
	if (text.length > MAX_WORKSPACE_OP_BYTES) {
		return refused(`the text is ${text.length} bytes, over the ${MAX_WORKSPACE_OP_BYTES}-byte limit`);
	}

	const stale = (gone?: true): WorkspaceOpResult =>
		answered({ kind: "mutateFile", path: place.relative, outcome: "stale", ...(gone ? { gone } : {}) });

	const before = loadWorkspaceFile(place.absolute, place.relative);
	if (!before.ok) return before.failure === "missing" ? stale(true) : refused(before.detail);
	if (before.file.hash !== write.expectedHash) return stale();
	const readOnly = readOnlyReason(before.file);
	if (readOnly !== null) return refused(readOnly);

	// Renamed onto the link's target, since renaming onto the link turns it into a file.
	const real = fs.realpathSync.native(place.absolute);
	try {
		writeFileAtomic(
			real,
			(temp) => {
				fs.writeFileSync(temp, text);
				if (hashNow(real) !== write.expectedHash) throw new MovedUnderWrite();
			},
			{ mode: fs.statSync(real).mode & 0o7777, fsyncFile: true, fsyncDirectory: true },
		);
	} catch (error) {
		if (error instanceof MovedUnderWrite) return stale();
		throw error;
	}
	return answered({ kind: "mutateFile", path: place.relative, outcome: "done", hash: hashBytes(text) });
}

/** A throw reaches the phone as `unknown`, which it settles by reading back. */
export function mutateFile(root: string, mutation: FileMutation): WorkspaceOpResult {
	switch (mutation.kind) {
		case "write":
			return writeOf(root, mutation);
	}
}
