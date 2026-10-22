import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CrossDomainShareState,
	handleShareDelta,
	type ShareMirrorChange,
	type ShareRecord,
	XDOMAIN_SHARE_FILE,
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
		expect(reloaded.apply({ revision: 4, put: [record("alpha.gw.next.dev")], del: [] })).toBe("applied");
		expect(reloaded.isSharedTo("alpha.gw.next.dev", "carol", () => true)).toBe(false);
		reloaded.replace({ revision: 4, shares: [record("alpha.gw.app.dev"), record("alpha.gw.next.dev")] });
		expect(reloaded.all().map((s) => s.sessionTarget)).toEqual(["alpha.gw.app.dev", "alpha.gw.next.dev"]);
		reloaded.unready();
		expect(reloaded.all()).toEqual([]);
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

	it("loads the existing share mirror file format", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "share-state-"));
		dirs.push(dir);
		const shares = [record("alpha.gw.app.dev")];
		fs.writeFileSync(path.join(dir, XDOMAIN_SHARE_FILE), JSON.stringify({ revision: 7, shares }));
		const store = new CrossDomainShareState(dir);

		expect(store.revision()).toBe(7);
		expect(store.all()).toEqual([]);
		store.replace({ revision: 7, shares });
		expect(store.all()).toEqual(shares);
	});

	it("answers unwritten without advancing when a delta cannot land", () => {
		const { dir, store } = make();
		const held = record("alpha.gw.app.dev");
		store.replace({ revision: 3, shares: [held] });
		const file = path.join(dir, XDOMAIN_SHARE_FILE);
		fs.rmSync(file);
		fs.mkdirSync(file);

		expect(store.apply({ revision: 4, put: [record("alpha.gw.next.dev")], del: [] })).toBe("unwritten");
		expect(store.revision()).toBe(3);
		expect(store.all()).toEqual([held]);
	});

	it("goes unready and rereads when a delta write fails", () => {
		const { dir, store } = make();
		store.replace({ revision: 3, shares: [record("alpha.gw.app.dev")] });
		const file = path.join(dir, XDOMAIN_SHARE_FILE);
		fs.rmSync(file);
		fs.mkdirSync(file);
		const reread = vi.fn();

		handleShareDelta(store, { revision: 4, put: [record("alpha.gw.next.dev")], del: [] }, reread);

		expect(store.isReady()).toBe(false);
		expect(store.revision()).toBe(3);
		expect(reread).toHaveBeenCalledOnce();
	});
});
