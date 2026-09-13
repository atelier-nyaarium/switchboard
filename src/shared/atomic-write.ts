import fs from "node:fs";
import path from "node:path";

////////////////////////////////
//  Interfaces & Types

/** The bytes to land, or a function that fills the temp file itself (a copy from elsewhere). */
export type AtomicSource = string | Uint8Array | ((temp: string) => void);

export interface AtomicWriteOptions {
	/** Applied when the temp is created, so the final file never exists with a looser mode. */
	mode?: number;
	/** fsync the temp before the rename, so the bytes are on disk before the name points at them. */
	fsyncFile?: boolean;
	/** fsync the directory after the rename, so the new name itself survives a crash. */
	fsyncDirectory?: boolean;
	/** Runs after the rename, on the final path. For metadata the temp cannot carry, like an mtime. */
	afterRename?: (file: string) => void;
	/** The file is already in place when this fires, which is a different failure from a lost write.
	 * A caller that tells those apart throws its own error here. */
	onDirectorySyncError?: (error: unknown) => never;
}

////////////////////////////////
//  Constants

/** The one spelling of a temp name. The pid is what lets the sweep tell a leftover from a write
 * another process is in the middle of. */
export const ATOMIC_TEMP_SUFFIX = `.tmp.${process.pid}`;
const ATOMIC_TEMP_RE = /\.tmp\.(\d+)$/;

////////////////////////////////
//  Functions & Helpers

export function isAtomicTemp(name: string): boolean {
	return ATOMIC_TEMP_RE.test(name);
}

export function renameFileSync(from: string, to: string): void {
	fs.renameSync(from, to);
}

/** Whether the process that named this temp is still running. A signal of 0 checks without
 * sending; EPERM means it exists under another user, which is still alive. */
function writerAlive(name: string): boolean {
	const pid = Number(ATOMIC_TEMP_RE.exec(name)?.[1]);
	if (!Number.isFinite(pid) || pid <= 0) return false;
	if (pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Write-then-rename: the target either keeps its old bytes or has all the new ones, never a mix,
 * and a crash leaves at most a temp file the next startup sweeps. Every writer in the codebase goes
 * through here so the sweep and the writers cannot disagree on what a temp looks like.
 */
export function writeFileAtomic(file: string, source: AtomicSource, options: AtomicWriteOptions = {}): void {
	const directory = path.dirname(file);
	const temp = `${file}${ATOMIC_TEMP_SUFFIX}`;
	fs.mkdirSync(directory, { recursive: true });
	let renamed = false;
	try {
		if (typeof source === "function") {
			source(temp);
			// The fill created the temp itself, so the mode has to be applied after the fact.
			if (options.mode !== undefined) fs.chmodSync(temp, options.mode);
		} else fs.writeFileSync(temp, source, options.mode === undefined ? undefined : { mode: options.mode });
		if (options.fsyncFile) {
			const descriptor = fs.openSync(temp, "r");
			try {
				fs.fsyncSync(descriptor);
			} finally {
				fs.closeSync(descriptor);
			}
		}
		renameFileSync(temp, file);
		renamed = true;
		options.afterRename?.(file);
		if (options.fsyncDirectory && process.platform !== "win32") {
			try {
				const descriptor = fs.openSync(directory, "r");
				try {
					fs.fsyncSync(descriptor);
				} finally {
					fs.closeSync(descriptor);
				}
			} catch (error) {
				if (options.onDirectorySyncError) options.onDirectorySyncError(error);
				throw error;
			}
		}
	} finally {
		// A failure before the rename leaves the temp behind, and only the sweep would ever remove it.
		// The cleanup's own failure must not replace the error that got us here.
		if (!renamed) {
			try {
				fs.rmSync(temp, { force: true });
			} catch {}
		}
	}
}

/** Thrown when a name that must be absent is taken; nothing was placed there. */
export class NameTaken extends Error {}

/** A filesystem that cannot hardlink. */
function noHardlinks(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS";
}

function syncDirectory(directory: string): void {
	if (process.platform === "win32") return;
	const descriptor = fs.openSync(directory, "r");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

/** Thrown when a filesystem cannot link, so a move could not refuse a taken name; nothing was moved. */
export class LinksUnsupported extends Error {}

/**
 * Write-then-link: the name appears with all its bytes or not at all, and only where nothing was, since a
 * link refuses a taken name where a rename would replace it. Throws `NameTaken` otherwise. Where links are not
 * supported, an exclusive copy keeps the refusal, and a reader can see the file part-written.
 */
export function createFileExclusive(file: string, source: AtomicSource, options: { mode?: number } = {}): void {
	const temp = `${file}${ATOMIC_TEMP_SUFFIX}`;
	try {
		if (typeof source === "function") {
			source(temp);
			if (options.mode !== undefined) fs.chmodSync(temp, options.mode);
		} else fs.writeFileSync(temp, source, options.mode === undefined ? undefined : { mode: options.mode });
		const descriptor = fs.openSync(temp, "r");
		try {
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		try {
			fs.linkSync(temp, file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new NameTaken(file);
			if (!noHardlinks(error)) throw error;
			try {
				fs.copyFileSync(temp, file, fs.constants.COPYFILE_EXCL);
			} catch (copyError) {
				if ((copyError as NodeJS.ErrnoException).code === "EEXIST") throw new NameTaken(file);
				throw copyError;
			}
		}
		syncDirectory(path.dirname(file));
	} finally {
		try {
			fs.rmSync(temp, { force: true });
		} catch {}
	}
}

/**
 * A move that keeps the inode. Onto an absent name it links then unlinks, so a taken name throws `NameTaken`
 * and a failure between the two leaves both names rather than neither. With `replace` it renames, which swaps
 * whatever is there in one step. Where links are not supported the absent case throws `LinksUnsupported`,
 * since checking then renaming would replace a name taken in between.
 */
export function moveFileAtomic(from: string, to: string, options: { replace: boolean }): void {
	if (options.replace) {
		renameFileSync(from, to);
	} else {
		try {
			fs.linkSync(from, to);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new NameTaken(to);
			if (noHardlinks(error)) throw new LinksUnsupported(to);
			throw error;
		}
		fs.unlinkSync(from);
	}
	syncDirectory(path.dirname(to));
	if (path.dirname(from) !== path.dirname(to)) syncDirectory(path.dirname(from));
}

/**
 * Removes temps a dead writer left in a directory. Returns their names, for the log.
 *
 * A temp whose writer is still alive is left alone: it may be mid-write in another process that
 * shares the directory, and removing it would turn that write into a lost one.
 */
export function sweepAtomicTemps(directory: string): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const entry of entries) {
		if (!isAtomicTemp(entry) || writerAlive(entry)) continue;
		fs.rmSync(path.join(directory, entry), { force: true });
		removed.push(entry);
	}
	return removed;
}
