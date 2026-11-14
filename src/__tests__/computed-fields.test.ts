import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ComputedField,
	type ComputedFields,
	createComputedFields,
	type Transition,
} from "../gateway/computed/computedFields.js";
import { openDurable } from "../shared/durable-store.js";
import { type ExprType, type FieldRef, known, refKey, unknown, type Value } from "../shared/expressions.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "computed-fields-"));
	roots.push(root);
	return root;
};

const temperature: FieldRef = { source: "device", device: "ce:1c:44:06:3c:5d", key: "temperature" };
const TEMP = refKey(temperature);

/** Computed field fixture. */
function world(dir: string) {
	const readings = new Map<string, Value>();
	const declared = new Map<string, ExprType>([[TEMP, { type: "number", integral: false }]]);
	const told: Array<Transition & { id: string }> = [];
	const seen = new Set<string>();
	let n = 0;
	const collect = (fields: ComputedFields) => {
		for (const { id } of fields.list()) {
			const held = fields.stateOf(id);
			for (const row of held?.changes ?? []) {
				const key = `${id}:${held?.epoch}:${row.seq}`;
				if (!seen.has(key)) {
					seen.add(key);
					told.push({ id, ...row });
				}
			}
		}
	};
	const open = () => {
		let opened: ComputedFields | undefined;
		opened = openDurable(dir, "computed-fields", (records) =>
			openDurable(dir, "computed-state", (state) =>
				createComputedFields({
					records,
					state,
					newIncarnation: () => `inc${++n}`,
					now: () => 1_000,
					input: (ref) => {
						const type = declared.get(refKey(ref));
						return type ? { type, value: readings.get(refKey(ref)) ?? unknown("not heard") } : null;
					},
					onCommit: () => opened && collect(opened),
				}),
			),
		);
		opened.start();
		return opened;
	};
	return { readings, declared, told, open };
}

const hotBand: ComputedField = {
	label: "Too hot",
	nodes: [
		{ kind: "field", ref: temperature },
		{ kind: "band", input: 0, high: 28, deadZone: 1 },
	],
};

