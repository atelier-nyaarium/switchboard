import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OPS = ["DeviceOps.kt", "LiveConsoleOps.kt"].map((name) =>
	path.join(
		import.meta.dirname,
		"..",
		"..",
		"android",
		"app",
		"src",
		"main",
		"java",
		"com",
		"atelier_nyaarium",
		"switchboard",
		name,
	),
);

describe("slot operations", () => {
	it.each(OPS)("keeps view landings behind typed slots: %s", (file) => {
		const source = fs.readFileSync(file, "utf8");
		expect(source).not.toMatch(/GatewayReadFence|AtomicLong|MutableStateFlow|PublishedViews|\.update\s*\{/);
	});
});
