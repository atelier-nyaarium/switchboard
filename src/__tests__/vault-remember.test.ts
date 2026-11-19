import { describe, expect, it } from "vitest";
import { rememberedPolicy } from "../gateway/vault/remember.js";
import type { AuthorizationPolicy } from "../shared/schemasPolicy.js";

const held = (over: Partial<AuthorizationPolicy> = {}): AuthorizationPolicy => ({
	id: "sudo",
	name: "Sudo",
	binding: { kind: "entry", entryId: "pw" },
	selectorKeys: ["sudo apt"],
	enabled: true,
	revision: 4,
	...over,
});

describe("what a remember writes", () => {
	it("adds the key at the revision held at the tap, and writes nothing for a key already named", () => {
		expect(rememberedPolicy(held(), "sudo apt-mark", "pw", { policyId: "sudo" })).toEqual({
			kind: "write",
			policy: held({ selectorKeys: ["sudo apt", "sudo apt-mark"] }),
			base: 4,
		});
		expect(rememberedPolicy(held(), "sudo apt", "pw", { policyId: "sudo" })).toEqual({
			kind: "held",
			policy: held(),
		});
	});

	it("refuses an add to a policy gone, bound elsewhere, or off", () => {
		const add = { policyId: "sudo" };
		expect(rememberedPolicy(null, "sudo apt", "pw", add)).toEqual({
			kind: "policy_refused",
			refusal: { code: "gone" },
		});
		expect(rememberedPolicy(held(), "sudo rm", "other", add)).toEqual({
			kind: "refused",
			refusal: { code: "bound_elsewhere", policy: "Sudo" },
		});
		expect(rememberedPolicy(held({ enabled: false }), "sudo rm", "pw", add)).toEqual({
			kind: "refused",
			refusal: { code: "target_off", policy: "Sudo" },
		});
	});

	it("creates under the phone's id and name; a retry of it is held, anything else goes to the store", () => {
		const create = { policyId: "new", name: "New" };
		expect(rememberedPolicy(null, "sudo rm", "pw", create)).toEqual({
			kind: "write",
			policy: {
				id: "new",
				name: "New",
				binding: { kind: "entry", entryId: "pw" },
				selectorKeys: ["sudo rm"],
				enabled: true,
				revision: 1,
			},
		});
		const created = held({ id: "new", name: "New", selectorKeys: ["sudo rm"], revision: 1 });
		expect(rememberedPolicy(created, "sudo rm", "pw", create)).toEqual({ kind: "held", policy: created });
		expect(rememberedPolicy(held({ id: "new" }), "sudo rm", "pw", create)).toMatchObject({ kind: "write" });
	});
});
