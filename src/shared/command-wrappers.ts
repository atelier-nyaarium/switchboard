// Programs that run another program, and the peel to it.

interface Wrapper {
	/** `VAR=value` before the program. */
	assignments?: true;
	/** Options taking the next word. */
	valued: ReadonlySet<string>;
	/** Options taking none. An option in neither set stops the peel. */
	flags: ReadonlySet<string>;
	/** Modes running no program. */
	stops: ReadonlySet<string>;
	/** Its own words before the program, such as a duration. */
	leading?: number;
}

const none: ReadonlySet<string> = new Set();
const version: ReadonlySet<string> = new Set(["--help", "--version"]);
const versionShort: ReadonlySet<string> = new Set(["-h", "--help", "-V", "--version"]);

/** Programs that run the next program here. One running a string or a remote program is not one. */
const WRAPPERS: Record<string, Wrapper> = {
	sudo: {
		assignments: true,
		valued: new Set([
			"-C",
			"--close-from",
			"-D",
			"--chdir",
			"-g",
			"--group",
			"-h",
			"--host",
			"-p",
			"--prompt",
			"-R",
			"--chroot",
			"-r",
			"--role",
			"-T",
			"--command-timeout",
			"-t",
			"--type",
			"-U",
			"--other-user",
			"-u",
			"--user",
		]),
		flags: new Set([
			"-A",
			"--askpass",
			"-B",
			"--bell",
			"-b",
			"--background",
			"-E",
			"--preserve-env",
			"-H",
			"--set-home",
			"-i",
			"--login",
			"-k",
			"--reset-timestamp",
			"-n",
			"--non-interactive",
			"-P",
			"--preserve-groups",
			"-S",
			"--stdin",
			"-s",
			"--shell",
		]),
		stops: new Set([
			"-e",
			"--edit",
			"-l",
			"--list",
			"-v",
			"--validate",
			"-K",
			"--remove-timestamp",
			"-V",
			"--version",
			"--help",
		]),
	},
	doas: { valued: new Set(["-a", "-C", "-u"]), flags: new Set(["-n", "-s"]), stops: new Set(["-L"]) },
	pkexec: { valued: new Set(["--user"]), flags: new Set(["--disable-internal-agent", "--keep-cwd"]), stops: version },
	env: {
		assignments: true,
		valued: new Set(["-u", "--unset", "-C", "--chdir"]),
		// A signal list is attached or absent.
		flags: new Set([
			"-i",
			"--ignore-environment",
			"-0",
			"--null",
			"-v",
			"--debug",
			"--block-signal",
			"--default-signal",
			"--ignore-signal",
		]),
		// A split string is a line of its own.
		stops: new Set(["-S", "--split-string", "--list-signal-handling", "--help", "--version"]),
	},
	// A bare adjustment is `nice -5`.
	nice: {
		valued: new Set(["-n", "--adjustment"]),
		flags: new Set("0123456789".split("").map((d) => `-${d}`)),
		stops: version,
	},
	nohup: { valued: none, flags: none, stops: version },
	time: {
		valued: new Set(["-f", "--format", "-o", "--output"]),
		flags: new Set(["-a", "--append", "-p", "--portability", "-q", "--quiet", "-v", "--verbose"]),
		stops: version,
	},
	timeout: {
		valued: new Set(["-k", "--kill-after", "-s", "--signal"]),
		flags: new Set(["--foreground", "--preserve-status", "-v", "--verbose"]),
		stops: version,
		leading: 1,
	},
	chroot: {
		valued: new Set(["--groups", "--userspec"]),
		flags: new Set(["--skip-chdir"]),
		stops: version,
		leading: 1,
	},
	setsid: { valued: none, flags: new Set(["-c", "--ctty", "-f", "--fork", "-w", "--wait"]), stops: versionShort },
	stdbuf: { valued: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]), flags: none, stops: version },
	ionice: {
		valued: new Set(["-c", "--class", "-n", "--classdata"]),
		flags: new Set(["-t", "--ignore"]),
		stops: new Set(["-p", "--pid", "-P", "--pgid", "-u", "--uid", "-h", "--help", "-V", "--version"]),
	},
	taskset: {
		valued: none,
		flags: new Set(["-a", "--all-tasks", "-c", "--cpu-list"]),
		stops: new Set(["-p", "--pid", "-h", "--help", "-V", "--version"]),
		leading: 1,
	},
	chrt: {
		valued: new Set(["-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"]),
		flags: new Set([
			"-a",
			"--all-tasks",
			"-b",
			"--batch",
			"-d",
			"--deadline",
			"-f",
			"--fifo",
			"-i",
			"--idle",
			"-o",
			"--other",
			"-r",
			"--rr",
			"-R",
			"--reset-on-fork",
			"-v",
			"--verbose",
		]),
		stops: new Set(["-p", "--pid", "-m", "--max", "-h", "--help", "-V", "--version"]),
		leading: 1,
	},
	flock: {
		valued: new Set(["-w", "--timeout", "-E", "--conflict-exit-code"]),
		flags: new Set([
			"-s",
			"--shared",
			"-x",
			"--exclusive",
			"-n",
			"--nonblock",
			"-o",
			"--close",
			"-F",
			"--no-fork",
			"--verbose",
		]),
		stops: new Set(["-c", "--command", "-u", "--unlock", "-h", "--help", "-V", "--version"]),
		leading: 1,
	},
	xargs: {
		valued: new Set([
			"-a",
			"--arg-file",
			"-d",
			"--delimiter",
			"-E",
			"-I",
			"-L",
			"--max-lines",
			"-n",
			"--max-args",
			"-P",
			"--max-procs",
			"-s",
			"--max-chars",
			"--process-slot-var",
		]),
		flags: new Set([
			"-0",
			"--null",
			"-e",
			"--eof",
			"-i",
			"--replace",
			"-l",
			"-o",
			"--open-tty",
			"-p",
			"--interactive",
			"-r",
			"--no-run-if-empty",
			"-t",
			"--verbose",
			"-x",
			"--exit",
		]),
		stops: new Set(["--show-limits", "--help", "--version"]),
	},
	watch: {
		valued: new Set(["-n", "--interval", "-q", "--equexit"]),
		flags: new Set([
			"-b",
			"--beep",
			"-c",
			"--color",
			"-C",
			"--no-color",
			"-d",
			"--differences",
			"-e",
			"--errexit",
			"-g",
			"--chgexit",
			"-p",
			"--precise",
			"-r",
			"--no-rerun",
			"-t",
			"--no-title",
			"-w",
			"--no-wrap",
			"-x",
			"--exec",
		]),
		stops: new Set(["-h", "--help", "-v", "--version"]),
	},
	busybox: { valued: none, flags: none, stops: new Set(["--help", "--list", "--list-full", "--install"]) },
	command: { valued: none, flags: new Set(["-p"]), stops: new Set(["-v", "-V"]) },
	exec: { valued: new Set(["-a"]), flags: new Set(["-c", "-l"]), stops: none },
};

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** An unknown option is a stop, so an unlisted one never peels onto its value. */
function optionKind(wrapper: Wrapper, word: string): "stop" | "valued" | "flag" | "word" {
	if (word === "-" || !word.startsWith("-")) return "word";
	if (word === "--") return "flag";
	if (word.startsWith("--")) {
		const equals = word.indexOf("=");
		const name = equals === -1 ? word : word.slice(0, equals);
		if (wrapper.stops.has(name)) return "stop";
		if (!wrapper.valued.has(name) && !wrapper.flags.has(name)) return "stop";
		return equals === -1 && wrapper.valued.has(name) ? "valued" : "flag";
	}
	// `-pa` is `-p -a`, and a valued letter takes the bundle's tail.
	const letters = word.slice(1);
	for (let at = 0; at < letters.length; at++) {
		const letter = `-${letters[at]}`;
		if (wrapper.stops.has(letter)) return "stop";
		if (wrapper.valued.has(letter)) return at === letters.length - 1 ? "valued" : "flag";
		if (!wrapper.flags.has(letter)) return "stop";
	}
	return "flag";
}

