package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetComment
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetType
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUnboundType
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeCounts

/**
 * Every drill-in decision the sandbox answers by, apart from the canned data it runs over.
 * `tests/fixtures/workspace-facets/vectors.json` drives these and the plugin's own builders over one
 * input, so a rule cannot hold on one side and not the other.
 */

/** Lexicon's comment page cap, the plugin's bound too. */
internal const val SANDBOX_COMMENT_PAGE = 200

private const val FORM_LEADING = "leading"

private const val STATUS_BOUND = "bound"

private const val STATUS_UNBOUND = "unbound"

////////////////////////////////
//  What a rule reads

/** A use before any row is built. */
internal data class FacetUseSite(
	val module: String,
	val line: Long,
	val name: String,
	val role: String,
	/** Innermost declaration. */
	val holderId: String? = null,
	/** Outermost declaration, read apart from the holder. */
	val topLevelId: String? = null,
	val column: Long,
)

/** One use and what it points at, ungrouped as the index answers it. */
internal data class FacetTargetSite(
	val use: FacetUseSite,
	val name: String,
	val status: String,
	val targetId: String? = null,
	val reason: String? = null,
)

internal data class FacetCommentSite(
	val text: String,
	val form: String,
	val line: Long,
	/** The declaration the comment leads or sits in. */
	val anchorId: String? = null,
	/** Nearest non-local declaration. */
	val holderId: String? = null,
)

internal data class FacetTypeSite(val symbolId: String, val role: String? = null)

/** A supertype nothing bound, which is a spelling rather than a declaration. */
internal data class FacetUnboundSite(val name: String, val role: String? = null)

/** Where a rule looks a declaration up. */
internal fun interface FacetSymbols {
	fun at(symbolId: String): WorkspaceFacetSymbol?
}

////////////////////////////////
//  Serving

/** The module a symbol id names. */
internal fun sandboxModuleOf(symbolId: String): String? = symbolId.split(' ').getOrNull(2)

/** Served only where its own module and its id both name one; a served row can still name a withheld symbol. */
internal fun sandboxShown(symbols: FacetSymbols, symbolId: String?): WorkspaceFacetSymbol? {
	val id = symbolId ?: return null
	val named = sandboxModuleOf(id) ?: return null
	if (workspaceWithheldPath(named)) return null
	val symbol = symbols.at(id) ?: return null
	return if (workspaceWithheldPath(symbol.module)) null else symbol
}

////////////////////////////////
//  The index's order and its page

/** The index answers by module, then line, then character. */
private val BY_SOURCE = compareBy<FacetUseSite>({ it.module }, { it.line }, { it.column })

private data class Page<T>(val rows: List<T>, val truncated: Boolean)

private fun <T> pageOf(sites: List<T>, page: Int?, order: Comparator<T>): Page<T> {
	val sorted = sites.sortedWith(order)
	val cap = page ?: sorted.size
	return Page(sorted.take(cap), sorted.size > cap)
}

/** Rows without a size: nothing was read, so nothing was measured. */
private fun tooLargePage(served: Int) = WorkspaceListing.TooLarge(served.toLong(), null)

////////////////////////////////
//  Rows

/** The line's own text and its paint are dressed on afterwards, from the file. */
private fun useRowOf(site: FacetUseSite, symbols: FacetSymbols) = WorkspaceFacetUse(
	module = site.module,
	line = site.line,
	startColumn = site.column,
	endColumn = site.column + site.name.length,
	name = site.name,
	role = site.role,
	holder = sandboxShown(symbols, site.holderId),
	topLevel = sandboxShown(symbols, site.topLevelId),
)

/** Withheld before any row is built, so nothing counts what nothing lists. */
internal fun sandboxUseRows(sites: List<FacetUseSite>, symbols: FacetSymbols): List<WorkspaceFacetUse> =
	sites.filterNot { workspaceWithheldPath(it.module) }.map { useRowOf(it, symbols) }

/** Every row is painted in place here, so none is ever left plain. */
internal fun sandboxUsesAnswer(
	sites: List<FacetUseSite>,
	symbols: FacetSymbols,
	page: Int? = null,
): WorkspaceListing<WorkspaceFacetAnswer.Uses> {
	val held = pageOf(sites, page, BY_SOURCE)
	if (held.truncated) return tooLargePage(held.rows.count { !workspaceWithheldPath(it.module) })
	val rows = sandboxUseRows(held.rows, symbols)
	return WorkspaceListing.Listed(WorkspaceFacetAnswer.Uses(rows = rows, uses = rows.size.toLong(), plain = 0))
}

/** Unresolved names key by spelling, bound ones by target. */
private fun targetKeyOf(name: String, status: String, target: WorkspaceFacetSymbol?): String =
	if (status == STATUS_BOUND && target != null) "bound ${target.symbolId}" else "$status $name"

/** A withheld target leaves the use unresolved under its written name, never dropped. */
internal fun sandboxTargetRows(sites: List<FacetTargetSite>, symbols: FacetSymbols): List<WorkspaceFacetTarget> {
	val groups = LinkedHashMap<String, WorkspaceFacetTarget>()
	for (site in sites.filterNot { workspaceWithheldPath(it.use.module) }) {
		val bound = sandboxShown(symbols, site.targetId)
		val resolved = site.status == STATUS_BOUND && bound != null
		val name = if (resolved) bound.name else site.name
		val status = if (resolved) STATUS_BOUND else if (site.status == STATUS_BOUND) STATUS_UNBOUND else site.status
		val key = targetKeyOf(name, status, if (resolved) bound else null)
		val group = groups.getOrPut(key) {
			WorkspaceFacetTarget(
				name = name,
				status = status,
				target = if (resolved) bound else null,
				reason = site.reason,
				uses = emptyList(),
			)
		}
		groups[key] = group.copy(uses = group.uses + useRowOf(site.use, symbols))
	}
	return groups.values.toList()
}

