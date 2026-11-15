export const TEXT_HOLE_CASES: readonly (readonly [string, string])[] = [
	["plain text is one run", "It is cold outside."],
	["a hole between two runs", "It is {value} outside."],
	["a hole at each end", "{device}: {value}"],
	["escaped braces and a backslash are text", "Use \\{name\\} or \\\\ here"],
	["a backslash before another letter stays", "C:\\temp {x}"],
	["a lone closing brace is text", "} then {x}"],
	["a dict inside a hole nests", "{ {k: 1}.k } after"],
	["a quoted brace does not close a hole", "say {if(a, \"}\", '{')} done"],
	["an escaped quote stays inside its string", '{"a\\"}"} tail'],
	["an open hole runs to the end", "It is {value outside"],
	["an empty hole", "a {} b"],
	["a surrogate pair before a hole", "\u{1F600} {x}"],
];
