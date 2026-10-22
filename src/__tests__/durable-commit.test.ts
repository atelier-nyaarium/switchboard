import { describe, expect, it, vi } from "vitest";
import { commitChecked, DurableStoreInstalledError } from "../shared/durable-store.js";

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
