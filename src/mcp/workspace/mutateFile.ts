// File mutations the phone asks for, and the file state it names in them: plain file work over confined
// paths, never through Lexicon.
//
// Each kind names what it expects to find, and nothing lands unless it does. Files only: a folder is refused
// as a source and as a destination, since a precondition over every child is not something one hash names.

import fs from "node:fs";
import path from "node:path";
import {
	createFileExclusive,
	LinksUnsupported,
	moveFileAtomic,
	NameTaken,
	writeFileAtomic,
} from "../../shared/atomic-write.js";
import {
	type FileDestination,
	type FileMutation,
	type FileMutationAnswer,
	type FileStateAnswer,
	MAX_HASHED_BYTES,
	MAX_RAW_EDIT_BYTES,
	MAX_WORKSPACE_OP_BYTES,
	type WorkspaceOpResult,
} from "../../shared/workspace-op.js";
import { confine, fileIdentity, namesOneFile } from "./confine.js";
import { hashBytes, hashFileAt, type LoadedFile, loadWorkspaceFile } from "./loadFile.js";

////////////////////////////////
//  Interfaces & Types

type Placed = { absolute: string; relative: string };

/** A check either passes with what it read, or already is the answer. */
type Checked<T> = { ok: true; value: T } | { ok: false; result: WorkspaceOpResult };

////////////////////////////////
//  Functions & Helpers

const refused = (detail: string): WorkspaceOpResult => ({ ok: false, failure: "refused", detail });

const answered = (answer: FileMutationAnswer): WorkspaceOpResult => ({ ok: true, answer });

const stop = <T>(result: WorkspaceOpResult): Checked<T> => ({ ok: false, result });

/** Thrown inside an atomic placement, so its temp is removed on the way out. */
class SourceMoved extends Error {}

class DestinationMoved extends Error {}

/** Null when a write may be offered. A write refuses what a read would not offer. */
export function readOnlyReason(file: LoadedFile): string | null {
	if (file.encoding !== "utf8") return `${file.shown} is UTF-16, which a save would rewrite as UTF-8`;
	if (file.bytes > MAX_RAW_EDIT_BYTES) return `${file.shown} is over the ${MAX_RAW_EDIT_BYTES}-byte editing limit`;
	return null;
}

const hashNow = (absolute: string): string | undefined => hashFileAt(absolute, MAX_HASHED_BYTES)?.hash;

/** Of the name, not a link's target; null when nothing is there. */
function lstatOrNull(absolute: string): fs.Stats | null {
	try {
		return fs.lstatSync(absolute);
	} catch {
		return null;
	}
}

/** Follows a link, since a link to a folder is a folder to act on. */
function isFolder(absolute: string): boolean {
	try {
		return fs.statSync(absolute).isDirectory();
	} catch {
		return false;
	}
}

function placed(root: string, written: string): Checked<Placed> {
	const place = confine(root, written);
	if (!place.ok) return stop(refused(place.refusal.detail));
	if (place.relative === "") return stop(refused("a file path is required"));
	return { ok: true, value: place };
}

function answerFor(place: Placed, outcome: FileMutationAnswer["outcome"], extra: Partial<FileMutationAnswer> = {}) {
	return answered({ kind: "mutateFile", path: place.relative, outcome, ...extra });
}

/** The file a mutation acts on, only while it still is what the phone named. */
function sourceOf(
	root: string,
	written: string,
	expectedHash: string,
	expectedIdentity?: string,
): Checked<Placed & { hash: string; mode: number }> {
	const place = placed(root, written);
	if (!place.ok) return place;
	const at = place.value;
	if (lstatOrNull(at.absolute) === null) return stop(answerFor(at, "stale", { gone: true }));
	if (isFolder(at.absolute))
		return stop(refused(`${at.relative} is a folder, and folders are not changed from here`));
	if (expectedIdentity !== undefined && fileIdentity(at.absolute) !== expectedIdentity) {
		return stop(answerFor(at, "stale"));
	}
	const hash = hashNow(at.absolute);
	if (hash === undefined) return stop(refused(`${at.relative} cannot be read, or is too large to check`));
	if (hash !== expectedHash) return stop(answerFor(at, "stale"));
	return { ok: true, value: { ...at, hash, mode: fs.statSync(at.absolute).mode & 0o777 } };
}

