import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID_MAIN = path.join(
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
);

// .optional() refuses null, .nullable() refuses absence
const NULLABLE_FIELD = /^\s*val \w+: .+\? = null,$/;
const MODE = /^\s*@EncodeDefault\(EncodeDefault\.Mode\.(ALWAYS|NEVER)\)$/;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

const unstated = (source: string): string[] => {
	const lines = source.split("\n");
	return lines
		.filter((line, index) => NULLABLE_FIELD.test(line) && !MODE.test(lines[index - 1] ?? ""))
		.map((line) => line.trim());
};

describe("a null the phone encodes", () => {
	it("is decided by its generated field, never by a Json setting", () => {
		const protocol = fs.readFileSync(path.join(ANDROID_MAIN, "proto", "Protocol.kt"), "utf8");
		const setters = kotlinFiles(ANDROID_MAIN)
			.filter((file) => /\bexplicitNulls\s*=/.test(fs.readFileSync(file, "utf8")))
			.map((file) => path.relative(ANDROID_MAIN, file));

		expect(unstated(protocol)).toEqual([]);
		expect(setters).toEqual([]);
	});

	it("tells a stated field from an unstated one", () => {
		const stated = "\t@EncodeDefault(EncodeDefault.Mode.NEVER)\n\tval label: String? = null,";

		expect(unstated(stated)).toEqual([]);
		expect(unstated("\tval label: String? = null,")).toEqual(["val label: String? = null,"]);
		expect(unstated("\tval enabled: Boolean,")).toEqual([]);
	});
});
