import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../shared/atomic-write.js";

////////////////////////////////
//  Constants

export const ENROLL_PENDING_FILE = "enroll-pending.json";

////////////////////////////////
//  Interfaces & Types

const EnrollPendingSchema = z.object({
	/** The one-time code the enrollment payload shows. */
	code: z.string().min(1),
	routerUrl: z.string().min(1),
	/** The Router certificate seen when this was armed. */
	routerCertFp: z.string().regex(/^[0-9a-f]{64}$/),
});

export type EnrollPending = z.infer<typeof EnrollPendingSchema>;

////////////////////////////////
//  Functions & Helpers

/** The record a file's text holds, or none when it is unreadable. */
export function enrollPendingOf(text: string): EnrollPending | null {
	try {
		const parsed = EnrollPendingSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** A setup that has not finished. */
export function readEnrollPending(federationDir: string): EnrollPending | null {
	try {
		return enrollPendingOf(fs.readFileSync(path.join(federationDir, ENROLL_PENDING_FILE), "utf8"));
	} catch {
		return null;
	}
}

export function writeEnrollPending(federationDir: string, record: EnrollPending): void {
	writeFileAtomic(path.join(federationDir, ENROLL_PENDING_FILE), JSON.stringify(record), {
		mode: 0o600,
		fsyncFile: true,
		fsyncDirectory: true,
	});
}

export function retireEnrollPending(federationDir: string): void {
	fs.rmSync(path.join(federationDir, ENROLL_PENDING_FILE), { force: true });
}
