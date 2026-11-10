import fs from "node:fs";
import path from "node:path";
import { isAtomicTemp } from "../shared/atomic-write.js";

////////////////////////////////
//  Constants

/** Pinned against source openers by `data-dir-inventory.test.ts`. */
export const DATA_DIR_ENTRIES: ReadonlySet<string> = new Set([
	"blobs",
	"federation",
	"inbox-claims",
	"schema-version",
	"migration-epoch",
	"assistant-home.json",
	"assistant-open-acts.json",
	"assistant-open-sends.json",
	"assistant-phone-requests.json",
	"assistant-rules.json",
	"assistant-safety.json",
	"assistant-watcher-enabled.json",
	"assistant-watchers.json",
	"board-idempotency.json",
	"console-capabilities.json",
	"daemon-capabilities.json",
	"devices.json",
	"launches.json",
	"op-idempotency.json",
	"owner-row-outbox.json",
	"pending-deliveries.json",
	"pending-jobs.json",
	"pending-jobs-quarantine.json",
	"policies.json",
	"replay-guard.json",
	"routine-attention.json",
	"routine-memory.json",
	"routine-occurrences.json",
	"routines.json",
	"runbooks.json",
	"session-resume.json",
	"vault-decisions.json",
	"vault-open-requests.json",
	"workflows",
]);

////////////////////////////////
//  Functions & Helpers

/** Entries nothing opens; atomic temps excluded. */
export function unrecognizedDataEntries(dir: string, known: ReadonlySet<string> = DATA_DIR_ENTRIES): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return entries.filter((name) => !known.has(name) && !isAtomicTemp(name)).sort();
}

/** Report, never touch: orphans are the owner's data. */
export function reportUnrecognizedDataEntries(dir: string, known: ReadonlySet<string> = DATA_DIR_ENTRIES): string[] {
	const strangers = unrecognizedDataEntries(dir, known);
	for (const name of strangers) {
		let detail = "unreadable";
		try {
			const stat = fs.statSync(path.join(dir, name));
			detail = stat.isDirectory() ? "directory" : `${stat.size} bytes, modified ${stat.mtime.toISOString()}`;
		} catch {}
		console.warn(`[data-dir] unrecognized entry ${name} (${detail}); nothing in this build opens it`);
	}
	return strangers;
}
