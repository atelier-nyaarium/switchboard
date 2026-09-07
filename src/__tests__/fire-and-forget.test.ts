import { describe, expect, it, vi } from "vitest";
import { fireAndForget } from "../gateway/fireAndForget.js";

async function watched(work: Promise<unknown>): Promise<{ warned: string[]; failures: number }> {
	const warned: string[] = [];
	let failures = 0;
	const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => warned.push(line));
	try {
		fireAndForget("probe", work, () => {
			failures++;
		});
		await work.catch(() => undefined);
		await Promise.resolve();
		await Promise.resolve();
	} finally {
		warn.mockRestore();
	}
	return { warned, failures };
}

describe("fireAndForget", () => {
	it("says nothing for work that succeeded", async () => {
		const quiet = await watched(Promise.resolve({ ok: true }));
		expect(quiet).toEqual({ warned: [], failures: 0 });
		const answered = await watched(Promise.resolve({ callId: "c1", result: { ok: true, teams: [] } }));
		expect(answered.warned).toEqual([]);
	});

	it("names a rejection", async () => {
		const { warned, failures } = await watched(Promise.reject(new Error("socket gone")));
		expect(warned[0]).toContain("socket gone");
		expect(failures).toBe(1);
	});

	it("names a refusal that resolved rather than threw", async () => {
		const flat = await watched(Promise.resolve({ ok: false, error: "too many waiting" }));
		expect(flat.warned[0]).toContain("too many waiting");
		expect(flat.failures).toBe(1);

		// A wake answers its reason under errorKind instead.
		const kinded = await watched(Promise.resolve({ ok: false, errorKind: "disconnected" }));
		expect(kinded.warned[0]).toContain("disconnected");
	});

	it("reads a Router answer at the top and one level in", async () => {
		const transport = await watched(Promise.resolve({ callId: "", error: "Not connected to the Router" }));
		expect(transport.warned[0]).toContain("Not connected");
		expect(transport.failures).toBe(1);

		const refused = await watched(Promise.resolve({ callId: "c1", result: { ok: false, error: "unshared" } }));
		expect(refused.warned[0]).toContain("unshared");
		expect(refused.failures).toBe(1);
	});
});
