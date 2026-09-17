// The last gate: what a built answer names, against what this plane serves.
//
// The fields come from the answer schemas, so one added there is gated without anyone listing it here.
// A row a read legitimately drops stays a row-level omission; this refuses the whole answer.

import { WorkspaceOpAnswerSchema } from "../../shared/schemasWorkspace.js";
import type { WorkspaceOpResult } from "../../shared/workspace-op.js";
import { refused, type ServedGate } from "./handlerKit.js";

////////////////////////////////
//  Interfaces & Types

/** A file, or an id embedding one. */
export type GatedKind = "module" | "id";

interface ZodNode {
	_zod?: { def?: Record<string, unknown> };
}

////////////////////////////////
//  Functions & Helpers

/** What a field's name holds. */
function gatedKind(name: string): GatedKind | null {
	if (/(^|[a-z])Id$/.test(name)) return "id";
	if (/module|path/i.test(name)) return "module";
	return null;
}

/** Guarded by the branch, not by every node seen, since one schema serves many fields. */
function walkFields(schema: unknown, name: string | null, branch: Set<unknown>, found: Map<string, GatedKind>): void {
	if (typeof schema !== "object" || schema === null || branch.has(schema)) return;
	const def = (schema as ZodNode)._zod?.def;
	if (def === undefined) return;
	branch.add(schema);
	const into = (child: unknown, key: string | null = name) => walkFields(child, key, branch, found);
	switch (def.type) {
		case "string": {
			if (name === null) break;
			const kind = gatedKind(name);
			if (kind !== null) found.set(name, kind);
			break;
		}
		case "object":
			for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) into(child, key);
			break;
		case "array":
			into(def.element);
			break;
		case "union":
			for (const option of def.options as unknown[]) into(option);
			break;
		case "pipe":
			into(def.in);
			into(def.out);
			break;
		case "lazy":
			into((def.getter as () => unknown)());
			break;
		default:
			if ("innerType" in def) into(def.innerType);
	}
	branch.delete(schema);
}

/** Every string field naming a file, read off the schemas. */
export function gatedAnswerFields(schema: unknown = WorkspaceOpAnswerSchema): Map<string, GatedKind> {
	const found = new Map<string, GatedKind>();
	walkFields(schema, null, new Set(), found);
	return found;
}

const GATED = gatedAnswerFields();

function unserved(value: unknown, name: string | null, gate: ServedGate): boolean {
	if (Array.isArray(value)) return value.some((item) => unserved(item, name, gate));
	if (typeof value === "string") {
		const kind = name === null ? undefined : GATED.get(name);
		// Empty is the workspace root.
		if (kind === undefined || value === "") return false;
		return kind === "id" ? !gate.id(value) : gate.module(value) === null;
	}
	if (typeof value !== "object" || value === null) return false;
	return Object.entries(value).some(([key, child]) => unserved(child, key, gate));
}

/**
 * Refuses unserved names.
 *
 * A write is refused as a failure, never as a refusal: a refusal tells the phone nothing was written,
 * and a write whose answer named an unserved file may already have landed.
 */
export function withinServed(result: WorkspaceOpResult, gate: ServedGate, wrote = false): WorkspaceOpResult {
	if (!result.ok) return result;
	if (!unserved(result.answer, null, gate)) return result;
	const detail = "the answer named a file that is not served";
	return wrote ? { ok: false, failure: "failed", detail } : refused(detail);
}
