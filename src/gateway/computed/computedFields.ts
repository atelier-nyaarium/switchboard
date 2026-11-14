// Unknown preserves last value.

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import {
	type BandSide,
	checkExpression,
	conforms,
	ExpressionSchema,
	type ExprType,
	evaluate,
	type FieldRef,
	known,
	refKey,
	unknown,
	type Value,
} from "../../shared/expressions.js";
import { inRange, roundTo, UNIT_CODES } from "../../shared/field-types.js";
import { createOwnerRecords, type OwnerIssue, type OwnerRecord } from "../ownerRecords.js";

export const COMPUTED_FIELDS_MAX = 64;
export const COMPUTED_DEPTH_MAX = 4;
export const COMPUTED_KIND = "computed_field";
/** Transitions kept per field. */
export const CHANGES_MAX = 16;

export const ComputedFieldSchema = z.strictObject({
	label: z.string().min(1).max(80),
	unit: z
		.string()
		.refine((unit) => UNIT_CODES.includes(unit), "unknown unit")
		.optional(),
	decimals: z.number().int().min(0).max(6).optional(),
	nodes: ExpressionSchema,
});
export type ComputedField = z.infer<typeof ComputedFieldSchema>;

const Primitive = z.union([z.number(), z.string(), z.boolean()]);

const TransitionSchema = z.looseObject({
	seq: z.number().int().positive(),
	previous: Primitive,
	value: Primitive,
	at: z.number(),
});
export type Transition = z.infer<typeof TransitionSchema>;

const FieldStateSchema = z.record(
	z.string(),
	z.looseObject({
		incarnation: z.string(),
		/** Expression and input types. */
		basis: z.string(),
		/** Epoch for each baseline. */
		epoch: z.string(),
		value: Primitive.optional(),
		at: z.number().optional(),
		/** Known changes advance seq. */
		seq: z.number().int().nonnegative(),
		/** Contiguous transitions through seq. */
		changes: z.array(TransitionSchema).max(CHANGES_MAX),
		sides: z.record(z.string(), z.enum(["low", "ok", "high"])),
	}),
);
type FieldState = z.infer<typeof FieldStateSchema>[string];

export interface FieldInput {
	type: ExprType;
	value: Value;
	/** Joins the basis hash. */
	basis?: string;
}

export interface ComputedFieldsDeps {
	records: DurableStore;
	state: DurableStore;
	newIncarnation: () => string;
	now: () => number;
	/** Null means absent field. */
	input: (ref: FieldRef) => FieldInput | null;
	/** Wake after writes land. */
	onCommit?: () => void;
}

const computedRefs = (field: ComputedField) =>
	field.nodes.flatMap((node) => (node.kind === "field" && node.ref.source === "computed" ? [node.ref.id] : []));

