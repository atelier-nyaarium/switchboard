package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** One `knowledgeScope` read. SYMBOL and MEMBERS share one, since both read the same Members target. */
internal data class ScopeKey(
	val target: WorkspaceTarget,
	val scope: WorkspaceKnowledgeScopeTarget,
	val includeLocals: Boolean,
)

internal data class ScopeRead(val answer: WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>>, val readAt: Long)

internal data class ScopeView(val read: ScopeRead? = null)

/** The answer a key's showing holds, or null while it is loading, refused or too large. */
internal fun listedScope(views: Map<ScopeKey, ScopeView>, key: ScopeKey): WorkspaceKnowledgeScopeAnswer? =
	(scopeState(views[key]?.read?.answer) as? ScopeState.Listed)?.answer

/** What a send did, never a bare Boolean: nothing to ask is not a failure to send. */
internal sealed interface AskSent {
	data class Sent(val answers: Int) : AskSent

	/** The send threw, so the pairs stay out rather than being dropped on a lost answer. */
	data class Unknown(val answers: Int) : AskSent

	data object AlreadySending : AskSent

	data object Failed : AskSent

	data class TooLarge(val bytes: Int) : AskSent

	data object RootChanged : AskSent

	/** The fresh read holds more than the sheet showed, so the owner sees the new counts first. */
	data object Changed : AskSent

	data object NothingToAsk : AskSent

	data class NotRead(val state: FacetState<Nothing>) : AskSent
}

internal const val SCOPE_FRESH_MS = 60_000L

/**
 * The scope reads the Ask surfaces draw from, the sends they make, and the pairs each send leaves out.
 *
 * Keyed by SESSION, never by gateway: two sessions of one gateway hold different workspaces.
 */
internal class AskOps(
	private val host: WorkspaceHost,
	private val outbox: SessionRequests,
	private val now: () -> Long,
	private val onRecorded: suspend (WorkspaceTarget, String) -> Unit = { _, _ -> },
) : ClearsOnReprovision {
	val store = AskedStore(now)

	private val scopes = PublishedViews<ScopeKey, ScopeView>(host.generation)

	/** Which scopes a screen is showing, so a sweep reads them by key rather than enumerating views. */
	private val shownLock = Any()

	private val shown = HashMap<ScopeKey, Int>()

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	val scopeViews: StateFlow<Map<ScopeKey, ScopeView>> = scopes.all

	val requestStates: StateFlow<Map<RequestKey, RequestState>> = outbox.states

	suspend fun keepScope(key: ScopeKey) {
		synchronized(shownLock) { shown[key] = (shown[key] ?: 0) + 1 }
		try {
			scopes.keep(key, ::ScopeView) { showing -> refreshScope(key, showing) }
		} finally {
			synchronized(shownLock) {
				val left = (shown[key] ?: 1) - 1
				if (left > 0) shown[key] = left else shown.remove(key)
			}
		}
	}

	/**
	 * A read under a minute old is what the sheet counted, so it goes as it is. Anything older is read
	 * again first, since the owner is about to commit a session to every answer in it.
	 */
	suspend fun send(subject: AskSubject, selection: AskSelection, shownAnswers: Int): AskSent {
		val key = ScopeKey(subject.target, readTarget(subject, selection.scope), Include.LOCALS in selection.include)
		val generation = host.generation.capture()
		val fresh = scopes.of(key)?.read?.takeIf { now() - it.readAt < SCOPE_FRESH_MS && scopeState(it.answer) is ScopeState.Listed }
		val answer = when (val state = scopeState(fresh?.answer ?: readAgain(key))) {
			is ScopeState.Listed -> state.answer
			is ScopeState.NotRead -> return AskSent.NotRead(state.state)
		}
		if (answer.root != selection.root) return AskSent.RootChanged
		val address = subject.target.address
		val outstanding = AskedLookup { id, question -> store.outstanding(AskedKey(address, answer.root, id, question)) }
		val picked = picks(scopeSymbols(answer, subject, selection.scope), selection, outstanding)
		val answers = picked.sumOf { it.questions.size }
		if (answers == 0) return AskSent.NothingToAsk
		if (answers > shownAnswers) return AskSent.Changed
		val text = askMessage(subject, selection.scope, answer, picked)
		overBudget(text)?.let { return AskSent.TooLarge(it) }
		// Written before the send, so a reply that beats the send's answer already finds its pairs.
		return withContext(NonCancellable) {
			val sent = store.record(address, answer.root, scopeSubject(subject, selection.scope), askedPairs(address, answer, picked))
			when (outbox.submit(requestKey(subject, answer.root, selection.scope), text, generation)) {
				Submitted.Sent -> AskSent.Sent(answers)
				Submitted.Unknown -> AskSent.Unknown(answers)
				Submitted.Failed -> AskSent.Failed.also { store.withdraw(sent) }
				Submitted.AlreadySending -> AskSent.AlreadySending.also { store.withdraw(sent) }
			}
		}
	}

	/** Progress is read back from Lexicon, so a scope on screen is re-read while any pair is out. */
	suspend fun onForeground() = sweeping.withLock {
		if (!store.anyOutstanding()) return@withLock
		for (key in synchronized(shownLock) { shown.keys.toList() }) {
			refreshScope(key, scopes.current(key) ?: continue)
		}
	}

	override suspend fun clearInMemory() {
		scopes.clear()
		store.clear()
	}

	/** Settles only what was drawn: a showing that ended took its answer with it. */
	private suspend fun refreshScope(key: ScopeKey, showing: PublishedViews.Showing<ScopeKey>) {
		val read = readScope(key)
		if (!scopes.update(showing) { it.copy(read = ScopeRead(read, now())) }) return
		val answer = (scopeState(read) as? ScopeState.Listed)?.answer ?: return
		for (symbolId in store.settle(key.target.address, answer)) onRecorded(key.target, symbolId)
	}

	private suspend fun readAgain(key: ScopeKey): WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> {
		val read = readScope(key)
		scopes.current(key)?.let { showing -> scopes.update(showing) { it.copy(read = ScopeRead(read, now())) } }
		return read
	}

	/** A throw is no answer. */
	private suspend fun readScope(key: ScopeKey): WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> {
		val gate = host.workspace ?: return WorkspaceAnswer.Unreachable
		return try {
			gate.knowledgeScope(key.target, key.scope, key.includeLocals)
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("Ask", "scope read failed: ${e.message}")
			WorkspaceAnswer.Unreachable
		}
	}
}
