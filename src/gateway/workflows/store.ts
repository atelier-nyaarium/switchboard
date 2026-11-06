import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Ambient } from "../../shared/ambient.js";
import { renameFileSync, syncDirectory } from "../../shared/atomic-write.js";
import { JournalRollbackError, openAppendJournal } from "../../shared/durable-journal.js";
import { DurableStore, writeChecked } from "../../shared/durable-store.js";
import {
	type WorkflowJournalRow,
	WorkflowJournalRowSchema,
	type WorkflowRunRecord,
	WorkflowRunRecordSchema,
} from "./workflowSchemas.js";

const WORKFLOW_DIRECTORY = "workflows";
const ASIDE_DIRECTORY = "_aside";
const JOURNAL_FILE = "journal.jsonl";

function parseRows(rawRows: unknown[]): WorkflowJournalRow[] {
	const rows = rawRows.map((row) => WorkflowJournalRowSchema.parse(row));
	const skills = new Map<string, string>();
	for (const row of rows) {
		if (row.kind !== "skill_text") continue;
		const hash = crypto.createHash("sha256").update(row.text, "utf8").digest("hex");
		if (hash !== row.sha256 || skills.has(row.sha256)) throw new Error("invalid workflow skill text row");
		skills.set(row.sha256, row.text);
	}
	return rows;
}

export interface WorkflowRunStore {
	all(): WorkflowRunRecord[];
	running(): WorkflowRunRecord[];
	get(runId: string): WorkflowRunRecord | null;
	byStartOperationId(operationId: string): WorkflowRunRecord | null;
	create(record: WorkflowRunRecord): void;
	write(record: WorkflowRunRecord): void;
	append(runId: string, row: WorkflowJournalRow): boolean;
	rows(runId: string): WorkflowJournalRow[];
	remove(runId: string): void;
	sweepAside(now: number, retentionMs: number): number;
	close(): void;
}

