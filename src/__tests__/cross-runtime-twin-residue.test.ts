import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SHARED = path.join(ROOT, "src", "shared");
const ANDROID_SRC = path.join(ROOT, "android", "app", "src");
const TEST_DIRS = [path.join(ROOT, "src", "__tests__"), path.join(ROOT, "src", "testing")];
const FENCE = path.join(ROOT, "src", "__tests__", "cross-runtime-twin-residue.test.ts");

const EXEMPTIONS: Record<string, Record<string, string>> = {
	"main/java/com/atelier_nyaarium/switchboard/RouterReach.kt": {
		DEFAULT_ROUTER_PORT: "No Protocol constant.",
		LAN_CONNECT_TIMEOUT_MS: "No Protocol constant.",
	},
	"main/java/com/atelier_nyaarium/switchboard/AssistantRoot.kt": {
		ASSISTANT_SPAWN: "No Protocol constant.",
	},
	"main/java/com/atelier_nyaarium/switchboard/crypto/ContentAadKinds.kt": {
		BOARD_TITLE_KIND: "Pinned by envelope vectors.",
		BOARD_BODY_KIND: "Pinned by envelope vectors.",
		BOARD_NAME_KIND: "Pinned by envelope vectors.",
		VAULT_PUBLIC_TITLE_KIND: "Pinned by envelope vectors.",
		VAULT_PUBLIC_DESCRIPTION_KIND: "Pinned by envelope vectors.",
		VAULT_PRIVATE_TITLE_KIND: "Pinned by envelope vectors.",
		VAULT_PRIVATE_DESCRIPTION_KIND: "Pinned by envelope vectors.",
		VAULT_VALUE_KIND: "Pinned by envelope vectors.",
		VAULT_GATEWAYS_KIND: "Pinned by envelope vectors.",
		VAULT_TYPED_KIND: "Pinned by envelope vectors.",
	},
	"main/java/com/atelier_nyaarium/switchboard/crypto/SealedBlob.kt": {
		BLOB_NONCE_BYTES: "Pinned by sealed-blob vectors.",
		BLOB_TAG_BYTES: "Pinned by sealed-blob vectors.",
		BLOB_FRAME_OVERHEAD_BYTES: "Pinned by sealed-blob vectors.",
		BLOB_CIPHERTEXT_CHUNK_BYTES: "Derived from Protocol.",
	},
	"main/java/com/atelier_nyaarium/switchboard/policies/PolicyDraft.kt": {
		MAX_SELECTOR_LEN: "No Protocol constant.",
	},
};

const KOTLIN_CONST =
	/^[ \t]*(?:@[\w.]+(?:\([^)\n]*\))?[ \t]+)*(?:[A-Za-z_][A-Za-z0-9_]*[ \t]+)*const[ \t]+val[ \t]+([A-Z][A-Z0-9_]*)[ \t]*(?::[ \t]*[^=\r\n]+)?=[ \t]*(?:\r?\n[ \t]*)?([^\r\n]*)/gm;

type SourceFile = { path: string; source: string };
type TwinHit = { path: string; name: string };

function filesUnder(directory: string, suffix: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...filesUnder(full, suffix));
		else if (entry.isFile() && full.endsWith(suffix)) files.push(full);
	}
	return files;
}

function sourcesUnder(directory: string, suffix: string, relativeTo: string): SourceFile[] {
	return filesUnder(directory, suffix).map((file) => ({
		path: path.relative(relativeTo, file),
		source: fs.readFileSync(file, "utf8"),
	}));
}

function sharedConstNames(files: readonly SourceFile[]): Set<string> {
	const names = new Set<string>();
	for (const { source } of files) {
		for (const match of source.matchAll(/^[ \t]*export[ \t]+const[ \t]+([A-Z][A-Z0-9_]*)\b/gm)) {
			names.add(match[1] as string);
		}
	}
	return names;
}

function sameNameTwinOffenders(tsNames: ReadonlySet<string>, files: readonly SourceFile[]): TwinHit[] {
	const hits: TwinHit[] = [];
	for (const { path: file, source } of files) {
		if (/proto\/Protocol\.kt$/.test(file)) continue;
		for (const match of source.matchAll(KOTLIN_CONST)) {
			const name = match[1] as string;
			if (!tsNames.has(name)) continue;
			const initializer = (match[2] as string).trim();
			const protocolPath = new RegExp(`^Protocol(?:\\.[A-Za-z_][A-Za-z0-9_]*)*\\.${name}$`);
			if (!protocolPath.test(initializer)) hits.push({ path: file, name });
		}
	}
	return hits;
}

function kotlinTsDeclarationQuotes(files: readonly SourceFile[]): string[] {
	const declaration = /src\/[\w./-]+\.ts:?\s+(?:export\s+)?(?:const\s+)?[A-Z][A-Z0-9_]*(?::\s*[\w<>|. ]+?)?\s*=/g;
	return files.flatMap(({ path: file, source }) => [...source.matchAll(declaration)].map(() => file));
}

