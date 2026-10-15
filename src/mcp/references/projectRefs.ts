// Lexicon's `project-ref://` links, sent as the `ref://` a console opens.

import { workspaceKey } from "@nyaa-lexicon/client";
import { findRefLinks, REF_SCHEME as PROJECT_REF_SCHEME, parseRefTarget } from "@nyaa-lexicon/protocol";
import { canonicalKey } from "./refGrammar.js";

////////////////////////////////
//  Interfaces & Types

export type ProjectRefRewrite = { ok: true; body: string; notices: string[] } | { ok: false; error: string };

////////////////////////////////
//  Constants

/** Sanitized name, then digest. */
const KEY_SHAPE = /^(.+)-[0-9a-f]{16}$/;

/** What markdown decodes in a destination. */
const MARKDOWN_SPECIAL = /[\\&()]/g;

////////////////////////////////
//  Functions & Helpers

function nameOf(key: string): string | undefined {
	return KEY_SHAPE.exec(key)?.[1];
}

/** Percent-escaped, so markdown hands back these bytes. */
function destinationOf(key: string): string {
	return key.replace(MARKDOWN_SPECIAL, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Every link outside code rewritten, or every refusal at once. */
export function rewriteProjectRefs(body: string, root: string): ProjectRefRewrite {
	if (!body.includes(PROJECT_REF_SCHEME)) return { ok: true, body, notices: [] };
	const own = workspaceKey(root);
	const problems: string[] = [];
	const notices = new Set<string>();
	let out = body;
	// Rightmost first.
	for (const link of findRefLinks(body).reverse()) {
		const parsed = parseRefTarget(link.ref);
		if (!parsed.ok) {
			problems.push(`${link.ref}: ${parsed.problem}`);
			continue;
		}
		const { project, module, segments, lines, range } = parsed.target;
		if (lines !== undefined || range !== undefined) {
			problems.push(`${link.ref}: a line selection has no ref:// form; drop the \`#\`, or search with \`#text\``);
			continue;
		}
		if (project !== own) {
			if (nameOf(project) === undefined || nameOf(project) !== nameOf(own)) {
				problems.push(
					`${link.ref}: names \`${project}\`, not this workspace (\`${own}\`); write \`ref://\` with the path from ${root}`,
				);
				continue;
			}
			notices.add(`\`${project}\` is not this workspace's key; matched by name and read at ${root}.`);
		}
		const destination = destinationOf(canonicalKey({ path: module, segments, matcher: null }));
		out = out.slice(0, link.index) + destination + out.slice(link.index + link.ref.length);
	}
	if (problems.length > 0) return { ok: false, error: problems.reverse().join("\n") };
	return { ok: true, body: out, notices: [...notices] };
}
