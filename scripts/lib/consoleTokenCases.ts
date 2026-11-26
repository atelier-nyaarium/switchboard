// What the token corpus lexes; the suite holds the fixture to these lists.

type Cases = readonly (readonly [string, string])[];

/** An expression. */
export const CONSOLE_TOKEN_CASES: Cases = [
	["a path, a call and an index", 'sensors.read("Freezer").readings[0]'],
	["a minus is never part of a number", "5-3 -(2-5)"],
	["a fraction needs a digit after its point", "1.5.x 3. .5"],
	["both quotes, and an escaped quote", '\'single\' + "dbl\\"q"'],
	["known escapes decode, an unknown one keeps its backslash", '"a\\nb\\tc\\rd\\\\e\\x"'],
	["an open string runs to the end", '"Free'],
	["a backslash at the end stays", '"ab\\'],
	["a string never passes its line", "\"ab\ncd\" 'e\r\nf'"],
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
	["and and or are operators, as whole words only", "a and b or andrew oracle"],
	["a hole in a string is lexed where it stands", '"Room {device} is {value + 1} C"'],
	["a quote inside a hole opens a string of its own", '"{sensors.value("Hall", "t")} C"'],
	["a string inside a hole holds a hole", "\"{a + 'b{c}d'}\""],
	["a hole's own braces nest", '"{ {k: 1}.k }"'],
	["an escaped brace is no hole, and a lone closing brace is text", '"a \\{b\\} } c"'],
	["an open hole runs to the end and leaves its string open", '"a {b + 1'],
	["a hole in a quoted string ends with its line, as its string does", '"a {b +\n1} c" d'],
	["a carriage return ends a quoted string too", '"ab\rcd"'],
	["an empty hole", '"a {} b"'],
	["a slash pair is two operators here", "a // b"],
	["strings nest no deeper than eight", '"{\'{"{\'{"{\'{"{\'{"{x}"}\'}"}\'}"}\'}"}\'}"'],
];

/** A text: a string's body with no quote around it. */
export const CONSOLE_TEXT_CASES: Cases = [
	["plain text is one run", "It is cold outside."],
	["a hole between two runs", "It is {value} outside."],
	["a hole at each end", "{device}: {value}"],
	["a backslash before another letter stays", "C:\\temp {x}"],
	["a lone closing brace is text", "} then {x}"],
	["a dict inside a hole nests", "{ {k: 1}.k } after"],
	["a closing brace in a hole's string does not close the hole", "say {if(a, \"}\", '\\{')} done"],
	["an opening brace in a hole's string opens a hole of its own", "say {a + '{b}'} done"],
	["a quote in a hole opens a string, which a line break ends", "{a + 'b\nc} d"],
	["an escaped quote stays inside its string", '{"a\\"}"} tail'],
	["an empty hole", "a {} b"],
	["a quote is text, and a line break ends nothing", "say \"hi\"\nand 'bye'"],
	["a text's escapes are the braces and the backslash alone", 'a \\{ b \\} c \\\\ d \\n e \\" f'],
	["a quote in a hole opens a string", 'It is {if(cold, "brr", "ok")} now'],
	["a string in a hole reads the quoted escapes", '{"a\\n\\"b\\""}'],
	["an open hole runs to the end", "It is {value outside"],
	["a hole in a text may pass its line, a string inside it may not", 'It is {if(x,\n 1, "a\nb")} now'],
	["a surrogate pair before a hole", "\u{1F600} {x}"],
];

/** A script: comments, and a token for each line break. */
export const CONSOLE_SCRIPT_CASES: Cases = [
	["a statement to a line", 'devices.set("Desk lamp", "on")\nexit'],
	[
		"an if with an else if and an else",
		'if (value > 1) {\n\twait(5)\n} else if (cold) {\n\texit\n} else {\n\tthrow "no"\n}',
	],
	["a try and its catch", 'try {\n\tifttt.trigger("go")\n} catch (e) {\n\tassistant.tell("now", "{e}")\n}'],
	["a comment line, a trailing comment, and slashes inside a string", '// first\nx = "a // b" // why\n'],
	["a line break inside a bracket is a token too", 'functions.run("Blink", {\n\tlamp: "Desk lamp",\n})\nexit'],
	["a comment inside an open bracket", "f(a, // one\n b)\nexit"],
	["an open string ends with its line", 'x = "abc\ny = 1'],
	["an open hole in a string ends with its line", 'x = "{a\ny = 1'],
	["a hole in a string is lexed as an expression, never as script", 'x = "{a // b\n}"'],
	["blank lines, and a stray close", "}\n\n\nexit\n"],
	["tabs, returns and no closing newline", "\tif(a){\r\n\t\texit\r\n\t}"],
	["a comment ends before its carriage return", "// abc\r\n//\r\nx = 1 // why\r\n"],
	["a surrogate pair in a comment and in a string", '// \u{1F600}\nx = "\u{1F600}"'],
];

/** A constant, as a double-quoted string writes it. */
export const CONSOLE_STRING_CASES: Cases = [
	["plain text is written as it is", "Desk lamp"],
	["a brace and a backslash are escaped", "a {b} c \\ d"],
	["a double quote is escaped, a single quote is not", "say \"hi\" and 'bye'"],
	["a line break, a tab and a return are written as escapes", "one\ntwo\tthree\rfour"],
	["a surrogate pair is kept whole", "\u{1F600} {x}"],
	["nothing at all", ""],
];