function tsKotlinInitializerCaptures(files: readonly SourceFile[]): string[] {
	const capture = /\b([A-Z][A-Z0-9_]*)(?::\\s[*+]\w+)?\\s[*+]=\\s[*+]["']?\(/g;
	return files.flatMap(({ path: file, source }) => [...source.matchAll(capture)].map(() => file));
}

function staleExemptions(files: readonly SourceFile[]): TwinHit[] {
	const declarations = new Set<string>();
	for (const { path: file, source } of files) {
		for (const match of source.matchAll(KOTLIN_CONST)) {
			declarations.add(`${file}: ${match[1]}`);
		}
	}
	return Object.entries(EXEMPTIONS).flatMap(([file, names]) =>
		Object.keys(names)
			.map((name) => ({ path: file, name }))
			.filter(({ path, name }) => !declarations.has(`${path}: ${name}`)),
	);
}

describe("cross-runtime Kotlin twins", () => {
	it("refuses a same-name Kotlin copy outside the exemptions", () => {
		const shared = sourcesUnder(SHARED, ".ts", ROOT);
		const kotlin = sourcesUnder(ANDROID_SRC, ".kt", ANDROID_SRC);
		const hits = sameNameTwinOffenders(sharedConstNames(shared), kotlin);
		const unclassified = hits.filter(({ path: file, name }) => !EXEMPTIONS[file]?.[name]);
		expect(unclassified.map(({ path: file, name }) => `${file}: ${name}`)).toEqual([]);
	});

	it("keeps every exemption attached to a Kotlin declaration", () => {
		const kotlin = sourcesUnder(ANDROID_SRC, ".kt", ANDROID_SRC);
		expect(staleExemptions(kotlin)).toEqual([]);
	});

	it("distinguishes hand-written constants from Protocol reads", () => {
		const tsNames = new Set(["CONSOLE_ANSWER_WAIT_MS"]);
		expect(
			sameNameTwinOffenders(tsNames, [
				{ path: "ConsoleHttp.kt", source: "const val CONSOLE_ANSWER_WAIT_MS = 35_000L" },
			]),
		).toEqual([{ path: "ConsoleHttp.kt", name: "CONSOLE_ANSWER_WAIT_MS" }]);
		expect(
			sameNameTwinOffenders(tsNames, [
				{
					path: "ConsoleHttp.kt",
					source: "const val CONSOLE_ANSWER_WAIT_MS: Long = Protocol.CONSOLE_ANSWER_WAIT_MS",
				},
			]),
		).toEqual([]);
		expect(
			sameNameTwinOffenders(tsNames, [
				{
					path: "ConsoleHttp.kt",
					source: "internal const val PINNED_READ_TIMEOUT_MS = Protocol.CONSOLE_ANSWER_WAIT_MS",
				},
			]),
		).toEqual([]);
		expect(
			sameNameTwinOffenders(tsNames, [
				{ path: "ConsoleHttp.kt", source: `@Deprecated("x") const val CONSOLE_ANSWER_WAIT_MS = 35_000L` },
			]),
		).toEqual([{ path: "ConsoleHttp.kt", name: "CONSOLE_ANSWER_WAIT_MS" }]);
		expect(
			sameNameTwinOffenders(tsNames, [
				{
					path: "ConsoleHttp.kt",
					source: "const val CONSOLE_ANSWER_WAIT_MS: Long =\n\tProtocol.CONSOLE_ANSWER_WAIT_MS",
				},
			]),
		).toEqual([]);
	});

	it("finds Kotlin text that quotes TypeScript declarations", () => {
		const samples = [
			"// src/gateway/console/consoleHandler.ts: const CREATE_SESSION_BOUND_MS = 25_000",
			"// src/shared/schemas.ts: MAX_POLL_HOLD_MS = 45_000",
			"// src/shared/console-protocol.ts: export const CONSOLE_ANSWER_WAIT_MS: number = 35_000",
			"// src/shared/schemas.ts: const max_poll_hold_ms = 45_000",
		].map((source, index) => ({ path: `${index}.kt`, source }));
		expect(kotlinTsDeclarationQuotes(samples)).toEqual(["0.kt", "1.kt", "2.kt"]);
	});

	it("finds TypeScript regexes that capture Kotlin initializers", () => {
		const samples = [
			String.raw`kotlin.match(/PINNED_READ_TIMEOUT_MS\s*=\s*([\d_]+)L/)`,
			String.raw`/BOARD_REFUSED_PREFIX\s*=\s*"([^"]+)"/.exec(kotlin)`,
			String.raw`kotlin.match(/CONSOLE_ANSWER_WAIT_MS:\s*Long\s*=\s*(\d+)/)`,
			"expect(source).toMatch(/idleTimeout: GATEWAY_IDLE_TIMEOUT_S/)",
		].map((source, index) => ({ path: `${index}.ts`, source }));
		expect(tsKotlinInitializerCaptures(samples)).toEqual(["0.ts", "1.ts", "2.ts"]);
	});

	it("leaves no TypeScript declaration quotes in Kotlin", () => {
		const kotlin = sourcesUnder(ANDROID_SRC, ".kt", ANDROID_SRC);
		expect(kotlinTsDeclarationQuotes(kotlin)).toEqual([]);
	});

	it("leaves no Kotlin initializer captures in TypeScript tests", () => {
		const tests = TEST_DIRS.flatMap((directory) => sourcesUnder(directory, ".ts", ROOT)).filter(
			({ path: file }) => path.join(ROOT, file) !== FENCE,
		);
		expect(tsKotlinInitializerCaptures(tests)).toEqual([]);
	});
});
