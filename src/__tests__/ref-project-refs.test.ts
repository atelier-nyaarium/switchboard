import { workspaceKey } from "@nyaa-lexicon/client";
import { formatRef } from "@nyaa-lexicon/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { appendRefArtifacts, setReferencesEnabled } from "../mcp/references/attachRefs.js";
import { rewriteProjectRefs } from "../mcp/references/projectRefs.js";
import { scanRefs } from "../mcp/references/refScanner.js";
import { workspaceRoot } from "../mcp/references/refWorkspace.js";

const ROOT = import.meta.dirname;
const OWN = workspaceKey(ROOT);
const SAME_NAME = `${OWN.slice(0, -16)}0123456789abcdef`;

function rewritten(body: string): { body: string; notices: string[] } {
	const result = rewriteProjectRefs(body, ROOT);
	if (!result.ok) throw new Error(result.error);
	return result;
}

/** What the console resolves after markdown reads the sent body. */
function sentRefs(body: string) {
	const { refs, problems } = scanRefs(rewritten(body).body);
	expect(problems).toEqual([]);
	return refs.map((found) => found.ref);
}

afterEach(() => setReferencesEnabled(false));

describe("project-ref links in a reply", () => {
	it("reach the console as the module and chain Lexicon wrote", () => {
		const written: Array<[string, string[]]> = [
			["src/engine.cpp", ["Physics::World::step"]],
			["src/util.js", ["deepHandler[2]"]],
			["src/cart.ts", ["Shop", "Cart", "add", "arguments", "qty"]],
			["app/(group)/page.tsx", ["Page"]],
			["src/a b&amp;c\\_d%e.ts", ["Odd\\(name)", "x:y"]],
			["README.md", []],
		];
		const body = written.map(([module, segments], n) => `[${n}](${formatRef(OWN, module, segments)})`).join(" ");
		expect(sentRefs(body)).toEqual(written.map(([path, segments]) => ({ path, segments, matcher: null })));
	});

	it("leave code as written", () => {
		const out = rewritten(`Write \`[x](project-ref://${OWN}/a.ts)\`, and [y](project-ref://${OWN}/b.ts).`);
		expect(out.body).toBe(`Write \`[x](project-ref://${OWN}/a.ts)\`, and [y](ref://b.ts).`);
	});

	it("match a key by name alone, and say so", () => {
		const out = rewritten(`[Foo](project-ref://${SAME_NAME}/src/a.ts:Foo)`);
		expect(scanRefs(out.body).refs.map((found) => found.key)).toEqual(["ref://src/a.ts:Foo"]);
		expect(out.notices).toHaveLength(1);
	});

	it("refuse another workspace and a line selection, every one at once", () => {
		const result = rewriteProjectRefs(
			[
				"[Foo](project-ref://elsewhere-0123456789abcdef/src/a.ts:Foo)",
				`[Bar](project-ref://${OWN}/src/a.ts:Bar#3..9)`,
				`[Baz](project-ref://${OWN}/src/a.ts:Baz)`,
			].join(" "),
			ROOT,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.split("\n")).toHaveLength(2);
		expect(result.error).toContain("elsewhere-0123456789abcdef");
		expect(result.error).toContain("#3..9");
	});

	it("are rewritten on the reply road before anything resolves", async () => {
		setReferencesEnabled(true);
		const refused = await appendRefArtifacts("[Foo](project-ref://elsewhere-0123456789abcdef/a.ts:Foo)", []);
		expect(refused.ok).toBe(false);
		const own = workspaceKey(workspaceRoot().root);
		const plain = await appendRefArtifacts(`Code: \`[x](project-ref://${own}/a.ts)\``, []);
		expect(plain).toMatchObject({ ok: true, files: [] });
	});
});
