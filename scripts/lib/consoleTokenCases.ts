// What the token corpus lexes; the suite holds the fixture to this list.

export const CONSOLE_TOKEN_CASES: readonly (readonly [string, string])[] = [
	["a path, a call and an index", 'sensors.read("Freezer").readings[0]'],
	["a minus is never part of a number", "5-3 -(2-5)"],
	["a fraction needs a digit after its point", "1.5.x 3. .5"],
	["both quotes, and an escaped quote", '\'single\' + "dbl\\"q"'],
	["known escapes decode, an unknown one keeps its letter", '"a\\nb\\tc\\\\d\\x"'],
	["an open string runs to the end", '"Free'],
	["a backslash at the end stays", '"ab\\'],
	["every operator", "== != ! = + - * / < > <= >="],
	["a comparison binds without spaces", "a<=b>c<d>=e"],
	["a dict of a list of keywords", "{k: [1, true, false, null]}"],
	["names take digits after the first letter", "a_b9 _x 9ab"],
	["an unknown character is an error token", "x # y"],
	["a surrogate pair inside a string, and outside one", '"\u{1F600}" \u{1F600}'],
	["only space, tab, return and newline are whitespace", `\t\r\n a${String.fromCharCode(0xa0)}b`],
	["a keyword must stand alone", "trueish true_ null"],
	["an assignment reads as tokens", "outside = sensors.list"],
	["a semicolon separates statements", "a = 1; a + 2;\n b"],
];
