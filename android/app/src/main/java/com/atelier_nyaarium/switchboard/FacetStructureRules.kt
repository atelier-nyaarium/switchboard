package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import java.util.Locale

/** A declaration's members, its place among types, and the comments inside it. */

////////////////////////////////
//  Members

internal fun memberChips(members: List<WorkspaceFacetSymbol>): List<OutlineKind> =
	kindChips(members.map { it.symbolKind }).takeIf { it.size > 2 } ?: emptyList()

/** A null kind is every member, as the outline's own chips read. */
internal fun membersOfKind(members: List<WorkspaceFacetSymbol>, kind: String?): List<WorkspaceFacetSymbol> =
	if (kind == null) members else members.filter { it.symbolKind == kind }

internal fun membersSubtitle(members: List<WorkspaceFacetSymbol>): String {
	val kinds = members.map { it.symbolKind }.distinct()
	val noun = if (kinds.size == 1) kindNoun(kinds.single(), members.size) else plural(members.size, "member")
	return "${countText(members.size)} $noun, in source order"
}

internal fun kindNoun(kind: String, count: Int): String =
	when (kind) {
		"property" -> if (count == 1) "property" else "properties"
		"class" -> if (count == 1) "class" else "classes"
		"method", "function", "field", "constructor", "interface", "enum", "struct", "constant", "variable" ->
			plural(count, kind)
		else -> plural(count, "member")
	}

////////////////////////////////
//  Hierarchy

internal sealed interface TypeNode {
	val key: String

	data class Known(
		override val key: String,
		val symbolId: String,
		val module: String,
		val name: String,
		val kind: String?,
		val startLine: Long?,
		val tag: String?,
		val self: Boolean = false,
		val opens: Boolean = true,
	) : TypeNode

	data class Unbound(override val key: String, val name: String, val tag: String?) : TypeNode
}

internal data class HierarchyColumn(val above: List<TypeNode>, val self: TypeNode.Known, val below: List<TypeNode>)

/** Farthest ancestor first, down to the symbol, then what descends from it. */
internal fun hierarchyColumn(answer: WorkspaceFacetAnswer.Hierarchy): HierarchyColumn {
	val subject = answer.subject
	return HierarchyColumn(
		above = answer.ancestors.reversed().map { knownNode("a:", it, it.symbolKind) } +
			answer.supertypes.map { knownNode("s:", it.symbol, it.role ?: it.symbol.symbolKind) } +
			answer.unbound.map { TypeNode.Unbound("x:${it.name}", it.name, it.role) },
		self = TypeNode.Known(
			key = "self",
			symbolId = subject.symbolId,
			module = subject.module,
			name = subject.name,
			kind = subject.symbolKind,
			startLine = subject.startLine,
			tag = subject.symbolKind,
			self = true,
			opens = false,
		),
		below = answer.subtypes.map { knownNode("b:", it.symbol, it.role ?: it.symbol.symbolKind) },
	)
}

private fun knownNode(prefix: String, symbol: WorkspaceFacetSymbol, tag: String?) =
	TypeNode.Known(
		key = prefix + symbol.symbolId,
		symbolId = symbol.symbolId,
		module = symbol.module,
		name = symbol.name,
		kind = symbol.symbolKind,
		startLine = symbol.startLine,
		tag = tag,
	)

////////////////////////////////
//  Comments

internal data class TextPart(val text: String, val code: Boolean)

internal data class CommentItem(
	val key: String,
	val form: String,
	val holder: String?,
	val line: Long,
	val parts: List<TextPart>,
	val opens: DetailOpen?,
)

internal fun commentItems(answer: WorkspaceFacetAnswer.Comments): List<CommentItem> =
	answer.comments.sortedBy { it.line }.mapIndexed { index, comment ->
		val form = comment.form.uppercase(Locale.ROOT)
		CommentItem(
			key = "c:${comment.line}:$index",
			form = form,
			holder = comment.holder?.name,
			line = comment.line,
			parts = textParts(comment.text),
			opens = comment.holder?.let {
				DetailOpen(it.symbolId, it.module, it.name, Reached("Comment", form, comment.line))
			},
		)
	}

/** Backticks pair; an unmatched one stays text. */
internal fun textParts(text: String): List<TextPart> {
	val parts = mutableListOf<TextPart>()
	var at = 0
	while (at < text.length) {
		val open = text.indexOf('`', at)
		if (open < 0) break
		val close = text.indexOf('`', open + 1)
		if (close < 0) break
		if (open > at) parts.add(TextPart(text.substring(at, open), false))
		if (close > open + 1) parts.add(TextPart(text.substring(open + 1, close), true))
		at = close + 1
	}
	if (at < text.length) parts.add(TextPart(text.substring(at), false))
	return parts
}

internal fun commentsSubtitle(answer: WorkspaceFacetAnswer.Comments): String =
	if (answer.truncated == true) {
		"first ${countText(answer.comments.size)} inside it"
	} else {
		"${countText(answer.total)} inside it"
	}