describe("computed fields", () => {
	it("tells a known change once, reads unknown while its input is, and never counts recovery as a change", () => {
		const w = world(fresh());
		w.readings.set(TEMP, known(24));
		const fields = w.open();
		fields.put("hot", hotBand, 0);
		const read = (value: Value) => {
			w.readings.set(TEMP, value);
			fields.inputsChanged([TEMP]);
			return fields.value("hot");
		};

		expect(fields.value("hot")).toEqual(known("ok"));
		expect(read(known(29))).toEqual(known("high"));
		expect(read(known(29.5))).toEqual(known("high"));
		expect(read(unknown("not heard"))).toEqual(unknown("not heard"));
		expect(read(known(28.5))).toEqual(known("high"));
		expect(read(known(26))).toEqual(known("ok"));
		expect(w.told.map((change) => [change.previous, change.value, change.seq])).toEqual([
			["ok", "high", 1],
			["high", "ok", 2],
		]);
	});

	it("takes a first known value as the baseline, and passes unknown and recovery to fields that read it", () => {
		const w = world(fresh());
		const fields = w.open();
		fields.put("hot", hotBand, 0);
		fields.put(
			"alarm",
			{
				label: "Alarm",
				nodes: [
					{ kind: "field", ref: { source: "computed", id: "hot" } },
					{ kind: "literal", type: "text", value: "high" },
					{ kind: "compare", op: "eq", left: 0, right: 1 },
				],
			},
			0,
		);
		const read = (value: Value) => {
			w.readings.set(TEMP, value);
			fields.inputsChanged([TEMP]);
			return fields.value("alarm");
		};

		expect(read(known(30))).toEqual(known(true));
		expect(read(unknown("not heard"))).toEqual(unknown("not heard"));
		expect(read(known(30))).toEqual(known(true));
		expect(w.told).toEqual([]);
	});

	it("evaluates fields that name fields in order, and refuses a cycle or a chain too deep", () => {
		const w = world(fresh());
		w.readings.set(TEMP, known(30));
		const fields = w.open();
		const above = (id: string, from: string): ComputedField => ({
			label: id,
			nodes: [
				{ kind: "field", ref: { source: "computed", id: from } },
				{ kind: "literal", type: "text", value: "high" },
				{ kind: "compare", op: "eq", left: 0, right: 1 },
			],
		});

		fields.put("hot", hotBand, 0);
		expect(fields.put("alarm", above("alarm", "hot"), 0).stored).toBe(true);
		expect(fields.value("alarm")).toEqual(known(true));
		w.readings.set(TEMP, known(20));
		fields.inputsChanged([TEMP]);
		expect(fields.value("alarm")).toEqual(known(false));
		expect(w.told.map((change) => [change.id, change.value])).toEqual([
			["hot", "ok"],
			["alarm", false],
		]);
		const chain = ["a", "b", "c"].reduce((from, id) => {
			fields.put(id, { label: id, nodes: [{ kind: "field", ref: { source: "computed", id: from } }] }, 0);
			return id;
		}, "alarm");
		expect(
			fields.put(
				"too-deep",
				{ label: "x", nodes: [{ kind: "field", ref: { source: "computed", id: chain } }] },
				0,
			),
		).toMatchObject({
			stored: false,
		});
		const self = {
			label: "self",
			nodes: [{ kind: "field" as const, ref: { source: "computed" as const, id: "self" } }],
		};
		expect(fields.put("self", self, 0)).toMatchObject({ stored: false });
		const negated = {
			label: "bad",
			nodes: [
				{ kind: "field" as const, ref: temperature },
				{ kind: "not" as const, arg: 0 },
			],
		};
		expect(fields.put("bad", negated, 0)).toMatchObject({
			stored: false,
			issue: { path: ["nodes", 1], code: "invalid_type" },
		});
		expect(fields.put("fahrenheit", { ...hotBand, unit: "F" }, 0)).toMatchObject({ stored: false });
	});

	it("re-baselines an edited field without telling, and keeps values across a restart", () => {
		const dir = fresh();
		const w = world(dir);
		w.readings.set(TEMP, known(30));
		const fields = w.open();
		fields.put("hot", hotBand, 0);
		fields.put(
			"hot",
			{ ...hotBand, nodes: [hotBand.nodes[0], { kind: "band", input: 0, high: 35, deadZone: 1 }] },
			1,
		);

		expect(fields.value("hot")).toEqual(known("ok"));
		expect(w.told).toEqual([]);
		const file = path.join(dir, "computed-state.json");
		const held = JSON.parse(fs.readFileSync(file, "utf8"));
		held.hot.later = true;
		fs.writeFileSync(file, JSON.stringify(held));
		const reopened = w.open();
		expect(reopened.value("hot")).toEqual(known("ok"));
		w.readings.set(TEMP, known(40));
		reopened.inputsChanged([TEMP]);
		expect(w.told.map((change) => [change.previous, change.value])).toEqual([["ok", "high"]]);
	});

	it("reads a field whose input stopped resolving as unknown with its reason, and keeps the rest", () => {
		const w = world(fresh());
		w.readings.set(TEMP, known(20));
		const fields = w.open();
		fields.put("hot", hotBand, 0);
		fields.put("label", { label: "Label", nodes: [{ kind: "literal", type: "text", value: "Freezer" }] }, 0);
		w.declared.delete(TEMP);
		fields.inputsChanged([TEMP]);

		expect(fields.value("hot").known).toBe(false);
		expect(fields.invalidOf("hot")).toContain("Too hot");
		expect(fields.value("label")).toEqual(known("Freezer"));
	});

	it("starts a new baseline in a field reading another whose type changed, telling nothing", () => {
		const w = world(fresh());
		const choice = (members: string[]) => ({ type: "choice" as const, members });
		w.declared.set(TEMP, choice(["cold", "hot"]));
		w.readings.set(TEMP, known("cold"));
		const fields = w.open();
		fields.put("up", { label: "Up", nodes: [{ kind: "field", ref: temperature }] }, 0);
		fields.put("down", { label: "Down", nodes: [{ kind: "field", ref: { source: "computed", id: "up" } }] }, 0);
		const epoch = fields.stateOf("down")?.epoch;
		w.declared.set(TEMP, choice(["hot", "warm"]));
		w.readings.set(TEMP, known("hot"));
		fields.typesChanged();

		expect(fields.value("down")).toEqual(known("hot"));
		expect(fields.stateOf("down")?.epoch).not.toBe(epoch);
		expect(w.told).toEqual([]);
	});

	it("starts a new baseline when an input's declaration changes, telling nothing", () => {
		const w = world(fresh());
		w.readings.set(TEMP, known(20));
		const fields = w.open();
		fields.put("hot", hotBand, 0);
		const epoch = fields.stateOf("hot")?.epoch;
		w.declared.set(TEMP, { type: "number", integral: true });
		w.readings.set(TEMP, known(30));
		fields.typesChanged();

		expect(fields.value("hot")).toEqual(known("high"));
		expect(fields.stateOf("hot")?.epoch).not.toBe(epoch);
		expect(w.told).toEqual([]);
	});
});
