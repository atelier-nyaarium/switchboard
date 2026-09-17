package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceHistoryCommit
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeCounts
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer

/**
 * The canned drill-ins, and only the data half. Every decision is in `SandboxFacetRules`, where the
 * shared vector corpus reaches it.
 */

/** What an older plugin refuses with, which is what draws the update notice. */
internal const val SANDBOX_PLUGIN_UPDATE = "this session's plugin cannot read that workspace op; update it"

private const val ROLE_TYPE = "typeUse"

private const val ROLE_IMPLEMENTS = "implements"

private const val ROLE_EXTENDS = "extends"

private const val ROLE_CALL = "call"

private const val ROLE_READ = "read"

private const val STATUS_BOUND = "bound"

private const val STATUS_UNBOUND = "unbound"

private const val NOT_INDEXED = "NotIndexed"

private const val EXTERNAL = "ExternalDependency"

private const val OUTCOME_COMMITS = "commits"

private const val OUTCOME_UNTRACKED = "untracked"

private const val DAY_MS = 86_400_000L

private data class Ref(val module: String, val name: String)

/** A use as the sandbox declares it: where it sits, and who holds it. */
private data class Site(val module: String, val line: Long, val holder: String?, val role: String = ROLE_TYPE)

private data class TargetSpec(val name: String, val at: Ref?, val reason: String?, val uses: List<Site>)

private data class SandboxCommit(val hash: String, val subject: String, val daysAgo: Long, val added: Long, val removed: Long)

private data class Drill(
	val uses: List<Site> = emptyList(),
	val targets: List<TargetSpec> = emptyList(),
	val supertypes: List<Pair<Ref, String>> = emptyList(),
	val ancestors: List<Ref> = emptyList(),
	val unbound: List<Pair<String, String>> = emptyList(),
	val subtypes: List<Pair<Ref, String>> = emptyList(),
	val tooLargeUses: WorkspaceListing.TooLarge? = null,
	val tooLargeTargets: WorkspaceListing.TooLarge? = null,
	/** Only where a drill-in lists nothing to count. */
	val counts: WorkspaceKnowledgeCounts? = null,
)

////////////////////////////////
//  What each symbol answers

private fun sessionUses() = listOf(
	Site(HANDLERS_MODULE, 99, "start"),
	Site(HANDLERS_MODULE, 136, "message"),
	Site(HANDLERS_MODULE, 186, "stop"),
	Site(HANDLERS_MODULE, 223, "dispatchTurn"),
	Site(CHILD_MODULE, 16, "session"),
	Site(CHILD_MODULE, 17, "opening"),
	Site(CHILD_MODULE, 40, "open"),
	Site(CODEX_MODULE, 20, "CodexLocalSession", ROLE_IMPLEMENTS),
	Site(COPILOT_MODULE, 29, "CopilotLocalSession", ROLE_IMPLEMENTS),
	Site(PUBLICATION_MODULE, 19, "ValueBackendAdapter", ROLE_IMPLEMENTS),
	Site(HOST_MODULE, 132, "createLocalAgentBackend"),
	Site(RUNTIME_MODULE, 50, "openSession"),
	Site(HANDLERS_MODULE, 19, "open"),
	Site(UNLISTED_MODULE, 6, "VendoredSession", ROLE_IMPLEMENTS),
	Site(WITHHELD_MODULE, 4, "EnvBackedSession", ROLE_IMPLEMENTS),
)

private fun sessionTargets() = listOf(
	TargetSpec(
		"CodexServiceTier",
		Ref(IDENTITY_MODULE, "CodexServiceTier"),
		null,
		listOf(Site(SESSION_MODULE, 28, "openThread"), Site(SESSION_MODULE, 33, "startTurn")),
	),
	TargetSpec(
		"LocalTurnHandle",
		Ref(SESSION_MODULE, "LocalTurnHandle"),
		null,
		listOf(Site(SESSION_MODULE, 34, "startTurn")),
	),
	TargetSpec(
		"Promise",
		null,
		EXTERNAL,
		listOf(
			Site(SESSION_MODULE, 28, "openThread"),
			Site(SESSION_MODULE, 34, "startTurn"),
			Site(SESSION_MODULE, 36, "steerTurn"),
			Site(SESSION_MODULE, 37, "interruptTurn"),
		),
	),
)

