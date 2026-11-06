import fs from "node:fs";
import path from "node:path";

export class JournalRollbackError extends Error {
	readonly appendError: unknown;
	readonly rollbackError: unknown;

	constructor(appendError: unknown, rollbackError: unknown) {
		super("journal append rollback failed");
		this.name = "JournalRollbackError";
		this.appendError = appendError;
		this.rollbackError = rollbackError;
	}
}

export interface AppendJournal {
	append(row: unknown): void;
	readAll(): unknown[];
	close(): void;
}

export function openAppendJournal(file: string): AppendJournal {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const fd = fs.openSync(file, "a+", 0o600);
	let closed = false;

	const requireOpen = (): void => {
		if (closed) throw new Error("journal is closed");
	};

	const truncateAndSync = (length: number): void => {
		fs.ftruncateSync(fd, length);
		fs.fsyncSync(fd);
	};

	return {
		append(row) {
			requireOpen();
			const json = JSON.stringify(row);
			if (json === undefined) throw new TypeError("journal row must be JSON serializable");
			const line = Buffer.from(`${json}\n`, "utf8");
			const start = fs.fstatSync(fd).size;
			try {
				let written = 0;
				while (written < line.length) {
					const count = fs.writeSync(fd, line, written, line.length - written);
					if (count === 0) throw new Error("journal append made no progress");
					written += count;
				}
				if (line[line.length - 1] !== 0x0a) throw new Error("journal row has no newline");
				fs.fsyncSync(fd);
			} catch (appendError) {
				try {
					truncateAndSync(start);
				} catch (rollbackError) {
					throw new JournalRollbackError(appendError, rollbackError);
				}
				throw appendError;
			}
		},
		readAll() {
			requireOpen();
			const bytes = fs.readFileSync(file);
			const lastNewline = bytes.lastIndexOf(0x0a);
			const completeLength = lastNewline + 1;
			if (completeLength !== bytes.length) {
				truncateAndSync(completeLength);
			}
			if (completeLength === 0) return [];
			const complete = bytes.subarray(0, completeLength - 1).toString("utf8");
			return complete.split("\n").map((line) => JSON.parse(line) as unknown);
		},
		close() {
			if (closed) return;
			closed = true;
			fs.closeSync(fd);
		},
	};
}
