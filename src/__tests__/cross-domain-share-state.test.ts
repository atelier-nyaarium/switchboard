import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CrossDomainShareState,
	type ShareMirrorChange,
	type ShareRecord,
} from "../gateway/federation/crossDomainShareState.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const carol = { kind: "domain" as const, domainId: "carol" };
const record = (sessionTarget: string, target: ShareRecord["target"] = carol): ShareRecord => ({
	sessionTarget,
	target,
	lastSeenAt: 10,
});
const make = (changes: ShareMirrorChange[] = []) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-state-"));
	dirs.push(dir);
	return { dir, store: new CrossDomainShareState(dir, (change) => changes.push(change)) };
};

describe("CrossDomainShareState", () => {
	it("keeps the revision across a restart but shares nothing until a snapshot lands again", () => {
		const { dir, store } = make();
		expect(store.isReady()).toBe(false);
		store.replace({ revision: 3, shares: [record("alpha.gw.app.dev")] });
		expect(store.isSharedTo("alpha.gw.app.dev", "carol", () => true)).toBe(true);
		const reloaded = new CrossDomainShareState(dir);
		expect(reloaded.revision()).toBe(3);
		expect(reloaded.all()).toEqual([]);
		expect(reloaded.isSharedTo("alpha.gw.app.dev", "carol", () => true)).toBe(false);
		expect(reloaded.sharesFor("carol", () => true)).toEqual([]);
		expect(reloaded.apply({ revision: 4, put: [record("alpha.gw.next.dev")], del: [] })).toBe("applied");
		expect(reloaded.isSharedTo("alpha.gw.next.dev", "carol", () => true)).toBe(false);
		reloaded.replace({ revision: 4, shares: [record("alpha.gw.app.dev"), record("alpha.gw.next.dev")] });
		expect(reloaded.sharesFor("carol", () => true)).toEqual(["alpha.gw.app.dev", "alpha.gw.next.dev"]);
		reloaded.unready();
		expect(reloaded.sharesFor("carol", () => true)).toEqual([]);
	});

	it("applies only the next revision and names a gap for anything else", () => {
		const changes: ShareMirrorChange[] = [];
		const { store } = make(changes);
		store.replace({ revision: 3, shares: [record("alpha.gw.app.dev")] });
		expect(store.apply({ revision: 5, put: [record("alpha.gw.late.dev")], del: [] })).toBe("gap");
		expect(store.apply({ revision: 3, put: [record("alpha.gw.old.dev")], del: [] })).toBe("gap");
		expect(store.all()).toEqual([record("alpha.gw.app.dev")]);
		expect(
			store.apply({
				revision: 4,
				put: [record("alpha.gw.new.dev")],
				del: [{ sessionTarget: "alpha.gw.app.dev", target: carol }],
			}),
		).toBe("applied");
		expect(store.revision()).toBe(4);
		expect(store.all()).toEqual([record("alpha.gw.new.dev")]);
		expect(changes.at(-1)).toEqual({
			reason: { kind: "domain", domainId: "carol" },
			removed: [record("alpha.gw.app.dev")],
		});
	});

	it("a snapshot replaces whatever is held, older revision included, and reports what it dropped", () => {
		const changes: ShareMirrorChange[] = [];
		const { store } = make(changes);
		store.replace({
			revision: 9,
			shares: [record("alpha.gw.app.dev"), record("alpha.gw.wide.dev", { kind: "everyone_trusted" })],
		});
		store.replace({ revision: 2, shares: [record("alpha.gw.app.dev")] });
		expect(store.revision()).toBe(2);
		expect(store.all()).toEqual([record("alpha.gw.app.dev")]);
		expect(changes.at(-1)).toEqual({
			reason: { kind: "sweep" },
			removed: [record("alpha.gw.wide.dev", { kind: "everyone_trusted" })],
		});
		store.replace({ revision: 2, shares: [record("alpha.gw.app.dev")] });
		expect(changes).toHaveLength(2);
	});
});