private fun startTargets() = listOf(
	TargetSpec("LocalBackendSession", Ref(SESSION_MODULE, "LocalBackendSession"), null, listOf(Site(HANDLERS_MODULE, 99, "start"))),
	TargetSpec("openThread", Ref(SESSION_MODULE, "openThread"), null, listOf(Site(HANDLERS_MODULE, 109, "start", ROLE_CALL))),
	TargetSpec("dispatchTurn", Ref(HANDLERS_MODULE, "dispatchTurn"), null, listOf(Site(HANDLERS_MODULE, 121, "start", ROLE_CALL))),
	TargetSpec("LocalRequest", null, NOT_INDEXED, listOf(Site(HANDLERS_MODULE, 93, "start"))),
	TargetSpec("LocalAgentAnswer", null, NOT_INDEXED, listOf(Site(HANDLERS_MODULE, 93, "start"))),
	TargetSpec("agentIdForOperation", null, NOT_INDEXED, listOf(Site(HANDLERS_MODULE, 96, "start", ROLE_CALL))),
	TargetSpec(
		"errorText",
		null,
		NOT_INDEXED,
		listOf(Site(HANDLERS_MODULE, 103, "start", ROLE_CALL), Site(HANDLERS_MODULE, 115, "start", ROLE_CALL)),
	),
)

private fun reapUses() = listOf(
	Site(CHILD_MODULE, 43, "open", ROLE_READ),
	Site(RUNTIME_MODULE, 79, "reapIdle", ROLE_READ),
	Site(RUNTIME_MODULE, 8, null, ROLE_READ),
)

/** One long list, so a sticky header and a count over a thousand rows have somewhere to show. */
private fun hubUses(): List<Site> {
	var ordinal = 0
	return HUB_USER_INDICES.flatMap { index ->
		(0 until hubUseCount(index)).map { at ->
			val role = when (ordinal++ % 10) {
				in 0..6 -> ROLE_CALL
				7, 8 -> ROLE_READ
				else -> ROLE_TYPE
			}
			Site(hubUserPath(index), hubUseLine(at), hubHolderName(index, at), role)
		}
	}
}

private val HUB_REGISTRY_COUNTS = WorkspaceKnowledgeCounts(
	uses = 48_213,
	useFiles = 3_104,
	dependents = 9_812,
	dependentFiles = 214,
	targets = 100_000,
	boundTargets = 92_400,
	references = 210_004,
	members = 0,
	supertypes = 0,
	subtypes = 0,
	comments = 0,
)

private fun drillTable(): Map<Ref, Drill> = mapOf(
	Ref(SESSION_MODULE, "LocalBackendSession") to Drill(
		uses = sessionUses(),
		targets = sessionTargets(),
		subtypes = listOf(
			Ref(CODEX_MODULE, "CodexLocalSession") to ROLE_IMPLEMENTS,
			Ref(COPILOT_MODULE, "CopilotLocalSession") to ROLE_IMPLEMENTS,
			Ref(PUBLICATION_MODULE, "ValueBackendAdapter") to ROLE_IMPLEMENTS,
		),
	),
	Ref(HANDLERS_MODULE, "start") to Drill(
		uses = listOf(Site(HOST_MODULE, 140, "createLocalAgentBackend", ROLE_CALL)),
		targets = startTargets(),
	),
	Ref(CHILD_MODULE, "LOCAL_IDLE_REAP_MS") to Drill(uses = reapUses()),
	Ref(SEALING_MODULE, "ContentSealing") to Drill(
		supertypes = listOf(Ref(SEALING_MODULE, "Sealing") to ROLE_IMPLEMENTS),
		subtypes = listOf(
			Ref(VAULT_SEALING_MODULE, "VaultSealing") to ROLE_EXTENDS,
			Ref(BOARD_SEALING_MODULE, "BoardSealing") to ROLE_EXTENDS,
		),
	),
	// The one drill with an ancestor, so an indirect supertype has somewhere to draw.
	Ref(VAULT_SEALING_MODULE, "VaultSealing") to Drill(
		supertypes = listOf(Ref(SEALING_MODULE, "ContentSealing") to ROLE_EXTENDS),
		ancestors = listOf(Ref(SEALING_MODULE, "Sealing")),
	),
	Ref(MUTATE_MODULE, "SourceMoved") to Drill(unbound = listOf("Error" to ROLE_EXTENDS)),
	Ref(HUB_MODULE, "hubEvent") to Drill(uses = hubUses()),
	Ref(HUB_MODULE, "HubRegistry") to Drill(
		tooLargeUses = WorkspaceListing.TooLarge(48_213, 4_213_377),
		tooLargeTargets = WorkspaceListing.TooLarge(100_000, null),
		counts = HUB_REGISTRY_COUNTS,
	),
)

