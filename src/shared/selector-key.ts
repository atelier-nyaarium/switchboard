// The one shape rule: program and first argument, or every argument once a flag leads.

import { basenameOf, isWrapper, peelWrappers, withoutAssignments } from "./command-wrappers.js";

/** sudo options that take a value, so the value is never read as the command. */
const SUDO_VALUED_FLAGS = new Set(["-C", "-D", "-g", "-h", "-p", "-r", "-t", "-T", "-u", "-U"]);

export function shapeFrom(words: string[]): string {
	const program = words[0];
	if (program === undefined) return "";
	const name = basenameOf(program);
	const rest = words.slice(1);
	const first = rest[0];
	if (first === undefined) return name;
	return first.startsWith("-") ? [name, ...rest].join(" ") : `${name} ${first}`;
}

/** Drops sudo's askpass flags. */
export function withoutAskpassFlags(tokens: string[]): string[] {
	const program = tokens[0];
	if (program === undefined || basenameOf(program) !== "sudo") return tokens;
	const kept = [program];
	let index = 1;
	for (; index < tokens.length && (tokens[index] as string).startsWith("-"); index += 1) {
		const token = tokens[index] as string;
		if (token === "--") break;
		if (token === "--askpass") continue;
		const flag = token.startsWith("--") || !token.includes("A") ? token : token.replace("A", "");
		if (flag !== "-") kept.push(flag);
		if (SUDO_VALUED_FLAGS.has(`-${flag.at(-1)}`) && !flag.startsWith("--") && index + 1 < tokens.length) {
			index += 1;
			kept.push(tokens[index] as string);
		}
	}
	return [...kept, ...tokens.slice(index)];
}

/** Case preserved; the host is case-sensitive. The brief keeps sudo's `--`; the key does not. */
export function selectorKey(example: string): string {
	const words = withoutAskpassFlags(example.trim().split(/\s+/).filter(Boolean));
	const mark = words.indexOf("--");
	const keyed = mark > 0 && basenameOf(words[0] as string) === "sudo" ? words.filter((_, i) => i !== mark) : words;
	const [program, ...rest] = keyed;
	if (program === undefined || basenameOf(program) !== "sudo" || rest[0] === undefined || rest[0].startsWith("-")) {
		return shapeFrom(keyed);
	}
	const inner = peelWrappers(withoutAssignments(rest));
	const head = inner[0];
	// Otherwise the whole line.
	const peeled = head !== undefined && !head.startsWith("-") && !(inner.length > 1 && isWrapper(head));
	return peeled ? shapeFrom([program, ...inner]) : [basenameOf(program), ...rest].join(" ");
}
