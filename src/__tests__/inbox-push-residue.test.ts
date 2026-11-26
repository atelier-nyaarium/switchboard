import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const SRC = path.resolve(import.meta.dirname, "..", "federation-server");
const FRAME_TYPE = /\btype\s*:\s*["']inbox_deliver["']/g;

const builders = (source: string): number => [...source.matchAll(FRAME_TYPE)].length;

describe("inbox push residue", () => {
	it("finds only inbox delivery frames", () => {
		expect(builders('send({ type: "inbox_deliver", address });')).toBe(1);
		expect(builders('send({ type: "inbox_read", address });')).toBe(0);
	});

	it("builds the frame in pushInboxRows alone", () => {
		const bridge = readFileSync(path.join(SRC, "gatewayBridge.ts"), "utf8");
		const pushInboxRows = bridge.match(/public pushInboxRows\([\s\S]*?^\t\}/m)?.[0] ?? "";
		const found = filesUnder(SRC)
			.filter((file) => file.endsWith(".ts") && !file.includes(`${path.sep}__tests__${path.sep}`))
			.map((file) => ({ file: path.relative(SRC, file), count: builders(readFileSync(file, "utf8")) }))
			.filter(({ count }) => count > 0);
		expect(found).toEqual([{ file: "gatewayBridge.ts", count: 1 }]);
		expect(builders(pushInboxRows)).toBe(1);
	});
});
