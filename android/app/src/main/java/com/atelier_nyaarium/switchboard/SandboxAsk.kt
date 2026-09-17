package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeQuestion
import com.atelier_nyaarium.switchboard.proto.WorkspaceScopeSymbol

/**
 * What a session's Lexicon answers about a scope, and what an Ask message sent to it records. A read
 * takes a few queued pairs first, so each foreground moves the progress a send left behind.
 */

/** A few per read, so progress arrives over several foregrounds rather than all at once. */
private const val SANDBOX_RECORDS_PER_READ = 6

/** Before any run of the app, so a seeded answer reads as one somebody else recorded. */
private const val SANDBOX_RECORDED_AT = 1_750_000_000_000.0

/** A container chain cannot be longer than the module it sits in. */
private const val MAX_CONTAINER_HOPS = 64

private data class ScopePair(val symbolId: String, val question: String)

private data class Answered(
	val createdAt: Double,
	val thin: Boolean = false,
	val stale: Boolean = false,
	val shaky: Boolean = false,
)

private data class ScopePlace(val module: SandboxModule, val roots: List<SandboxSymbol>, val members: Boolean)

/** Fences widen and pad around a backtick, as `codeSpan` writes them. */
private val TREE_LINE = Regex("\\s*- `+ ?(.+?) ?`+ \\S+: ([a-z, ]+)\\. `+ ?(lexicon .+?) ?`+\\s*")

/** The symbols and questions a message's tree names, so a send reads back as work to record. */
internal fun sandboxAskedPairs(text: String): List<Pair<String, List<String>>> =
	text.lineSequence().mapNotNull { line ->
		val match = TREE_LINE.matchEntire(line) ?: return@mapNotNull null
		val questions = match.groupValues[2].split(", ").filter { it in QUESTION_CLASSES }
		if (questions.isEmpty()) null else match.groupValues[3] to questions
	}.toList()

internal class SandboxScopes(private val modules: Map<String, SandboxModule>, private val now: () -> Long) {
	/** Reading drains the queue, so both run under one lock. */
	private val lock = Any()

	private val byId: Map<String, Pair<SandboxModule, SandboxSymbol>> =
		modules.values.flatMap { module -> (module.symbols + module.locals).map { it.symbolId to (module to it) } }.toMap()

	private val recorded = mutableMapOf<String, MutableMap<ScopePair, Answered>>()

	private val queued = mutableMapOf<String, MutableList<ScopePair>>()

	fun scope(
		address: String,
		target: WorkspaceKnowledgeScopeTarget,
		includeLocals: Boolean,
	): WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> {
		val place = placeOf(target) ?: return WorkspaceAnswer.Refused(SANDBOX_PLUGIN_UPDATE)
		synchronized(lock) {
			val held = drained(address)
			val rows = mutableListOf<WorkspaceScopeSymbol>()
			var excluded = 0L
			for (root in place.roots) excluded += visit(place.module, root, 0, place.members, includeLocals, held, rows)
			return WorkspaceAnswer.Read(
				WorkspaceListing.Listed(
					WorkspaceKnowledgeScopeAnswer(
						root = SANDBOX_ROOT,
						module = place.module.path,
						symbols = rows,
						localsExcluded = excluded,
					),
				),
			)
		}
	}

	/** Leaves first, as the message asks for, so a container's answers land after its members'. */
	fun onMessage(address: String, text: String) {
		val pairs = sandboxAskedPairs(text)
			.flatMap { (symbolId, questions) -> questions.map { ScopePair(symbolId, it) } }
			.sortedByDescending { hopsOf(it.symbolId) }
		if (pairs.isEmpty()) return
		synchronized(lock) { queued.getOrPut(address) { mutableListOf() } += pairs }
	}

	private fun drained(address: String): Map<ScopePair, Answered> {
		val held = recorded.getOrPut(address) { seeded() }
		val waiting = queued[address] ?: return held
		val at = now().toDouble()
		repeat(minOf(SANDBOX_RECORDS_PER_READ, waiting.size)) { held[waiting.removeAt(0)] = Answered(at) }
		return held
	}

	/** One symbol answers weak in each of its three ways, so the sheet's stale row is never empty. */
	private fun seeded(): MutableMap<ScopePair, Answered> {
		val handle = modules[SESSION_MODULE]?.symbol("LocalTurnHandle") ?: return mutableMapOf()
		return mutableMapOf(
			ScopePair(handle.symbolId, "describe") to Answered(SANDBOX_RECORDED_AT, thin = true),
			ScopePair(handle.symbolId, "why") to Answered(SANDBOX_RECORDED_AT, stale = true),
			ScopePair(handle.symbolId, "relate") to Answered(SANDBOX_RECORDED_AT, shaky = true),
		)
	}

	private fun placeOf(target: WorkspaceKnowledgeScopeTarget): ScopePlace? =
		when (target) {
			is WorkspaceKnowledgeScopeTarget.File ->
				modules[target.path]?.let { ScopePlace(it, it.symbols.filter { symbol -> symbol.containerId == null }, true) }
			is WorkspaceKnowledgeScopeTarget.Members ->
				byId[target.symbolId]?.let { (module, symbol) -> ScopePlace(module, listOf(symbol), true) }
			is WorkspaceKnowledgeScopeTarget.Symbol ->
				byId[target.symbolId]?.let { (module, symbol) -> ScopePlace(module, listOf(symbol), false) }
		}

	/** Post-order, as Lexicon walks it, answering how many locals it left out. */
	private fun visit(
		module: SandboxModule,
		symbol: SandboxSymbol,
		depth: Long,
		members: Boolean,
		includeLocals: Boolean,
		held: Map<ScopePair, Answered>,
		into: MutableList<WorkspaceScopeSymbol>,
	): Long {
		var excluded = 0L
		if (members) {
			for (child in childrenOf(module, symbol, includeLocals)) {
				excluded += visit(module, child, depth + 1, true, includeLocals, held, into)
			}
			if (!includeLocals) excluded += module.locals.count { it.containerId == symbol.symbolId }
		}
		into += rowOf(symbol, depth, held)
		return excluded
	}

	private fun childrenOf(module: SandboxModule, symbol: SandboxSymbol, includeLocals: Boolean): List<SandboxSymbol> {
		val declared = module.symbols.filter { it.containerId == symbol.symbolId }
		val locals = if (includeLocals) module.locals.filter { it.containerId == symbol.symbolId } else emptyList()
		return (declared + locals).sortedBy { it.startLine }
	}

	private fun rowOf(symbol: SandboxSymbol, depth: Long, held: Map<ScopePair, Answered>) = WorkspaceScopeSymbol(
		symbolId = symbol.symbolId,
		name = symbol.name,
		symbolKind = symbol.kind,
		depth = depth,
		startLine = symbol.startLine,
		containerId = symbol.containerId,
		questions = QUESTION_CLASSES.map { question ->
			val answered = held[ScopePair(symbol.symbolId, question)]
			WorkspaceScopeQuestion(
				question = question,
				createdAt = answered?.createdAt,
				thin = answered?.thin?.takeIf { it },
				stale = answered?.stale?.takeIf { it },
				shaky = answered?.shaky?.takeIf { it },
				askCount = 0,
			)
		},
	)

	private fun hopsOf(symbolId: String): Int {
		var at = byId[symbolId]?.second ?: return 0
		var hops = 0
		repeat(MAX_CONTAINER_HOPS) {
			at = byId[at.containerId ?: return hops]?.second ?: return hops
			hops++
		}
		return hops
	}
}
