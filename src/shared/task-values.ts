// A task as a value: what names it, and how it is kept.

/** What an `await` waits on: a task by its start step's path, or `all` or `any` of them. */
export type Waited = string | { all: Waited[] } | { any: Waited[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys no event field or record a person writes is read as. */
export const TASK_KEY = "$task";
export const JOIN_KEYS = { all: "$all", any: "$any" } as const;
/** Joins nest no deeper. */
const NEST_MAX = 8;

/** What a value names to wait on: a task, or `all` or `any` of them, as kept or as read. */
export function waitedOf(value: unknown, depth = 0): Waited | null {
	if (!isRecord(value) || depth > NEST_MAX) return null;
	if (typeof value[TASK_KEY] === "string") return value[TASK_KEY] as string;
	for (const mode of ["all", "any"] as const) {
		const items = value[JOIN_KEYS[mode]];
		if (!Array.isArray(items) || items.length === 0) continue;
		const each = items.map((item) => waitedOf(item, depth + 1));
		if (each.some((item) => item === null)) return null;
		// One task named twice is waited on once.
		const once = [...new Map(each.map((item) => [JSON.stringify(item), item as Waited])).values()];
		return mode === "all" ? { all: once } : { any: once };
	}
	return null;
}

/** A task as a value keeps: its name and nothing that goes stale. */
export const keptOf = (waited: Waited): Record<string, unknown> =>
	typeof waited === "string"
		? { [TASK_KEY]: waited }
		: "all" in waited
			? { [JOIN_KEYS.all]: waited.all.map(keptOf) }
			: { [JOIN_KEYS.any]: waited.any.map(keptOf) };

/** A value as it is kept: every task in it by name alone. */
export function kept(value: unknown): unknown {
	const waited = waitedOf(value);
	if (waited !== null) return keptOf(waited);
	if (Array.isArray(value)) return value.map(kept);
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, kept(item)]));
	return value;
}
