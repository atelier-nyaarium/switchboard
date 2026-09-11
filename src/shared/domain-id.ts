import { isSlug, MAX_SLUG_LEN } from "./session-id.js";

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

/** The installed allowlist id, else `FEDERATION_DOMAIN_ID`; null boots standalone. */
export function resolveLocalDomainId(installed?: string | null): string | null {
	const id = installed ?? process.env.FEDERATION_DOMAIN_ID;
	return id ? sanitizeDomainId(id) : null;
}