private fun commitTable(): Map<String, List<SandboxCommit>> = mapOf(
	SESSION_MODULE to listOf(
		SandboxCommit("4b54a28f9c", "Let a Codex agent run at the priority tier, and change tier between turns", 12, 31, 8),
		SandboxCommit("0ab0bd6e21", "Trim comments to short notes in src/mcp/local and src/mcp/channel", 28, 12, 14),
		SandboxCommit("a12909573d", "Serve Codex and Copilot agents locally when no daemon declares them", 35, 24, 2),
	),
	HANDLERS_MODULE to listOf(SandboxCommit("3f7a11b004", "Fold a refused thread into the agent's own answer", 9, 44, 19)),
	CHILD_MODULE to listOf(SandboxCommit("91c4de8802", "Reap an idle child once its session goes quiet", 9, 26, 5)),
)

private val DEFAULT_COMMITS = listOf(SandboxCommit("7c1d90a5f6", "Move the local backend behind one spec", 21, 18, 6))

////////////////////////////////
//  The answers

internal class SandboxFacets(private val modules: Map<String, SandboxModule>, private val now: () -> Long) {
	private data class Found(val module: SandboxModule, val symbol: SandboxSymbol)

	private val byId: Map<String, Found> =
		modules.values.flatMap { module -> module.symbols.map { it.symbolId to Found(module, it) } }.toMap()

	private val symbols = FacetSymbols { id -> byId[id]?.let { facetSymbol(it.module, it.symbol) } }

	private val drills: Map<String, Drill> =
		drillTable().mapNotNull { (ref, drill) -> idOf(ref)?.let { it to drill } }.toMap()

	private val commits: Map<String, List<SandboxCommit>> = commitTable()

	fun facet(symbolId: String, facet: WorkspaceFacet): WorkspaceAnswer<WorkspaceListing<WorkspaceSymbolFacetAnswer>> {
		val found = byId[symbolId] ?: return WorkspaceAnswer.Refused(SANDBOX_PLUGIN_UPDATE)
		val drill = drills[symbolId] ?: Drill()
		val listing = when (facet) {
			WorkspaceFacet.Uses -> drill.tooLargeUses ?: usesAnswer(symbolId, found, drill)
			WorkspaceFacet.UsesFrom -> drill.tooLargeTargets ?: targetsAnswer(symbolId, drill)
			WorkspaceFacet.Members -> listed(symbolId, membersAnswer(found))
			WorkspaceFacet.Hierarchy -> listed(symbolId, hierarchyAnswer(found, drill))
			WorkspaceFacet.Comments -> listed(symbolId, commentsAnswer(found))
			WorkspaceFacet.History -> listed(symbolId, historyAnswer(found))
		}
		return WorkspaceAnswer.Read(listing)
	}