/** Where a move or copy lands, only while it is in the state the phone named. The answer names the source. */
function destinationOf(root: string, source: Placed, written: string, expected: FileDestination): Checked<Placed> {
	const place = placed(root, written);
	if (!place.ok) return place;
	const at = place.value;
	if (at.relative === source.relative) return stop(refused(`${at.relative} is where it already is`));
	const changed = stop<Placed>(answerFor(source, "destinationChanged"));
	if (lstatOrNull(at.absolute) === null) {
		if (expected.kind !== "absent") return changed;
		if (!isFolder(path.dirname(at.absolute))) {
			return stop(refused(`${path.posix.dirname(at.relative)} is not a folder here`));
		}
		return { ok: true, value: at };
	}
	if (isFolder(at.absolute))
		return stop(refused(`${at.relative} is a folder, and folders are not changed from here`));
	// A rename onto its own link loses the bytes; onto its own hardlink it does nothing.
	if (namesOneFile(source.absolute, at.absolute)) return stop(refused(`${at.relative} is ${source.relative}`));
	if (expected.kind !== "replace") return changed;
	if (fileIdentity(at.absolute) !== expected.expectedIdentity || hashNow(at.absolute) !== expected.expectedHash) {
		return changed;
	}
	return { ok: true, value: at };
}

/**
 * Hash compared, text written to a sibling temp, file hashed again, temp renamed over it. The gap between
 * the last hash and the rename stays open, since only a lock every writer honours would close it. The
 * rename gives the path a new inode, so a hardlink keeps the old bytes.
 */
function writeOf(root: string, write: Extract<FileMutation, { kind: "write" }>): WorkspaceOpResult {
	const place = placed(root, write.path);
	if (!place.ok) return place.result;
	const at = place.value;
	const text = Buffer.from(write.text, "utf8");
	if (text.length > MAX_WORKSPACE_OP_BYTES) {
		return refused(`the text is ${text.length} bytes, over the ${MAX_WORKSPACE_OP_BYTES}-byte limit`);
	}

	const before = loadWorkspaceFile(at.absolute, at.relative);
	if (!before.ok)
		return before.failure === "missing" ? answerFor(at, "stale", { gone: true }) : refused(before.detail);
	if (before.file.hash !== write.expectedHash) return answerFor(at, "stale");
	const readOnly = readOnlyReason(before.file);
	if (readOnly !== null) return refused(readOnly);

	// Renamed onto the link's target, since renaming onto the link turns it into a file.
	const real = fs.realpathSync.native(at.absolute);
	const realRoot = fs.realpathSync.native(root);
	// Confined again: a link retargeted since the first resolution.
	if (!confine(realRoot, path.relative(realRoot, real)).ok) {
		return refused(`${at.relative} no longer resolves inside the workspace`);
	}
	try {
		writeFileAtomic(
			real,
			(temp) => {
				fs.writeFileSync(temp, text);
				if (hashNow(real) !== write.expectedHash) throw new SourceMoved();
			},
			{ mode: fs.statSync(real).mode & 0o7777, fsyncFile: true, fsyncDirectory: true },
		);
	} catch (error) {
		if (error instanceof SourceMoved) return answerFor(at, "stale");
		throw error;
	}
	return answerFor(at, "done", { hash: hashBytes(text) });
}

/** Linked into place from a temp, so the name appears whole, and only where nothing was. */
function createOf(root: string, create: Extract<FileMutation, { kind: "create" }>): WorkspaceOpResult {
	const place = placed(root, create.path);
	if (!place.ok) return place.result;
	const at = place.value;
	const text = Buffer.from(create.text, "utf8");
	if (text.length > MAX_WORKSPACE_OP_BYTES) {
		return refused(`the text is ${text.length} bytes, over the ${MAX_WORKSPACE_OP_BYTES}-byte limit`);
	}
	if (lstatOrNull(at.absolute) !== null) return answerFor(at, "destinationChanged");
	if (!isFolder(path.dirname(at.absolute))) return refused(`${path.posix.dirname(at.relative)} is not a folder here`);
	try {
		createFileExclusive(at.absolute, text);
	} catch (error) {
		if (error instanceof NameTaken) return answerFor(at, "destinationChanged");
		throw error;
	}
	return answerFor(at, "done", { hash: hashBytes(text) });
}

/**
 * Identity and hash checked, identity checked again, then unlinked. A link is removed, not its target. The
 * gap between the last check and the unlink stays open, as a write's does.
 */
function deleteOf(root: string, remove: Extract<FileMutation, { kind: "delete" }>): WorkspaceOpResult {
	const source = sourceOf(root, remove.path, remove.expectedHash, remove.expectedIdentity);
	if (!source.ok) return source.result;
	const at = source.value;
	if (fileIdentity(at.absolute) !== remove.expectedIdentity) return answerFor(at, "stale");
	fs.unlinkSync(at.absolute);
	return answerFor(at, "done");
}

