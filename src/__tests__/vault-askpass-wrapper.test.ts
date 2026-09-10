import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	askpassWrapperText,
	installAskpassWrapper,
	removeAskpassWrapper,
	vaultAskpassBin,
} from "../shared/vault-askpass-wrapper.js";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
const home = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askpass-home-"));
	homes.push(dir);
	return dir;
};

describe("the askpass wrapper", () => {
	it("execs the bundle under the given bun, baking a gateway only when one is named", () => {
		expect(askpassWrapperText({ bun: "/opt/bun", bundle: "/srv/dist/main-vault-askpass.js" })).toBe(
			`#!/usr/bin/env bash\nexec '/opt/bun' '/srv/dist/main-vault-askpass.js' "$@"\n`,
		);
		expect(
			askpassWrapperText({
				bun: "/opt/bun",
				bundle: "/it's/main-vault-askpass.js",
				gatewayUrl: "http://switchboard:20000",
			}),
		).toBe(
			`#!/usr/bin/env bash\nexport BRIDGE_ROUTER_URL='http://switchboard:20000'\nexec '/opt/bun' '/it'\\''s/main-vault-askpass.js' "$@"\n`,
		);
	});

	it("lands executable under the home, replaces a stale one, and removes only what its receipt describes", () => {
		const dir = home();
		const first = installAskpassWrapper(dir, { bun: "/opt/bun", bundle: "/srv/a/main-vault-askpass.js" });
		expect(first.bin).toBe(vaultAskpassBin(dir));
		expect(fs.statSync(first.bin).mode & 0o111).toBe(0o111);
		const second = installAskpassWrapper(dir, { bun: "/opt/bun", bundle: "/srv/b/main-vault-askpass.js" });
		expect(fs.readFileSync(second.bin, "utf8")).toBe(second.text);
		// A stale receipt names a file that is no longer there to remove.
		expect(removeAskpassWrapper(dir, first.text)).toBe(false);
		expect(fs.existsSync(second.bin)).toBe(true);
		expect(removeAskpassWrapper(dir, second.text)).toBe(true);
		expect(fs.existsSync(second.bin)).toBe(false);
		expect(removeAskpassWrapper(dir, second.text)).toBe(false);
	});
});
