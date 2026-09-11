import fs from "node:fs";
import path from "node:path";
import { isSlug, MAX_SLUG_LEN } from "./session-id.js";

////////////////////////////////
//  Constants

/** Enrollment wrote the delivered Domain id here, and on an older install it is the ONLY copy. */
export const DOMAIN_ID_FILE = "domain-id";

////////////////////////////////
//  Functions & Helpers

/** Sanitize a raw Domain id into a stable address segment: lower case, non-alphanumerics collapse to
 * single dashes, ends trimmed, capped at the slug length. The output is a dotless slug, so a Domain
 * id can never split an address wrong. Empty / all-separator input THROWS: every Domain id names a
 * real Domain, so an unnameable id is a caller bug, not a value to default. */
export function sanitizeDomainId(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LEN)
		.replace(/-+$/g, "");
	if (!isSlug(slug)) throw new Error("domain id is empty after sanitizing");
	return slug;
}

/**
 * The local Gateway's Domain id, or null when it has not been enrolled yet: the installed allowlist
 * record, then the `domain-id` file, then the `FEDERATION_DOMAIN_ID` env. Null boots standalone and
 * opens the enrollment listener; a Domain is required only to reach the Router.
 *
 * The FILE is not dead weight and must not be dropped for having no writer. An install enrolled
 * before the id moved into the allowlist record carries it here and nowhere else, and no migration
 * ever copied it across, so a gateway that loses this reader boots with no Domain and never reaches
 * the Router. Removing it took Mikan off the Router on 2026-09-11. Retire it by writing the id into
 * the allowlist record first, and only then.
 */
export function resolveLocalDomainId(federationDir: string, installed?: string | null): string | null {
	const id = installed ?? readDomainIdFile(federationDir) ?? process.env.FEDERATION_DOMAIN_ID;
	return id ? sanitizeDomainId(id) : null;
}

function readDomainIdFile(federationDir: string): string | null {
	try {
		return fs.readFileSync(path.join(federationDir, DOMAIN_ID_FILE), "utf8").trim() || null;
	} catch {
		return null;
	}
}
