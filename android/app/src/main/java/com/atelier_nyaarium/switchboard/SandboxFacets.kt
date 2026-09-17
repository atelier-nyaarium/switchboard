package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetComment
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetType
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUnboundType
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceHistoryCommit
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeCounts
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer

/**
 * The drill-ins the sandbox answers over its canned modules. Every count is taken from the rows the
 * drill-in lists, so a row that says seven and a screen that lists six cannot both be drawn.
 */

/** What an older plugin refuses with, which is what draws the update notice. */
internal const val SANDBOX_PLUGIN_UPDATE = "this session's plugin cannot read that workspace op; update it"

internal fun sandboxWithheld(module: String): Boolean =
	module.startsWith("node_modules/") || module == ".env" || module.startsWith(".env.")

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
	Site(WITHHELD_MODULE, 6, "VendoredSession", ROLE_IMPLEMENTS),
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

	private val drills: Map<String, Drill> =
		drillTable().mapNotNull { (ref, drill) -> idOf(ref)?.let { it to drill } }.toMap()

	private val commits: Map<String, List<SandboxCommit>> = commitTable()

	fun facet(symbolId: String, facet: WorkspaceFacet): WorkspaceAnswer<WorkspaceListing<WorkspaceSymbolFacetAnswer>> {
		val found = byId[symbolId] ?: return WorkspaceAnswer.Refused(SANDBOX_PLUGIN_UPDATE)
		val drill = drills[symbolId] ?: Drill()
		val listing = when (facet) {
			WorkspaceFacet.Uses -> drill.tooLargeUses ?: listed(symbolId, usesAnswer(found, drill))
			WorkspaceFacet.UsesFrom -> drill.tooLargeTargets ?: listed(symbolId, targetsAnswer(drill))
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
		val rows = useRows(found, drill)
		val targets = targetRows(drill)
		val hierarchy = hierarchyAnswer(found, drill)
		return WorkspaceKnowledgeCounts(
			uses = rows.size.toLong(),
			useFiles = rows.map { it.module }.distinct().size.toLong(),
			dependents = rows.mapNotNull { it.topLevel?.symbolId }.distinct().size.toLong(),
			dependentFiles = rows.filter { it.topLevel == null }.map { it.module }.distinct().size.toLong(),
			targets = targets.size.toLong(),
			boundTargets = targets.count { it.status == STATUS_BOUND && it.target != null }.toLong(),
			references = targets.sumOf { it.uses.size }.toLong(),
			members = found.module.members(found.symbol).size.toLong(),
			supertypes = hierarchy.supertypeCount,
			subtypes = hierarchy.subtypeCount,
			comments = commentRows(found).size.toLong(),
		)
	}

	/** The comment right above the declaration. */
	fun documentation(symbolId: String): String? {
		val found = byId[symbolId] ?: return null
		val above = found.module.lineAt(found.symbol.startLine - 1).trim()
		return if (isComment(above)) commentText(above) else null
	}

	fun symbolOf(symbolId: String): Pair<SandboxModule, SandboxSymbol>? = byId[symbolId]?.let { it.module to it.symbol }

	private fun idOf(ref: Ref): String? = modules[ref.module]?.symbol(ref.name)?.symbolId

	private fun listed(symbolId: String, answer: WorkspaceFacetAnswer) =
		WorkspaceListing.Listed(WorkspaceSymbolFacetAnswer(symbolId = symbolId, facet = answer))

	private fun usesAnswer(found: Found, drill: Drill): WorkspaceFacetAnswer.Uses {
		val rows = useRows(found, drill)
		return WorkspaceFacetAnswer.Uses(rows = rows, uses = rows.size.toLong(), plain = 0)
	}

	private fun targetsAnswer(drill: Drill): WorkspaceFacetAnswer.UsesFrom {
		val rows = targetRows(drill)
		return WorkspaceFacetAnswer.UsesFrom(
			targets = rows,
			targetCount = rows.size.toLong(),
			references = rows.sumOf { it.uses.size }.toLong(),
			plain = 0,
		)
	}

	private fun membersAnswer(found: Found) = WorkspaceFacetAnswer.Members(
		members = found.module.members(found.symbol).map { facetSymbol(found.module, it) },
		plain = 0,
	)

	private fun hierarchyAnswer(found: Found, drill: Drill): WorkspaceFacetAnswer.Hierarchy {
		val supertypes = drill.supertypes.mapNotNull { (ref, role) -> symbolAt(ref)?.let { WorkspaceFacetType(it, role) } }
		val ancestors = drill.ancestors.mapNotNull { symbolAt(it) }
		val unbound = drill.unbound.map { (name, role) -> WorkspaceFacetUnboundType(name, role) }
		val subtypes = drill.subtypes.mapNotNull { (ref, role) -> symbolAt(ref)?.let { WorkspaceFacetType(it, role) } }
		return WorkspaceFacetAnswer.Hierarchy(
			subject = facetSymbol(found.module, found.symbol),
			supertypes = supertypes,
			ancestors = ancestors,
			unbound = unbound,
			subtypes = subtypes,
			// The plugin counts ancestors too.
			supertypeCount = (supertypes.size + ancestors.size + unbound.size).toLong(),
			subtypeCount = subtypes.size.toLong(),
		)
	}

	private fun commentsAnswer(found: Found): WorkspaceFacetAnswer.Comments {
		val rows = commentRows(found)
		return WorkspaceFacetAnswer.Comments(comments = rows, total = rows.size.toLong(), truncated = false)
	}

	private fun historyAnswer(found: Found) = WorkspaceFacetAnswer.History(
		outcome = if (found.module.tracked) OUTCOME_COMMITS else OUTCOME_UNTRACKED,
		module = found.module.path,
		startLine = found.symbol.startLine,
		endLine = found.symbol.endLine,
		commits = if (found.module.tracked) commitsOf(found.module) else emptyList(),
		truncated = false,
	)

	private fun useRows(found: Found, drill: Drill): List<WorkspaceFacetUse> =
		drill.uses.mapNotNull { useOf(it, found.symbol.name) }

	private fun targetRows(drill: Drill): List<WorkspaceFacetTarget> =
		drill.targets.mapNotNull { spec ->
			val uses = spec.uses.mapNotNull { useOf(it, spec.name) }
			if (uses.isEmpty()) return@mapNotNull null
			val bound = spec.at?.let { symbolAt(it) }
			WorkspaceFacetTarget(
				name = spec.name,
				status = if (bound == null) STATUS_UNBOUND else STATUS_BOUND,
				target = bound,
				reason = spec.reason,
				uses = uses,
			)
		}

	/** Withheld before any row is built, so nothing counts what nothing lists. */
	private fun useOf(site: Site, name: String): WorkspaceFacetUse? {
		if (sandboxWithheld(site.module)) return null
		val module = modules[site.module] ?: return null
		val text = module.lineAt(site.line)
		val at = text.indexOf(name).coerceAtLeast(0)
		val holder = site.holder?.let { module.symbol(it) }
		return WorkspaceFacetUse(
			module = site.module,
			line = site.line,
			startColumn = at.toLong(),
			endColumn = (at + name.length).toLong(),
			name = name,
			role = site.role,
			holder = holder?.let { facetSymbol(module, it) },
			topLevel = holder?.let { facetSymbol(module, module.topLevel(it)) },
			language = module.language,
			text = text,
			spans = sandboxSpans(module.language, text),
		)
	}

	/**
	 * Scanned from the line above, which is the scope the plugin reads. A comment leading the subject
	 * itself is documentation, which the detail draws under its own heading, so no row and no count.
	 */
	private fun commentRows(found: Found): List<WorkspaceFacetComment> =
		(found.symbol.startLine - 1..found.symbol.endLine).mapNotNull { line ->
			val raw = found.module.lineAt(line).trim()
			if (!isComment(raw)) return@mapNotNull null
			val next = found.module.startingAt(line + 1)
			if (next?.symbolId == found.symbol.symbolId) return@mapNotNull null
			WorkspaceFacetComment(
				text = commentText(raw),
				form = if (next != null) "leading" else "standalone",
				line = line,
				holder = (next ?: found.module.holderAt(line))?.let { facetSymbol(found.module, it) },
			)
		}

	private fun symbolAt(ref: Ref): WorkspaceFacetSymbol? =
		modules[ref.module]?.let { module -> module.symbol(ref.name)?.let { facetSymbol(module, it) } }

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
