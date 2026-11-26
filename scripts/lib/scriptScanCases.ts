export const SCRIPT_SCAN_CASES: readonly (readonly [string, string])[] = [
	["a statement to a line", 'devices.set("Desk lamp", "on")\nexit'],
	[
		"an if with an else if and an else",
		'if (value > 1) {\n\twait(5)\n} else if (cold) {\n\texit\n} else {\n\tthrow "no"\n}',
	],
	["a try and its catch", 'try {\n\tifttt.trigger("go")\n} catch (e) {\n\tassistant.tell("now", "{e}")\n}'],
	["a comment line, a trailing comment, and slashes inside a string", '// first\nx = "a // b" // why\n'],
	[
		"a statement runs on while a bracket is open",
		'functions.run("Blink", {\n\tlamp: "Desk lamp",\n\tmessage: label,\n})\nexit',
	],
	["a comment inside an open bracket cuts the code in two", "f(a, // one\n b)\nexit"],
	["a record's brace is not a block's", "x = {a: 1}\nthrow {a: 1}"],
	["a reserved word opens a statement only as a whole word", "iffy = 1\nx = wait\nelsewhere()"],
	["an open string ends with its line", 'x = "abc\ny = 1'],
	["a quote escaped in a string, and a backslash before the line's end", 'x = "a\\"b"\ny = \'c\\\nz = 2'],
	["a stray close, and blank lines", "}\n\n\nexit\n"],
	["the later words are reserved too", "parallel {\n\tstart a()\n}\nawait all(a, b)\nany(c)"],
	["tabs, returns and no closing newline", "\tif(a){\r\n\t\texit\r\n\t}"],
	["a surrogate pair in a comment and in a string", '// \u{1F600}\nx = "\u{1F600}"'],
	["carriage returns end no comment and break no statement", "// abc\r\n//\r\nx = (1 +\r\n 2) // why\r\nexit\r\n"],
	["an unbalanced close bracket stays code", "a) + b]\nexit"],
];