	fun fileHistory(path: String): WorkspaceAnswer<WorkspaceListing<WorkspaceFileHistoryAnswer>> {
		val module = modules[path] ?: return WorkspaceAnswer.Refused(SANDBOX_PLUGIN_UPDATE)
		if (!module.tracked) {
			return WorkspaceAnswer.Read(
				WorkspaceListing.Listed(
					WorkspaceFileHistoryAnswer(
						path = path,
						outcome = OUTCOME_UNTRACKED,
						commits = emptyList(),
						count = 0,
						added = 0,
						removed = 0,
						truncated = false,
					),
				),
			)
		}
		val rows = commitsOf(module)
		return WorkspaceAnswer.Read(
			WorkspaceListing.Listed(
				WorkspaceFileHistoryAnswer(
					path = path,
					outcome = OUTCOME_COMMITS,
					commits = rows,
					count = rows.size.toLong(),
					added = rows.sumOf { it.added },
					removed = rows.sumOf { it.removed },
					firstSeen = rows.minOf { it.at },
					lastTouched = rows.maxOf { it.at },
					truncated = false,
				),
			),
		)
	}

	/** Null where no canned module holds the symbol, which leaves the older plugin's plain facts. */
	fun counts(symbolId: String): WorkspaceKnowledgeCounts? {
		val found = byId[symbolId] ?: return null
		val drill = drills[symbolId] ?: Drill()
		drill.counts?.let { return it }
		return sandboxCounts(
			uses = sandboxUsesAnswer(useSites(found, drill), symbols),
			targets = sandboxTargetsAnswer(targetSites(drill), symbols),
			members = sandboxMembers(memberIds(found), symbols),
			hierarchy = hierarchyAnswer(found, drill),
			comments = commentsAnswer(found),
		)
	}

	fun documentation(symbolId: String): String? {
		val found = byId[symbolId] ?: return null
		return sandboxDocumentation(symbolId, commentSites(found))
	}

	fun symbolOf(symbolId: String): Pair<SandboxModule, SandboxSymbol>? = byId[symbolId]?.let { it.module to it.symbol }

	private fun idOf(ref: Ref): String? = modules[ref.module]?.symbol(ref.name)?.symbolId

	private fun listed(symbolId: String, answer: WorkspaceFacetAnswer) =
		WorkspaceListing.Listed(WorkspaceSymbolFacetAnswer(symbolId = symbolId, facet = answer))

	private fun usesAnswer(symbolId: String, found: Found, drill: Drill): WorkspaceListing<WorkspaceSymbolFacetAnswer> =
		when (val answer = sandboxUsesAnswer(useSites(found, drill), symbols)) {
			is WorkspaceListing.Listed -> listed(symbolId, answer.value.copy(rows = dressed(answer.value.rows)))
			is WorkspaceListing.TooLarge -> answer
		}

	private fun targetsAnswer(symbolId: String, drill: Drill): WorkspaceListing<WorkspaceSymbolFacetAnswer> =
		when (val answer = sandboxTargetsAnswer(targetSites(drill), symbols)) {
			is WorkspaceListing.Listed ->
				listed(symbolId, answer.value.copy(targets = answer.value.targets.map { it.copy(uses = dressed(it.uses)) }))

			is WorkspaceListing.TooLarge -> answer
		}

	private fun membersAnswer(found: Found) =
		WorkspaceFacetAnswer.Members(members = sandboxMembers(memberIds(found), symbols), plain = 0)

	private fun hierarchyAnswer(found: Found, drill: Drill) = sandboxHierarchy(
		subject = facetSymbol(found.module, found.symbol),
		supertypes = drill.supertypes.mapNotNull { (ref, role) -> idOf(ref)?.let { FacetTypeSite(it, role) } },
		ancestorIds = drill.ancestors.mapNotNull { idOf(it) },
		unbound = drill.unbound.map { (name, role) -> FacetUnboundSite(name, role) },
		subtypes = drill.subtypes.mapNotNull { (ref, role) -> idOf(ref)?.let { FacetTypeSite(it, role) } },
		symbols = symbols,
	)

	private fun commentsAnswer(found: Found): WorkspaceFacetAnswer.Comments {
		val sites = commentSites(found)
		return sandboxComments(found.symbol.symbolId, sites, sites.size.toLong(), false, symbols)
	}

