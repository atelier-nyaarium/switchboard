import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID_MAIN = path.join(import.meta.dirname, "..", "..", "android", "app", "src", "main");
const SUSPENDING_CALL =
	/\b(?:await|delay\s*\(|withContext\s*\(|withLock\b|\.send\s*\(|\.receive\s*\(|collect\b|withTimeout\s*\()/;
const BUILDER = /\b(?:launch|async|withContext|coroutineScope|supervisorScope|LaunchedEffect)\s*(?:\([^{}]*\))?\s*\{/;
const CATCH = /catch\s*\(\s*(?:([A-Za-z_]\w*)|_)\s*:\s*(Exception|Throwable|CancellationException)\s*\)\s*\{/g;

function kotlinFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) kotlinFiles(full, acc);
		else if (entry.endsWith(".kt")) acc.push(full);
	}
	return acc;
}

function rawRunCatchingOffenders(file: string, source: string): string[] {
	const matches = source.matchAll(/\brunCatching\s*[({]|\.runCatching\s*[({]|@runCatching(?!\w)/g);
	return [...matches].map((match) => `${file}:${lineAt(source, match.index ?? 0)} use runCatchingCancellable`);
}

function bracePairs(source: string): Map<number, number> {
	const stack: number[] = [];
	const pairs = new Map<number, number>();
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "{") stack.push(index);
		else if (source[index] === "}") {
			const open = stack.pop();
			if (open !== undefined) pairs.set(open, index);
		}
	}
	return pairs;
}

function suspendNames(sources: string[]): Set<string> {
	const names = new Set<string>();
	for (const source of sources) {
		for (const match of source.matchAll(/\bsuspend\s+fun\s+(?:<[^>]+>\s*)?(\w+)/g)) names.add(match[1] as string);
	}
	return names;
}

/** Per file: a common name like `block` is a plain lambda elsewhere. */
function suspendLambdaNames(source: string): Set<string> {
	return new Set([...source.matchAll(/\b(\w+)\s*:\s*suspend\s*(?:\w+\.)?\(/g)].map((match) => match[1] as string));
}

function hasSuspendingCall(block: string, names: Set<string>): boolean {
	if (SUSPENDING_CALL.test(block)) return true;
	for (const name of names) if (new RegExp(`\\b${name}\\s*\\(`).test(block)) return true;
	return false;
}

function lineAt(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

function resultChainAfter(source: string, close: number): string {
	let chain = "";
	let parentheses = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = close + 1; index < source.length; index++) {
		const character = source[index] as string;
		chain += character;
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") brackets++;
		else if (character === "]") brackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		if (character === "\n" && parentheses === 0 && brackets === 0 && braces === 0) {
			const nextLine =
				source
					.slice(index + 1)
					.split("\n", 1)[0]
					?.trim() ?? "";
			if (!nextLine.startsWith(".")) break;
		}
	}
	return chain;
}

function insideSuspendingContext(source: string, open: number, pairs: Map<number, number>): boolean {
	const contexts = [
		...source.matchAll(/\bsuspend\s+fun\b[^{;=]*\{/g),
		...source.matchAll(new RegExp(BUILDER.source, "g")),
	];
	let suspending = false;
	for (const match of contexts) {
		const ancestor = (match.index ?? 0) + match[0].lastIndexOf("{");
		const close = pairs.get(ancestor);
		const nestedFunction = /\b(?:[A-Za-z_]\w*\s+)*fun\s+\w+\s*\(/.test(source.slice(ancestor + 1, open));
		if (nestedFunction || close === undefined || ancestor >= open || close <= open) continue;
		// Nothing inside can be cancelled.
		if (/NonCancellable/.test(match[0])) return false;
		suspending = true;
	}
	// An expression body: its first brace opens the expression.
	for (const match of source.matchAll(/\bsuspend\s+fun\b[^{;=]*\)\s*(?::[^={]*)?=/g)) {
		const ancestor = source.indexOf("{", (match.index ?? 0) + match[0].length);
		const close = pairs.get(ancestor);
		if (close !== undefined && ancestor <= open && close >= open) suspending = true;
	}
	return suspending;
}

function offendersIn(file: string, source: string, suspendFunctions: Set<string>): string[] {
	const names = new Set([...suspendFunctions, ...suspendLambdaNames(source)]);
	const pairs = bracePairs(source);
	const offenders: string[] = [];

	for (const match of source.matchAll(/\brunIsolated\s*\{/g)) {
		const open = (match.index ?? 0) + match[0].lastIndexOf("{");
		const close = pairs.get(open);
		if (close === undefined || !insideSuspendingContext(source, open, pairs)) continue;
		if (
			hasSuspendingCall(source.slice(open + 1, close), names) &&
			!resultChainAfter(source, close).includes(".rethrowCancellation()")
		) {
			offenders.push(`${file}:${lineAt(source, open)} use runIsolated with .rethrowCancellation() after cleanup`);
		}
	}

	for (const match of source.matchAll(CATCH)) {
		const catchOpen = (match.index ?? 0) + match[0].lastIndexOf("{");
		const tryClose = source.lastIndexOf("}", (match.index ?? 0) - 1);
		const tryOpen = [...pairs].find(([, close]) => close === tryClose)?.[0];
		if (tryOpen === undefined || !insideSuspendingContext(source, tryOpen, pairs)) continue;
		if (!hasSuspendingCall(source.slice(tryOpen + 1, tryClose), names)) continue;
		const catchClose = pairs.get(catchOpen);
		const catchBody = catchClose === undefined ? "" : source.slice(catchOpen + 1, catchClose);
		const catchesCancellation = match[2] === "CancellationException";
		const caught = match[1];
		const rethrows =
			(/CancellationException/.test(catchBody) && /\bthrow\b/.test(catchBody)) ||
			/\brethrowIfCancellation\s*\(/.test(catchBody) ||
			(caught !== undefined && new RegExp(`\\bthrow\\s+${caught}\\b`).test(catchBody));
		const priorCancellationCatch = /catch\s*\(\s*(?:\w+|_)\s*:\s*CancellationException\s*\)[\s\S]*?\bthrow\b/.test(
			source.slice(tryClose, match.index ?? tryClose),
		);
		if (!catchesCancellation && !rethrows && !priorCancellationCatch) {
			offenders.push(
				`${file}:${lineAt(source, match.index ?? 0)} use runCatchingCancellable or rethrow CancellationException`,
			);
		}
	}

	return offenders;
}

function offendersOf(kotlin: string): string[] {
	return offendersIn("probe.kt", kotlin, suspendNames([kotlin]));
}

describe("coroutine cancellation", () => {
	it("refuses raw runCatching everywhere on the phone", () => {
		const files = kotlinFiles(ANDROID_MAIN).filter((file) => !file.endsWith("/Cancellation.kt"));
		const offenders = files.flatMap((file) =>
			rawRunCatchingOffenders(path.relative(process.cwd(), file), fs.readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
		expect(rawRunCatchingOffenders("probe.kt", "fun f() { runCatching { 1 } }")).toHaveLength(1);
		expect(rawRunCatchingOffenders("probe.kt", "fun f() { runCatchingCancellable { 1 } }")).toEqual([]);
		expect(rawRunCatchingOffenders("probe.kt", "fun f() { return@runCatching null }")).toHaveLength(1);
		expect(rawRunCatchingOffenders("probe.kt", "fun f() { return@runCatchingCancellable null }")).toEqual([]);
	});

	it("does not swallow cancellation around suspending calls", () => {
		const files = kotlinFiles(ANDROID_MAIN);
		const sources = files.map((file) => fs.readFileSync(file, "utf8"));
		const names = suspendNames(sources);
		expect(files.length).toBeGreaterThan(50);
		expect(names.has("refreshNow")).toBe(true);
		const offenders = files.flatMap((file, index) =>
			offendersIn(path.relative(process.cwd(), file), sources[index] as string, names),
		);
		expect(offenders).toEqual([]);
	});

	it("refuses a swallowed suspend call in a broad catch", () => {
		expect(offendersOf("suspend fun f() { runIsolated { delay(1) } }")).toHaveLength(1);
		expect(
			offendersOf("suspend fun f() { runIsolated { delay(1) }.onFailure { cleanup() }.rethrowCancellation() }"),
		).toEqual([]);
		expect(offendersOf("fun f() { runIsolated { delay(1) } }")).toEqual([]);
		expect(
			offendersOf(
				"fun g(scope: CoroutineScope) { scope.launch { try { delay(1) } catch (e: Exception) { log(e) } } }",
			),
		).toHaveLength(1);
	});

	it("admits a rethrow, a NonCancellable block, and a catch with nothing to suspend", () => {
		expect(offendersOf("suspend fun f() { try { delay(1) } catch (t: Throwable) { log(t); throw t } }")).toEqual(
			[],
		);
		expect(
			offendersOf("suspend fun f() { try { delay(1) } catch (e: Exception) { e.rethrowIfCancellation() } }"),
		).toEqual([]);
		expect(
			offendersOf("suspend fun f() = withContext(NonCancellable) { try { send() } catch (e: Exception) { } }"),
		).toEqual([]);
	});

	it("reads a local suspend function as suspending", () => {
		expect(
			offendersOf(
				"suspend fun outer() { suspend fun local() { try { delay(1) } catch (e: Exception) { log(e) } } }",
			),
		).toHaveLength(1);
	});
});