export function createWorkflowRunStore(dataDir: string, ambient: Pick<Ambient, "now" | "newId">): WorkflowRunStore {
	const root = path.join(dataDir, WORKFLOW_DIRECTORY);
	const aside = path.join(root, ASIDE_DIRECTORY);
	const records = new Map<string, WorkflowRunRecord>();
	const journalRows = new Map<string, WorkflowJournalRow[]>();
	fs.mkdirSync(root, { recursive: true });
	syncDirectory(path.dirname(root));

	const runDirectory = (runId: string): string => {
		if (runId.length === 0 || path.basename(runId) !== runId || runId === "." || runId === "..") {
			throw new Error("invalid workflow run id");
		}
		return path.join(root, runId);
	};

	const moveAside = (entryPath: string): void => {
		fs.mkdirSync(aside, { recursive: true });
		const destination = path.join(aside, `${path.basename(entryPath)}-${ambient.newId()}`);
		renameFileSync(entryPath, destination);
		syncDirectory(aside);
		syncDirectory(root);
	};

	const writeRecord = (record: WorkflowRunRecord): void => {
		const runPath = runDirectory(record.runId);
		const durable = new DurableStore(runPath, "record");
		const written = writeChecked(durable, record, "workflow-run");
		if (!written.landed) throw written.error;
	};

	const readRun = (entry: string): void => {
		const directory = runDirectory(entry);
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory()) throw new Error("workflow run is not a directory");
		const recordPath = path.join(directory, "record.json");
		const recordStat = fs.lstatSync(recordPath);
		if (!recordStat.isFile()) throw new Error("workflow record is not a file");
		const record = WorkflowRunRecordSchema.parse(JSON.parse(fs.readFileSync(recordPath, "utf8")));
		if (record.runId !== entry) throw new Error("workflow record id does not match its directory");
		const journalPath = path.join(directory, JOURNAL_FILE);
		if (!fs.lstatSync(journalPath).isFile()) throw new Error("workflow journal is not a file");
		const journal = openAppendJournal(journalPath);
		let parsedRows: WorkflowJournalRow[];
		try {
			parsedRows = parseRows(journal.readAll());
		} finally {
			journal.close();
		}
		records.set(record.runId, record);
		journalRows.set(record.runId, parsedRows);
	};

	for (const entry of fs.readdirSync(root).sort()) {
		if (entry === ASIDE_DIRECTORY) continue;
		const directory = path.join(root, entry);
		try {
			readRun(entry);
		} catch {
			moveAside(directory);
		}
	}

	return {
		all: () => [...records.values()].map((record) => WorkflowRunRecordSchema.parse(record)),
		running: () =>
			[...records.values()]
				.filter((record) => record.status === "running")
				.map((record) => WorkflowRunRecordSchema.parse(record)),
		get: (runId) => {
			const record = records.get(runId);
			return record ? WorkflowRunRecordSchema.parse(record) : null;
		},
		byStartOperationId: (operationId) => {
			const record = [...records.values()].find((candidate) => candidate.startOperationId === operationId);
			return record ? WorkflowRunRecordSchema.parse(record) : null;
		},
		create(record) {
			const checked = WorkflowRunRecordSchema.parse(record);
			const directory = runDirectory(checked.runId);
			if (records.has(checked.runId) || fs.existsSync(directory)) throw new Error("workflow run already exists");
			fs.mkdirSync(directory);
			try {
				syncDirectory(root);
				const journal = openAppendJournal(path.join(directory, JOURNAL_FILE));
				journal.close();
				writeRecord(checked);
				records.set(checked.runId, checked);
				journalRows.set(checked.runId, []);
			} catch (error) {
				fs.rmSync(directory, { recursive: true, force: true });
				throw error;
			}
		},
		write(record) {
			const checked = WorkflowRunRecordSchema.parse(record);
			if (!records.has(checked.runId)) throw new Error("workflow run is unavailable");
			writeRecord(checked);
			records.set(checked.runId, checked);
		},
		append(runId, row) {
			const checked = WorkflowJournalRowSchema.parse(row);
			const record = records.get(runId);
			const heldRows = journalRows.get(runId);
			if (record?.status !== "running" || !heldRows) return false;
			if (checked.kind === "skill_text") {
				const hash = crypto.createHash("sha256").update(checked.text, "utf8").digest("hex");
				if (hash !== checked.sha256) throw new Error("workflow skill hash does not match its text");
				const held = heldRows.find(
					(candidate) => candidate.kind === "skill_text" && candidate.sha256 === checked.sha256,
				);
				if (held?.kind === "skill_text") {
					if (held.text !== checked.text) throw new Error("workflow skill hash collision");
					return false;
				}
			}
			const journal = openAppendJournal(path.join(runDirectory(runId), JOURNAL_FILE));
			try {
				journal.append(checked);
				heldRows.push(checked);
			} catch (error) {
				if (error instanceof JournalRollbackError) {
					moveAside(runDirectory(runId));
					records.delete(runId);
					journalRows.delete(runId);
				}
				throw error;
			} finally {
				try {
					journal.close();
				} catch {}
			}
			return true;
		},
		rows: (runId) => (journalRows.get(runId) ?? []).map((row) => WorkflowJournalRowSchema.parse(row)),
		remove(runId) {
			if (!records.has(runId)) return;
			fs.rmSync(runDirectory(runId), { recursive: true, force: true });
			records.delete(runId);
			journalRows.delete(runId);
			syncDirectory(root);
		},
		sweepAside(now, retentionMs) {
			if (!fs.existsSync(aside)) return 0;
			let removed = 0;
			for (const entry of fs.readdirSync(aside)) {
				const entryPath = path.join(aside, entry);
				try {
					if (now - fs.statSync(entryPath).mtimeMs < retentionMs) continue;
					fs.rmSync(entryPath, { recursive: true, force: true });
					removed += 1;
				} catch {}
			}
			if (removed > 0) syncDirectory(aside);
			return removed;
		},
		close() {},
	};
}