/**
 * Keeps the inode: linked then unlinked onto an absent name, renamed over a named one. The source's identity is
 * checked again after the destination is read, as a delete's is.
 */
function moveOf(root: string, move: Extract<FileMutation, { kind: "move" }>): WorkspaceOpResult {
	const source = sourceOf(root, move.path, move.expectedHash, move.expectedIdentity);
	if (!source.ok) return source.result;
	const destination = destinationOf(root, source.value, move.to, move.destination);
	if (!destination.ok) return destination.result;
	if (fileIdentity(source.value.absolute) !== move.expectedIdentity) return answerFor(source.value, "stale");
	try {
		moveFileAtomic(source.value.absolute, destination.value.absolute, {
			replace: move.destination.kind === "replace",
		});
	} catch (error) {
		if (error instanceof NameTaken) return answerFor(source.value, "destinationChanged");
		if (error instanceof LinksUnsupported) {
			return refused(`this filesystem cannot move to a free name without risking a replace; copy, then delete`);
		}
		if ((error as NodeJS.ErrnoException).code === "EXDEV") {
			return refused(`${move.to} is on another filesystem, and a move there is not one step`);
		}
		throw error;
	}
	return answerFor(source.value, "done", { hash: source.value.hash });
}

/**
 * Copied into a temp, which is hashed against what the phone named, then placed as a create or a write is.
 * What lands is the bytes the phone saw, whatever the source became during the copy.
 */
function copyOf(root: string, copy: Extract<FileMutation, { kind: "copy" }>): WorkspaceOpResult {
	const source = sourceOf(root, copy.path, copy.expectedHash);
	if (!source.ok) return source.result;
	const from = source.value;
	const destination = destinationOf(root, from, copy.to, copy.destination);
	if (!destination.ok) return destination.result;
	const to = destination.value.absolute;
	const fill = (temp: string) => {
		fs.copyFileSync(from.absolute, temp);
		if (hashFileAt(temp, MAX_HASHED_BYTES)?.hash !== copy.expectedHash) throw new SourceMoved();
	};
	try {
		if (copy.destination.kind === "absent") {
			createFileExclusive(to, fill, { mode: from.mode });
		} else {
			const named = copy.destination;
			writeFileAtomic(
				to,
				(temp) => {
					fill(temp);
					if (fileIdentity(to) !== named.expectedIdentity || hashNow(to) !== named.expectedHash) {
						throw new DestinationMoved();
					}
				},
				{ mode: from.mode, fsyncFile: true, fsyncDirectory: true },
			);
		}
	} catch (error) {
		if (error instanceof SourceMoved) return answerFor(from, "stale");
		if (error instanceof NameTaken || error instanceof DestinationMoved)
			return answerFor(from, "destinationChanged");
		throw error;
	}
	return answerFor(from, "done", { hash: from.hash });
}

/** What a mutation would name: absent, a folder, or a file with its size, hash and identity. */
export function fileStateOf(root: string, written: string): WorkspaceOpResult {
	const place = confine(root, written);
	if (!place.ok) return refused(place.refusal.detail);
	const at = place;
	const state = (value: Omit<FileStateAnswer, "kind" | "path">): WorkspaceOpResult => ({
		ok: true,
		answer: { kind: "fileState", path: at.relative, ...value },
	});
	if (lstatOrNull(at.absolute) === null) return state({ state: "absent" });
	const identity = fileIdentity(at.absolute) ?? undefined;
	if (isFolder(at.absolute)) return state({ state: "directory", ...(identity ? { identity } : {}) });
	const hashed = hashFileAt(at.absolute, MAX_HASHED_BYTES);
	let bytes: number | undefined;
	try {
		bytes = fs.statSync(at.absolute).size;
	} catch {
		bytes = undefined;
	}
	return state({
		state: "file",
		...(bytes === undefined ? {} : { bytes }),
		...(hashed ? { hash: hashed.hash } : {}),
		...(identity ? { identity } : {}),
	});
}

/** A throw reaches the phone as `unknown`, which it settles by reading back. */
export function mutateFile(root: string, mutation: FileMutation): WorkspaceOpResult {
	switch (mutation.kind) {
		case "write":
			return writeOf(root, mutation);
		case "create":
			return createOf(root, mutation);
		case "delete":
			return deleteOf(root, mutation);
		case "move":
			return moveOf(root, mutation);
		case "copy":
			return copyOf(root, mutation);
	}
}
