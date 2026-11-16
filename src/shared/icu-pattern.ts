// Android compiles patterns with ICU, which refuses a bare `}` that OpenJDK takes as a literal.

/** A quantifier brace is not a literal. */
const QUANTIFIER = /^\d+(?:,\d*)?\}/;

/** A `}` ICU would refuse. */
export function unescapedBrace(pattern: string): boolean {
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "{" && QUANTIFIER.test(pattern.slice(i + 1))) {
			i += pattern.slice(i + 1).indexOf("}") + 1;
			continue;
		}
		if (ch === "}") return true;
	}
	return false;
}
