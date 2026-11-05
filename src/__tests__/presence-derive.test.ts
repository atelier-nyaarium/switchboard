import { describe, expect, it } from "vitest";
import { type DerivedPresence, DerivedPresenceSchema, projectDerived, sameDerived } from "../shared/schemasPresence.js";

const full: DerivedPresence = {
	working: true,
	needsLogin: true,
	limitBlocked: true,
	limitDetail: "resets 5pm",
	prompt: { id: "p1", title: "Bash command", body: ["rm -f out/x"] },
	workflow: true,
	teammates: true,
	compacting: true,
};

const keys = Object.keys(DerivedPresenceSchema.shape) as (keyof DerivedPresence)[];

/** The same state with one field changed. */
function changed(key: keyof DerivedPresence): DerivedPresence {
	switch (key) {
		case "prompt":
			return { ...full, prompt: { ...full.prompt!, id: "p2" } };
		case "limitDetail":
			return { ...full, limitDetail: "resets 6pm" };
		default:
			return { ...full, [key]: !full[key] };
	}
}

describe("a derived presence", () => {
	it("projects every field onto the row, the prompt as its id alone", () => {
		const row = projectDerived(full);
		const expected = [...keys.filter((key) => key !== "prompt"), "promptId"].sort();

		expect(Object.keys(row).sort()).toEqual(expected);
		expect(row.promptId).toBe("p1");
		expect(JSON.stringify(row)).not.toContain("rm -f");
		expect(projectDerived({ working: false, needsLogin: false, limitBlocked: false })).toEqual({
			working: false,
			needsLogin: false,
			limitBlocked: false,
		});
	});

	it("differs on any one field, and on the prompt only by id", () => {
		const differing = keys.filter((key) => !sameDerived(full, changed(key)));
		const retitled = sameDerived(full, { ...full, prompt: { ...full.prompt!, title: "other" } });

		expect(sameDerived(full, { ...full })).toBe(true);
		expect(differing).toEqual(keys);
		expect(retitled).toBe(true);
	});
});