	private fun historyAnswer(found: Found) = WorkspaceFacetAnswer.History(
		outcome = if (found.module.tracked) OUTCOME_COMMITS else OUTCOME_UNTRACKED,
		module = found.module.path,
		startLine = found.symbol.startLine,
		endLine = found.symbol.endLine,
		commits = if (found.module.tracked) commitsOf(found.module) else emptyList(),
		truncated = false,
	)

	private fun useSites(found: Found, drill: Drill): List<FacetUseSite> =
		drill.uses.map { siteOf(it, found.symbol.name) }

	private fun targetSites(drill: Drill): List<FacetTargetSite> =
		drill.targets.flatMap { spec ->
			val bound = spec.at?.let { idOf(it) }
			spec.uses.map { site ->
				FacetTargetSite(
					use = siteOf(site, spec.name),
					name = spec.name,
					status = if (bound == null) STATUS_UNBOUND else STATUS_BOUND,
					targetId = bound,
					reason = spec.reason,
				)
			}
		}

	private fun memberIds(found: Found): List<String> = found.module.members(found.symbol).map { it.symbolId }

	/** A holder and its outermost container, each read on its own; the column is where the line names it. */
	private fun siteOf(site: Site, name: String): FacetUseSite {
		val module = modules[site.module]
		val holder = site.holder?.let { module?.symbol(it) }
		return FacetUseSite(
			module = site.module,
			line = site.line,
			name = name,
			role = site.role,
			holderId = holder?.symbolId,
			topLevelId = holder?.let { module?.topLevel(it)?.symbolId },
			column = (module?.lineAt(site.line)?.indexOf(name) ?: -1).coerceAtLeast(0).toLong(),
		)
	}

	/**
	 * Scanned from the line above, which is the scope the plugin reads. A comment leading the subject
	 * itself is its documentation, which the rules keep out of every row and count.
	 */
	private fun commentSites(found: Found): List<FacetCommentSite> =
		(found.symbol.startLine - 1..found.symbol.endLine).mapNotNull { line ->
			val raw = found.module.lineAt(line).trim()
			if (!isComment(raw)) return@mapNotNull null
			val next = found.module.startingAt(line + 1)
			FacetCommentSite(
				text = commentText(raw),
				form = if (next != null) "leading" else "standalone",
				line = line,
				anchorId = next?.symbolId,
				holderId = (next ?: found.module.holderAt(line))?.symbolId,
			)
		}

	/** The line a row points into, and its paint. */
	private fun dressed(rows: List<WorkspaceFacetUse>): List<WorkspaceFacetUse> = rows.map { row ->
		val module = modules[row.module] ?: return@map row
		val text = module.lineAt(row.line)
		row.copy(language = module.language, text = text, spans = sandboxSpans(module.language, text))
	}

	private fun facetSymbol(module: SandboxModule, symbol: SandboxSymbol) = WorkspaceFacetSymbol(
		symbolId = symbol.symbolId,
		name = symbol.name,
		symbolKind = symbol.kind,
		module = module.path,
		startLine = symbol.startLine,
		endLine = symbol.endLine,
		signature = symbol.signature,
		signatureSpans = symbol.signature?.let { listOf(sandboxSpans(module.language, it)) },
	)

	private fun commitsOf(module: SandboxModule): List<WorkspaceHistoryCommit> {
		val at = now()
		return (commits[module.path] ?: DEFAULT_COMMITS).map {
			WorkspaceHistoryCommit(
				hash = it.hash,
				at = (at - it.daysAgo * DAY_MS) / 1_000,
				author = "nyaarium",
				subject = it.subject,
				added = it.added,
				removed = it.removed,
			)
		}
	}
}

private fun isComment(trimmed: String): Boolean = trimmed.startsWith("//") || trimmed.startsWith("/*")

private fun commentText(trimmed: String): String =
	trimmed.removePrefix("//").removePrefix("/**").removePrefix("/*").removeSuffix("*/").trim()
