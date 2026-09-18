import fs from "node:fs";
import path from "node:path";
import { pluginRoot } from "../../shared/plugin-root.js";

////////////////////////////////
//  Interfaces & Types

interface MarkdownToken {
	type: string;
	content: string;
	children?: MarkdownToken[] | null;
	attrGet(name: string): string | null;
}

export interface LinkScan {
	/** In document order, duplicates kept: the caller dedupes on canonical key, not written string. */
	destinations: string[];
	/** A ref link's destination that did not parse as a link, to its first `)`. */
	unlinked: string[];
}

interface MarkdownParser {
	parse(src: string, env: Record<string, unknown>): MarkdownToken[];
}

////////////////////////////////
//  Functions & Helpers

/**
 * The console's own asset, not an npm copy and not an approximation.
 *
 * Both sides must agree on what is a link, and the only way to guarantee that is the same bytes. A
 * hand-written backtick pairer silently swallowed every ref between two unrelated ones.
 */
const VENDORED_PARSER = path.join(
	pluginRoot(),
	"android",
	"app",
	"src",
	"main",
	"assets",
	"thread",
	"vendor",
	"markdown-it.min.js",
);

/** Identical to `thread.js`. `linkify: false` is load-bearing: only a written `[label](url)` is a
 * link, so a bare `ref://` in prose attaches nothing. */
const OPTIONS = { html: false, breaks: true, linkify: false };

let parser: MarkdownParser | null = null;

/**
 * Evaluated, not required: this package is `type: module` and the bundle is UMD.
 *
 * A `.cjs` copy would be a second set of bytes to keep in step, which is the drift this file removes.
 */
function load(): MarkdownParser {
	if (parser) return parser;

	const shim = { exports: {} as unknown };
	new Function("module", "exports", fs.readFileSync(VENDORED_PARSER, "utf8"))(shim, shim.exports);
	parser = (shim.exports as (opts: unknown) => MarkdownParser)(OPTIONS);
	return parser;
}

const UNLINKED_REF = "](ref://";

/** Adjacent text tokens are read as one run, since a failed link can split across several. */
export function scanLinks(body: string): LinkScan {
	const destinations: string[] = [];
	const unlinked: string[] = [];

	const walk = (tokens: MarkdownToken[] | null | undefined): void => {
		let run = "";
		const flush = () => {
			const at = run.toLowerCase().indexOf(UNLINKED_REF);
			if (at !== -1) {
				const rest = run.slice(at + 2);
				const close = rest.indexOf(")");
				unlinked.push(close === -1 ? rest.slice(0, 120) : rest.slice(0, close));
			}
			run = "";
		};
		for (const token of tokens ?? []) {
			if (token.type === "text") {
				run += token.content;
				continue;
			}
			flush();
			if (token.type === "link_open") {
				const href = token.attrGet("href");
				if (href !== null) destinations.push(href);
			}
			walk(token.children);
		}
		flush();
	};

	walk(load().parse(body, {}));
	return { destinations, unlinked };
}