/** The wrapped program's index in `rest`, or undefined when the wrapper runs none. */
function wrapped(wrapper: Wrapper, rest: string[]): number | undefined {
	let leading = wrapper.leading ?? 0;
	for (let index = 0; index < rest.length; index++) {
		const word = rest[index] as string;
		const kind = optionKind(wrapper, word);
		if (kind === "stop") return undefined;
		if (kind === "valued") index++;
		else if (kind === "flag" || (wrapper.assignments && ASSIGNMENT_RE.test(word))) continue;
		else if (leading > 0) leading--;
		else return index;
	}
	return undefined;
}

export function basenameOf(program: string): string {
	return program.slice(program.lastIndexOf("/") + 1) || program;
}

export function isWrapper(program: string): boolean {
	return WRAPPERS[basenameOf(program)] !== undefined;
}

/** Leading `VAR=value` words dropped. */
export function withoutAssignments(words: string[]): string[] {
	const first = words.findIndex((word) => !ASSIGNMENT_RE.test(word));
	return first === -1 ? [] : words.slice(first);
}

/** The command a line runs, wrappers peeled. A wrapper running no program stays. */
export function peelWrappers(words: string[]): string[] {
	let peeled = words;
	for (;;) {
		const program = peeled[0];
		const wrapper = program === undefined ? undefined : WRAPPERS[basenameOf(program)];
		const index = wrapper === undefined ? undefined : wrapped(wrapper, peeled.slice(1));
		if (index === undefined) return peeled;
		peeled = peeled.slice(index + 1);
	}
}