internal fun sandboxTargetsAnswer(
	sites: List<FacetTargetSite>,
	symbols: FacetSymbols,
	page: Int? = null,
): WorkspaceListing<WorkspaceFacetAnswer.UsesFrom> {
	val held = pageOf(sites, page, compareBy(BY_SOURCE) { it.use })
	if (held.truncated) return tooLargePage(held.rows.count { !workspaceWithheldPath(it.use.module) })
	val rows = sandboxTargetRows(held.rows, symbols)
	return WorkspaceListing.Listed(
		WorkspaceFacetAnswer.UsesFrom(
			targets = rows,
			targetCount = rows.size.toLong(),
			references = rows.sumOf { it.uses.size }.toLong(),
			plain = 0,
		),
	)
}

internal fun sandboxMembers(memberIds: List<String>, symbols: FacetSymbols): List<WorkspaceFacetSymbol> =
	memberIds.mapNotNull { sandboxShown(symbols, it) }

/** Ancestors exclude direct supertypes; an unbound name is named once. */
internal fun sandboxHierarchy(
	subject: WorkspaceFacetSymbol,
	supertypes: List<FacetTypeSite>,
	ancestorIds: List<String>,
	unbound: List<FacetUnboundSite>,
	subtypes: List<FacetTypeSite>,
	symbols: FacetSymbols,
): WorkspaceFacetAnswer.Hierarchy {
	val typed = { sites: List<FacetTypeSite> ->
		sites.mapNotNull { site -> sandboxShown(symbols, site.symbolId)?.let { WorkspaceFacetType(it, site.role) } }
	}
	val direct = typed(supertypes)
	val directIds = direct.map { it.symbol.symbolId }.toSet()
	val ancestors = ancestorIds.filterNot { it in directIds }.mapNotNull { sandboxShown(symbols, it) }
	val named = LinkedHashMap<String, String?>()
	for (site in unbound) named.getOrPut(site.name) { site.role }
	val below = typed(subtypes)
	return WorkspaceFacetAnswer.Hierarchy(
		subject = subject,
		supertypes = direct,
		ancestors = ancestors,
		unbound = named.map { (name, role) -> WorkspaceFacetUnboundType(name, role) },
		subtypes = below,
		supertypeCount = (direct.size + ancestors.size + named.size).toLong(),
		subtypeCount = below.size.toLong(),
	)
}

////////////////////////////////
//  Comments

private fun ownComment(subjectId: String, site: FacetCommentSite): Boolean =
	site.anchorId == subjectId && site.form == FORM_LEADING

/** A symbol's own leading comment, which the detail draws under its own heading. */
internal fun sandboxDocumentation(subjectId: String, sites: List<FacetCommentSite>): String? =
	sites.firstOrNull { ownComment(subjectId, it) }?.text

/** Its own documentation is in no row and in no count; the page is this side's bound, not the index's promise. */
internal fun sandboxComments(
	subjectId: String,
	sites: List<FacetCommentSite>,
	total: Long,
	sourceTruncated: Boolean,
	symbols: FacetSymbols,
): WorkspaceFacetAnswer.Comments {
	val page = sites.take(SANDBOX_COMMENT_PAGE)
	val listed = page.filterNot { ownComment(subjectId, it) }
	val counted = total - (page.size - listed.size)
	return WorkspaceFacetAnswer.Comments(
		comments = listed.map { site ->
			WorkspaceFacetComment(
				text = site.text,
				form = site.form,
				line = site.line,
				holder = sandboxShown(symbols, site.holderId),
			)
		},
		total = maxOf(counted, listed.size.toLong()),
		truncated = sourceTruncated || sites.size > SANDBOX_COMMENT_PAGE,
	)
}

////////////////////////////////
//  Counts

/** Every count comes off the rows its drill-in listed, so a row dropped is a row counted nowhere. */
internal fun sandboxCounts(
	uses: WorkspaceListing<WorkspaceFacetAnswer.Uses>,
	targets: WorkspaceListing<WorkspaceFacetAnswer.UsesFrom>,
	members: List<WorkspaceFacetSymbol>,
	hierarchy: WorkspaceFacetAnswer.Hierarchy,
	comments: WorkspaceFacetAnswer.Comments,
): WorkspaceKnowledgeCounts? {
	val useRows: List<WorkspaceFacetUse> = (uses as? WorkspaceListing.Listed)?.value?.rows ?: return null
	val targetRows: List<WorkspaceFacetTarget> = (targets as? WorkspaceListing.Listed)?.value?.targets ?: return null
	return WorkspaceKnowledgeCounts(
		uses = useRows.size.toLong(),
		useFiles = useRows.map { it.module }.distinct().size.toLong(),
		dependents = useRows.mapNotNull { it.topLevel?.symbolId }.distinct().size.toLong(),
		dependentFiles = useRows.filter { it.topLevel == null }.map { it.module }.distinct().size.toLong(),
		targets = targetRows.size.toLong(),
		boundTargets = targetRows.mapNotNull { it.target?.symbolId }.distinct().size.toLong(),
		references = targetRows.sumOf { it.uses.size }.toLong(),
		members = members.size.toLong(),
		supertypes = hierarchy.supertypeCount,
		subtypes = hierarchy.subtypeCount,
		comments = comments.total,
	)
}
