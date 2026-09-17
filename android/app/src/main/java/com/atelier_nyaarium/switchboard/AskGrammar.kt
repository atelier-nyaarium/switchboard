package com.atelier_nyaarium.switchboard

/** The Ask message's tree, rendered and parsed by one owner; the vector set pins both. */

internal data class AskNode(
	val name: String,
	val kind: String,
	val symbolId: String,
	val questions: List<String>,
	val children: List<AskNode> = emptyList(),
)

private const val INDENT = "  "

private const val BULLET = "- "

private const val NOTHING_HERE = "nothing to record here"

private const val BODY_END = ". "

private const val KIND_END = ": "

////////////////////////////////
//  Render

internal fun askTreeLines(nodes: List<AskNode>): List<String> = buildList { drawn(nodes, 0, this) }

private fun drawn(nodes: List<AskNode>, depth: Int, into: MutableList<String>) {
	for (node in nodes) {
		into += nodeLine(node, depth)
		drawn(node.children, depth + 1, into)
	}
}

private fun nodeLine(node: AskNode, depth: Int): String {
	val body = if (node.questions.isEmpty()) NOTHING_HERE else node.questions.joinToString(", ")
	return INDENT.repeat(depth) + BULLET + codeSpan(node.name) + " " + node.kind + KIND_END + body + BODY_END +
		codeSpan(node.symbolId)
}

/**
 * The shortest fence longer than any backtick run inside, which is CommonMark's inline rule. A block
 * fence never goes under three, so `fenceFor` is not it. The pad keeps a leading or trailing backtick
 * out of the fence.
 */
internal fun codeSpan(text: String): String {
	var longest = 0
	var run = 0
	for (character in text) {
		run = if (character == '`') run + 1 else 0
		if (run > longest) longest = run
	}
	val pad = if (text.startsWith("`") || text.endsWith("`")) " " else ""
	val fence = "`".repeat(longest + 1)
	return "$fence$pad$text$pad$fence"
}

////////////////////////////////
//  Parse

/** Every symbol id a rendered tree names, with the questions its line asks for. */
internal fun askTreePairs(text: String): List<Pair<String, List<String>>> =
	text.lineSequence().mapNotNull(::linePair).toList()

private data class Span(val text: String, val from: Int, val to: Int)

private fun linePair(line: String): Pair<String, List<String>>? {
	val trimmed = line.trim()
	if (!trimmed.startsWith(BULLET)) return null
	val after = trimmed.substring(BULLET.length)
	val name = openingSpan(after) ?: return null
	val id = closingSpan(after) ?: return null
	if (id.from < name.to) return null
	val questions = questionsIn(after.substring(name.to, id.from)) ?: return null
	return id.text to questions
}

/** The kind, then its questions. Only a question class names a pair, so the marker names none. */
private fun questionsIn(middle: String): List<String>? {
	if (!middle.startsWith(" ") || !middle.endsWith(BODY_END)) return null
	val kinded = middle.substring(1, middle.length - BODY_END.length)
	val colon = kinded.lastIndexOf(KIND_END)
	if (colon < 0) return null
	return kinded.substring(colon + KIND_END.length).split(", ")
		.filter { it in QUESTION_CLASSES }
		.takeIf { it.isNotEmpty() }
}

/** No run inside reaches the fence, so the first of that length closes it. */
private fun openingSpan(text: String): Span? {
	val fence = runFrom(text, 0)
	if (fence == 0) return null
	var at = fence
	while (at < text.length) {
		if (text[at] != '`') {
			at++
			continue
		}
		val run = runFrom(text, at)
		if (run == fence) return Span(unpadded(text.substring(fence, at)), 0, at + fence)
		at += run
	}
	return null
}

private fun closingSpan(text: String): Span? {
	if (text.isEmpty()) return null
	val fence = runBack(text, text.length - 1)
	if (fence == 0) return null
	var at = text.length - fence - 1
	while (at >= 0) {
		if (text[at] != '`') {
			at--
			continue
		}
		val run = runBack(text, at)
		if (run == fence) {
			return Span(unpadded(text.substring(at + 1, text.length - fence)), at - fence + 1, text.length)
		}
		at -= run
	}
	return null
}

private fun runFrom(text: String, at: Int): Int {
	var end = at
	while (end < text.length && text[end] == '`') end++
	return end - at
}

private fun runBack(text: String, at: Int): Int {
	var start = at
	while (start >= 0 && text[start] == '`') start--
	return at - start
}

/** Inverts the writer's pad, so plain edge spaces survive. */
private fun unpadded(content: String): String {
	if (content.length < 3 || !content.startsWith(" ") || !content.endsWith(" ")) return content
	val inner = content.substring(1, content.length - 1)
	return if (inner.startsWith("`") || inner.endsWith("`")) inner else content
}
