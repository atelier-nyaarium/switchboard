// The one shape rule: program and first argument, or every argument once a flag leads.

import { basenameOf, isWrapper, peelWrappers, withoutAssignments } from "./command-wrappers.js";

/** sudo's short options that take a value, attached or the next word. */
const SUDO_VALUED_FLAGS = new Set(["C", "D", "g", "h", "p", "r", "R", "t", "T", "u", "U"]);

/** sudo's long options that take the next word. */
const SUDO_VALUED_LONG = new Set([
	"--user",
	"--group",
	"--chdir",
	"--chroot",
	"--host",
	"--prompt",
	"--role",
	"--type",
	"--other-user",
	"--close-from",
	"--command-timeout",
]);

/** A sudo line read once: its options as kept, whether `--` ended them, and the command. */
export interface SudoLine {
	program: string;
	/** Askpass flags removed; values kept as written. */
	options: string[];
	separated: boolean;
	command: string[];
	/** `-s`, `-i`, `--shell` or `--login`. */
	shell: boolean;
}

/** The one walk over sudo's options. The askpass flag goes as a letter, never out of a value. */
export function parseSudo(tokens: readonly string[]): SudoLine | null {
	const program = tokens[0];
	if (program === undefined || basenameOf(program) !== "sudo") return null;
	const options: string[] = [];
	let shell = false;
	let index = 1;
	for (; index < tokens.length; index += 1) {
		const word = tokens[index] as string;
		if (word === "--") return { program, options, separated: true, command: tokens.slice(index + 1), shell };
		if (!word.startsWith("-")) break;
		let takesNext = false;
		if (word.startsWith("--")) {
			if (word === "--askpass") continue;
			options.push(word);
			if (word === "--shell" || word === "--login") shell = true;
			takesNext = !word.includes("=") && SUDO_VALUED_LONG.has(word);
		} else {
			let letters = "";
			for (let at = 1; at < word.length; at += 1) {
				const letter = word[at] as string;
				if (SUDO_VALUED_FLAGS.has(letter)) {
					letters += word.slice(at);
					takesNext = at === word.length - 1;
					break;
				}
				if (letter === "s" || letter === "i") shell = true;
				if (letter !== "A") letters += letter;
			}
			if (letters) options.push(`-${letters}`);
		}
		if (takesNext && index + 1 < tokens.length) {
			index += 1;
			options.push(tokens[index] as string);
		}
	}
	return { program, options, separated: false, command: tokens.slice(index), shell };
}

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
	const line = parseSudo(tokens);
	if (!line) return tokens;
	return [line.program, ...line.options, ...(line.separated ? ["--"] : []), ...line.command];
}

/** Keeps a `--` that names the program. */
function commandWords(line: SudoLine): string[] {
	const at = line.command.length - withoutAssignments(line.command).length;
	return line.command.filter((word, index) => word !== "--" || index === at);
}

/** The command sudo runs, assignments and wrappers peeled. */
export function sudoCommand(line: SudoLine): string[] {
	return peelWrappers(withoutAssignments(commandWords(line)));
}

/**
 * Case preserved; the host is case-sensitive. The brief keeps sudo's `--`; the key keeps it only
 * before a dash-led command, where the next read would take that word as an option. Built from one
 * parse, so a key reads back as itself.
 */
export function selectorKey(example: string): string {
	const tokens = example.trim().split(/\s+/).filter(Boolean);
	const line = parseSudo(tokens);
	if (!line) return shapeFrom(tokens);
	const name = basenameOf(line.program);
	const command = commandWords(line);
	const separator = line.separated && command[0]?.startsWith("-") ? ["--"] : [];
	if (line.options.length > 0 || separator.length > 0)
		return [name, ...line.options, ...separator, ...command].join(" ");
	if (command.length === 0) return name;
	const inner = sudoCommand(line);
	const head = inner[0];
	// Otherwise the whole line.
	const peeled = head !== undefined && !head.startsWith("-") && !(inner.length > 1 && isWrapper(head));
	return peeled ? shapeFrom([line.program, ...inner]) : [name, ...command].join(" ");
}

/** A key's first word: `sudo` for every sudo key. Keys sharing it share a program. */
export function keyProgram(key: string): string {
	return key.split(" ")[0] ?? "";
}
