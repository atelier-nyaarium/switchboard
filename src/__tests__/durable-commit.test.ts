import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	commitChecked,
	createRestoreRepairs,
	DurableStore,
	DurableStoreInstalledError,
	restoreHeld,
} from "../shared/durable-store.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Older file, failable saves. */
function olderFile(held: unknown) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-held-"));
	roots.push(dir);
	fs.writeFileSync(path.join(dir, "held.json"), JSON.stringify(held));
	const disk = new DurableStore(dir, "held");
	const faults = { failing: false };
	const store = {
		load: () => disk.load(),
		saveChecked: (state: unknown) => {
			if (faults.failing) throw new Error("disk full");
			disk.saveChecked(state);
		},
	};
	const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, "held.json"), "utf8"));
	return { store, faults, onDisk };
}

/** Bare number is older. */
const decode = (raw: unknown) =>
	typeof raw === "number" ? { value: { n: raw }, stale: true } : { value: raw as { n: number }, stale: false };

function store(trace: string[], fault: Error | null = null) {
	return {
		saveChecked(state: unknown) {
			trace.push(`write ${JSON.stringify(state)}`);
			if (fault) throw fault;
		},
	};
}

describe("checked commit", () => {
	it("leaves memory alone and runs no hook when the write does not land", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const trace: string[] = [];

		const result = commitChecked(store(trace, new Error("disk full")), 2, () => trace.push("apply"), {
			label: "test",
			onLanded: () => trace.push("hook"),
		});

		expect(result).toMatchObject({ landed: false, error: { message: "disk full" } });
		expect(trace).toEqual(["write 2"]);
	});

	it("counts an installed snapshot as landed: writes the snapshot, then applies, then runs the hook", () => {
		const trace: string[] = [];

		const result = commitChecked(
			store(trace, new DurableStoreInstalledError(new Error("fsync"))),
			[1, 2],
			() => trace.push("apply"),
			{ snapshot: { v: 1 }, onLanded: () => trace.push("hook") },
		);

		expect(result).toEqual({ landed: true });
		expect(trace).toEqual(['write {"v":1}', "apply", "hook"]);
	});

	it("still lands when the hook throws", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const trace: string[] = [];
		const hook = vi.fn(() => {
			throw new Error("runner gone");
		});

		const result = commitChecked(store(trace), 3, () => trace.push("apply"), { onLanded: hook });

		expect(result).toEqual({ landed: true });
		expect(trace).toEqual(["write 3", "apply"]);
		expect(hook).toHaveBeenCalledOnce();
	});
});

describe("a stale restore", () => {
	it("rewrites the file at once though the store never writes again", () => {
		const file = olderFile(7);
		const repairs = createRestoreRepairs();

		const held = restoreHeld({ store: file.store, label: "held", decode, repairs });

		expect(held.value).toEqual({ n: 7 });
		expect(file.onDisk()).toEqual({ n: 7 });
		expect(repairs.pending()).toEqual([]);
	});

	it("is retried on every persist pass while its write fails, and clears once one lands", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const file = olderFile(7);
		file.faults.failing = true;
		const repairs = createRestoreRepairs();

		const held = restoreHeld({ store: file.store, label: "held", decode, repairs });
		repairs.retry();

		expect(held.value).toEqual({ n: 7 });
		expect(file.onDisk()).toBe(7);
		expect(repairs.pending()).toEqual(["held"]);

		file.faults.failing = false;
		repairs.retry();

		expect(file.onDisk()).toEqual({ n: 7 });
		expect(repairs.pending()).toEqual([]);
	});

	it("clears when a later commit lands", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const file = olderFile(7);
		file.faults.failing = true;
		const repairs = createRestoreRepairs();
		const held = restoreHeld({ store: file.store, label: "held", decode, repairs });

		file.faults.failing = false;
		expect(held.commit({ n: 8 })).toEqual({ landed: true });

		expect(file.onDisk()).toEqual({ n: 8 });
		expect(repairs.pending()).toEqual([]);
	});
});