export function createComputedFields(deps: ComputedFieldsDeps) {
	let state = FieldStateSchema.parse(deps.state.load() ?? {});
	let stale = new Map<string, string>();

	interface Resolved {
		types: Map<string, ExprType>;
		/** Dependencies first. */
		order: string[];
		/** Derived, never stored. */
		invalid: Map<string, OwnerIssue>;
	}

	type InputRead = (ref: FieldRef) => FieldInput | null;

	/** Cache inputs per pass. */
	const reader = (): InputRead => {
		const seen = new Map<string, FieldInput | null>();
		return (ref) => {
			const key = refKey(ref);
			if (!seen.has(key)) seen.set(key, deps.input(ref));
			return seen.get(key) ?? null;
		};
	};

	function resolve(all: readonly OwnerRecord<ComputedField>[], read: InputRead): Resolved {
		const byId = new Map(all.map((record) => [record.id, record]));
		const resolved: Resolved = { types: new Map(), order: [], invalid: new Map() };
		const depthOf = new Map<string, number>();
		const visiting = new Set<string>();
		const refuse = (id: string, message: string) =>
			resolved.invalid.set(id, { path: ["nodes"], message, code: "invalid_ref" });
		const visit = (id: string): boolean => {
			if (resolved.types.has(id)) return true;
			if (resolved.invalid.has(id)) return false;
			const record = byId.get(id);
			if (!record) return false;
			if (visiting.has(id)) {
				refuse(id, `${record.body.label} names itself`);
				return false;
			}
			visiting.add(id);
			let depth = 1;
			for (const dep of computedRefs(record.body)) {
				if (!visit(dep)) {
					visiting.delete(id);
					refuse(id, `${record.body.label} names a field that cannot be read`);
					return false;
				}
				depth = Math.max(depth, (depthOf.get(dep) ?? 1) + 1);
			}
			visiting.delete(id);
			if (depth > COMPUTED_DEPTH_MAX) {
				refuse(id, `${record.body.label} names fields more than ${COMPUTED_DEPTH_MAX} deep`);
				return false;
			}
			const check = checkExpression(record.body.nodes, (ref) =>
				ref.source === "computed" ? (resolved.types.get(ref.id) ?? null) : (read(ref)?.type ?? null),
			);
			if (!check.ok) {
				resolved.invalid.set(id, { ...check.issue, message: `${record.body.label}: ${check.issue.message}` });
				return false;
			}
			resolved.types.set(id, check.type);
			depthOf.set(id, depth);
			resolved.order.push(id);
			return true;
		};
		for (const record of all) visit(record.id);
		return resolved;
	}

	const records = createOwnerRecords<ComputedField>({
		store: deps.records,
		kinds: { [COMPUTED_KIND]: ComputedFieldSchema },
		max: COMPUTED_FIELDS_MAX,
		newIncarnation: deps.newIncarnation,
		refusal: (candidate, others) => resolve([...others, candidate], reader()).invalid.get(candidate.id) ?? null,
		label: "computed fields",
	});

	let snapshot = resolve(records.list(), reader());

	const current = (id: string): Value => {
		const issue = snapshot.invalid.get(id);
		if (issue) return unknown(issue.message);
		const reason = stale.get(id);
		if (reason) return unknown(reason);
		const held = state[id];
		return held?.value === undefined ? unknown("not read yet") : known(held.value);
	};

	/** Input types affect basis. */
	const basisOf = (field: ComputedField, read: InputRead, computed: ReadonlyMap<string, ExprType>) => {
		const types = field.nodes.flatMap((node) =>
			node.kind !== "field"
				? []
				: [
						[
							refKey(node.ref),
							node.ref.source === "computed"
								? computed.get(node.ref.id)
								: { type: read(node.ref)?.type, basis: read(node.ref)?.basis },
						],
					],
		);
		return createHash("sha256")
			.update(canonicalJson({ nodes: field.nodes, decimals: field.decimals, types }))
			.digest("hex")
			.slice(0, 16);
	};

	/** Persist, then wake. */
	function evaluateAll(changedKeys?: ReadonlySet<string>): void {
		const all = records.list();
		const read = reader();
		const check = resolve(all, read);
		snapshot = check;
		const byId = new Map(all.map((record) => [record.id, record]));
		const live = new Map<string, Value>();
		const touched = new Set(changedKeys ?? []);
		const next: Record<string, FieldState> = {};
		const nextStale = new Map<string, string>();
		for (const id of check.order) {
			const record = byId.get(id) as OwnerRecord<ComputedField>;
			const basis = basisOf(record.body, read, check.types);
			const held = state[id];
			const fresh = !held || held.incarnation !== record.incarnation || held.basis !== basis;
			const names = record.body.nodes.flatMap((node) => (node.kind === "field" ? [refKey(node.ref)] : []));
			if (!fresh && changedKeys && !names.some((key) => touched.has(key))) {
				next[id] = held;
				const reason = stale.get(id);
				if (reason) nextStale.set(id, reason);
				continue;
			}
			const sides = fresh ? {} : (held.sides as Record<number, BandSide>);
			const run = evaluate(
				record.body.nodes,
				(ref) => {
					if (ref.source === "computed") return live.get(ref.id) ?? current(ref.id);
					const input = read(ref);
					return input ? conforms(input.type, input.value) : unknown("not a field here");
				},
				sides,
			);
			const { decimals } = record.body;
			const value =
				run.value.known && typeof run.value.value === "number"
					? !inRange(run.value.value, decimals ?? 0)
						? unknown("out of range")
						: known(decimals === undefined ? run.value.value : roundTo(run.value.value, decimals))
					: run.value;
			live.set(id, value);
			if (!value.known) nextStale.set(id, value.reason);
			// Dependents hear availability changes.
			if (value.known === stale.has(id)) touched.add(`computed:${id}`);
			const base: FieldState = fresh
				? {
						incarnation: record.incarnation,
						basis,
						epoch: deps.newIncarnation(),
						seq: 0,
						changes: [],
						sides: {},
					}
				: held;
			const sidesChanged = canonicalJson(run.sides) !== canonicalJson(sides);
			const valueChanged = value.known && value.value !== base.value;
			if (!fresh && !sidesChanged && !valueChanged) {
				next[id] = base;
				continue;
			}
			touched.add(`computed:${id}`);
			const at = deps.now();
			// First known value baselines.
			const previous = base.value;
			const counts = valueChanged && previous !== undefined;
			const changes =
				counts && value.known
					? [...base.changes, { seq: base.seq + 1, previous, value: value.value, at }].slice(-CHANGES_MAX)
					: base.changes;
			next[id] = {
				...base,
				...(value.known ? { value: value.value, at, seq: counts ? base.seq + 1 : base.seq } : {}),
				changes,
				sides: run.sides as Record<string, BandSide>,
			};
		}
		stale = nextStale;
		if (canonicalJson(next) === canonicalJson(state)) return;
		const landed = commitChecked(
			deps.state,
			next,
			(written) => {
				state = written;
			},
			{ label: "computed field state" },
		).landed;
		if (landed) deps.onCommit?.();
	}

	return {
		/** Wire listeners before start. */
		start: () => evaluateAll(),
		list: () => records.list(),
		get: (id: string) => records.get(id),
		invalidOf: (id: string): string | null => snapshot.invalid.get(id)?.message ?? null,
		typeOf: (id: string): ExprType | null => snapshot.types.get(id) ?? null,
		value: current,
		/** Epoch, seq and transitions. */
		stateOf: (id: string): Readonly<FieldState> | null => state[id] ?? null,
		put(id: string, field: unknown, base: number, options?: { revive?: boolean }) {
			const result = records.put(COMPUTED_KIND, id, field, base, options);
			if (result.stored) evaluateAll(new Set());
			return result;
		},
		remove(id: string, base: number) {
			const result = records.remove(id, base);
			if (result.removed) evaluateAll(new Set());
			return result;
		},
		inputsChanged(keys: readonly string[]): void {
			evaluateAll(new Set(keys));
		},
		/** Type changes rebaseline values. */
		typesChanged: () => evaluateAll(),
	};
}

export type ComputedFields = ReturnType<typeof createComputedFields>;
