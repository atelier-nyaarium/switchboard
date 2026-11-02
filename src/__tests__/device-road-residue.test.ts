import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the device road is the only way to a store or a driver", () => {
	it("keeps the stage off the store and the drivers", () => {
		const source = fs.readFileSync(path.join(REPO_ROOT, "src/gateway/compose/composeDevices.ts"), "utf8");
		expect(source).not.toMatch(/openDeviceStore|createKasaDriver|\bcatch\s*[({]/);
	});
});
