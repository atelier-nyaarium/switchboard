import { describe, expect, it } from "vitest";
import { type AuthorizationPolicy, canonicalPolicy, policyRefusal } from "../shared/schemasPolicy.js";
import { selectorKey } from "../shared/selector-key.js";
import { askpassBrief } from "../vault-askpass/askpass.js";

const policy = (selectorKeys: string[]): AuthorizationPolicy => ({
	id: "p1",
	name: "Package administration",
	binding: { kind: "entry", entryId: "sudo-pw" },
	selectorKeys,
	enabled: true,
	revision: 1,
});

describe("selectorKey", () => {
	it("is the program and its first argument, whole line once a flag leads, case kept", () => {
		expect(selectorKey("  sudo   apt install baz ")).toBe("sudo apt");
		expect(selectorKey("/usr/bin/sudo apt")).toBe("sudo apt");
		expect(selectorKey("sudo -u root apt")).toBe("sudo -u root apt");
		expect(selectorKey("Sudo APT")).toBe("Sudo APT");
		expect(selectorKey("")).toBe("");
	});

	it("keys a command typed with sudo's askpass flag as the helper will present it", () => {
		expect(selectorKey("sudo -A apt update")).toBe("sudo apt");
		expect(selectorKey("sudo -AH --askpass -u root apt update")).toBe("sudo -H -u root apt update");
	});

	it("derives distinct keys for a prefix and for a substring of a target", () => {
		expect(selectorKey("ssh deploy@prod uptime")).toBe("ssh deploy@prod");
		expect(selectorKey("ssh deploy@prod uptime")).not.toBe(selectorKey("ssh deploy"));
		expect(selectorKey("ssh deploy@prod")).not.toBe(selectorKey("ssh deploy@production"));
	});

	it("keys the helper's brief as the typed line", () => {
		for (const line of ["sudo -A apt update", "sudo\tapt\tinstall foo", "/usr/bin/sudo -AH -u root apt", "sudo"]) {
			expect(selectorKey(askpassBrief(line, "/usr/bin/sudo"))).toBe(selectorKey(line));
		}
	});
});

describe("a policy is stored in canonical form, and refused for what it means", () => {
	it("canonicalizes examples to keys, then passes", () => {
		const stored = canonicalPolicy(policy(["sudo apt install baz", "/usr/bin/systemctl restart x"]));
		expect(stored.selectorKeys).toEqual(["sudo apt", "systemctl restart"]);
		expect(policyRefusal(stored)).toBeNull();
	});

	it("refuses no selectors, an example that names nothing, a stored example, and a key named twice", () => {
		expect(policyRefusal(policy([]))).not.toBeNull();
		expect(policyRefusal(policy(["   "]))).not.toBeNull();
		expect(policyRefusal(policy(["sudo apt install baz"]))).not.toBeNull();
		expect(policyRefusal(canonicalPolicy(policy(["sudo apt install", "sudo apt remove"])))).not.toBeNull();
	});
});
