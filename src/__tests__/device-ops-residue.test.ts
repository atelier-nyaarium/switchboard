import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DEVICE_OPS = path.join(
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
	"DeviceOps.kt",
);

describe("device slot operations", () => {
	it("keeps view landings behind typed slots", () => {
		const source = fs.readFileSync(DEVICE_OPS, "utf8");
		expect(source).not.toMatch(/GatewayReadFence|AtomicLong|MutableStateFlow|PublishedViews|\.update\s*\{/);
	});
});
