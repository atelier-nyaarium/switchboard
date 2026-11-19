import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.join(import.meta.dirname, "..", "..");

/** Scanned source roots. */
const ROOTS: readonly { dir: string; ext: string; skip?: string }[] = [
	{ dir: "src", ext: ".ts", skip: "src/__tests__" },
	{ dir: "android/app/src/main", ext: ".kt" },
];

const PHONE = "android/app/src/main/java/com/atelier_nyaarium/switchboard";

/** The walk itself. */
const WALK = "src/shared/automation-walk.ts";

/** Unrelated `actions` receivers, with why. */
const EXEMPT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	"src/gateway/assistant/actionDispatch.ts": { deps: "a source's own action table" },
	"src/gateway/computed/automations.ts": { deps: "the ports that run an effect" },
	"src/gateway/computed/automationValidity.ts": { deps: "the ports that run an effect" },
	"src/gateway/liveConsole/entities.ts": {
		sourced: "a source's own commands",
	},
	"src/mcp/assistant/actionFront.ts": { answer: "the assistant's action listing" },
	[`${PHONE}/assistant/AutomationWalk.kt`]: { automation: "the phone's walk itself" },
	[`${PHONE}/assistant/AutomationActionForms.kt`]: { draft: "the editor's own draft list" },
	[`${PHONE}/assistant/AutomationActions.kt`]: {
		draft: "the editor's own draft list",
		offer: "what a Gateway offers",
	},
	[`${PHONE}/assistant/AutomationDraft.kt`]: {
		draft: "the editor's own draft list",
		opened: "the editor's draft as it opened",
	},
	[`${PHONE}/assistant/HoleTextRules.kt`]: { draft: "the editor's own draft list" },
	[`${PHONE}/assistant/AutomationParts.kt`]: { serves: "what a Gateway serves" },
	[`${PHONE}/assistant/AssistantSourcePage.kt`]: { source: "a source's own commands" },
	[`${PHONE}/SandboxGateways.kt`]: { source: "a source's own commands" },
	[`${PHONE}/AssistantNotificationListener.kt`]: { notification: "a notification's actions" },
};

// Known gaps, none in the tree:
// - Kotlin: a bare `actions` in `with(x) { }`, `x.run { }`, `x.apply { }` or a `fun Automation.x()` extension;
//   positional destructuring.
// - R2: nested destructuring (`{ body: { actions } }`) and array patterns.
// - R4: a spread of a bare local, of `row.automation`, or through `!.`, `[0]`, `(...)` or a call.

// R1: a member read, `.actions` after a name, `]` or `)`, through `?.`, `!.` or `!!.`; or a bracket read.
const MEMBER =
	/(?:\b([A-Za-z_$][\w$]*)|([\])]))\s*!{0,2}\s*\??\.\s*actions\b|\b([A-Za-z_$][\w$]*)\s*(?:\?\.|!{1,2})?\s*\[\s*["']actions["']\s*\]/g;
// R2: a destructured read: a declaration, a for-of, or a parameter in any place.
const DESTRUCTURE =
	/\b(?:const|let|var)\s*\{[^{}]*\bactions\b[^{}]*\}\s*(?:=|of\b)|[(,]\s*\{[^{}]*\bactions\b[^{}]*\}\s*(?::[^)=]*)?\)\s*(?:=>|\{|:)/g;
// R3: a Kotlin property reference, `Automation::actions`.
const REFERENCE = /::\s*actions\b/g;
// R4: a body spread not followed by an `actions` from the walk.
const SPREAD = /\.\.\.\s*((?:[A-Za-z_$][\w$]*\??\.)+body)\b(?!\s*,\s*actions\s*:)/g;

/** Every read: a receiver, `{}`, `::` or the spread. */
const allReads = (source: string): string[] => [
	...[...source.matchAll(MEMBER)].map((match) => match[1] ?? match[2] ?? match[3] ?? ""),
	...[...source.matchAll(DESTRUCTURE)].map(() => "{}"),
	...[...source.matchAll(REFERENCE)].map(() => "::"),
	...[...source.matchAll(SPREAD)].map((match) => `...${match[1]}`),
];

/** Reads outside the walk and its exemptions. */
function readsOf(file: string, source: string): string[] {
	if (file === WALK) return [];
	const exempt = EXEMPT[file] ?? {};
	return allReads(source).filter((read) => !Object.hasOwn(exempt, read));
}

function filesUnder(dir: string, ext: string, skip: string | undefined, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (skip !== undefined && rel === skip) continue;
		if (entry.isDirectory()) filesUnder(rel, ext, skip, acc);
		else if (entry.name.endsWith(ext) && !entry.name.endsWith(`.test${ext}`)) acc.push(rel);
	}
	return acc;
}

describe("the one walk", () => {
	it("is the only reader of an automation's actions", () => {
		const offenders = ROOTS.flatMap(({ dir, ext, skip }) =>
			filesUnder(dir, ext, skip).flatMap((file) =>
				readsOf(file, fs.readFileSync(path.join(REPO, file), "utf8")).map((read) => `${file}: ${read}`),
			),
		);

		expect(offenders).toEqual([]);
	});

	it("names every exempt file, and each exemption is still used", () => {
		const stale = Object.entries(EXEMPT).flatMap(([file, receivers]) => {
			const reads = allReads(fs.readFileSync(path.join(REPO, file), "utf8"));
			return Object.keys(receivers).filter((receiver) => !reads.includes(receiver));
		});

		expect(stale).toEqual([]);
	});

	it("refuses each read shape and accepts what is not a read", () => {
		const file = "src/gateway/computed/automations.ts";

		expect(readsOf(file, "record.body.actions.some(isEffect)")).toEqual(["body"]);
		expect(readsOf(file, 'held?.actions[0]; body["actions"]; held?.["actions"]; held!["actions"]')).toEqual([
			"held",
			"body",
			"held",
			"held",
		]);
		expect(readsOf(file, "const { actions, trigger } = record.body;")).toEqual(["{}"]);
		expect(readsOf(file, "held!.actions; held!!.actions; rows[0].actions; f()?.actions")).toEqual([
			"held",
			"held",
			"]",
			")",
		]);
		expect(readsOf(file, "for (const { actions } of rows) {}")).toEqual(["{}"]);
		expect(readsOf(file, "const tells = ({ actions }: Automation) => actions;")).toEqual(["{}"]);
		expect(readsOf(file, "rows.map((row, { actions }) => actions);")).toEqual(["{}"]);
		expect(readsOf(file, "rows.map(Automation::actions)")).toEqual(["::"]);
		expect(readsOf(file, "rows.map(::actionsOf)")).toEqual([]);
		expect(readsOf(file, "return { id, ...record.body };")).toEqual(["...record.body"]);
		expect(readsOf(file, "return { ...record.body, actions: actionsOf(record.body) };")).toEqual([]);
		expect(readsOf(file, "deps.actions?.ready(effect)")).toEqual([]);
		expect(readsOf(file, "tellWhen({ actions: tells }); const actions = 1;")).toEqual([]);
		expect(readsOf(file, "for (const { param } of holeTexts({ actions: [effect] })) {}")).toEqual([]);
		expect(readsOf(WALK, "automation.actions.map(read)")).toEqual([]);
	});

	it("reads the phone's sources by the same rules", () => {
		expect(readsOf(`${PHONE}/AssistantOps.kt`, "automation.actions.map { it.kind }")).toEqual(["automation"]);
		expect(readsOf(`${PHONE}/assistant/AutomationDraft.kt`, "draft.actions.size")).toEqual([]);
	});
});
