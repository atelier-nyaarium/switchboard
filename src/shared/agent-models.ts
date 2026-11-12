// Which of a backend's models are offered: the newest of each family.

////////////////////////////////
//  Interfaces & Types

interface Versioned {
	family: string;
	version: number[];
}

export interface OfferedModel {
	id: string;
	/** Used when model omitted. */
	default?: true;
}

////////////////////////////////
//  Constants

const SEPARATORS = /([-_/:])/;
// Letters then a version: `v4`, `o3`, `qwen2.5`. Digits then letters is a size: `70b`, `4o`.
const VERSION_TOKEN = /^([a-z]*)(\d+(?:\.\d+)*)$/i;

////////////////////////////////
//  Functions & Helpers

function read(id: string): Versioned {
	const version: number[] = [];
	const kept: string[] = [];
	for (const token of id.split(SEPARATORS)) {
		const match = VERSION_TOKEN.exec(token);
		if (!match) {
			kept.push(token);
			continue;
		}
		version.push(...match[2]!.split(".").map(Number));
		kept.push(match[1]!);
	}
	const family = kept
		.join("")
		.replace(/[-_]{2,}/g, "-")
		.replace(/[-_]+(?=[/:]|$)/g, "")
		.toLowerCase();
	return { family, version };
}

/** A longer version wins over its own prefix. */
function newer(candidate: number[], held: number[]): boolean {
	for (let index = 0; index < Math.max(candidate.length, held.length); index += 1) {
		const left = candidate[index];
		const right = held[index];
		if (left === undefined) return false;
		if (right === undefined) return true;
		if (left !== right) return left > right;
	}
	return false;
}

/** A family is an id with its version numbers removed; each family keeps its newest id, in first-seen order. */
export function newestPerFamily(ids: readonly string[]): string[] {
	const families = new Map<string, { id: string; version: number[] }>();
	for (const id of ids) {
		const { family, version } = read(id);
		const held = families.get(family);
		if (!held || newer(version, held.version)) families.set(family, { id, version });
	}
	return [...families.values()].map((entry) => entry.id);
}

export function offeredModels(ids: readonly string[], defaultModel: string): OfferedModel[] {
	const newest = newestPerFamily(ids);
	const listed = ids.includes(defaultModel) && !newest.includes(defaultModel) ? [defaultModel, ...newest] : newest;
	return listed.map((id) => (id === defaultModel ? { id, default: true } : { id }));
}
