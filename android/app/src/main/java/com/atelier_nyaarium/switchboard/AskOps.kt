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

	/** The fresh read picks another set than the sheet showed, so the owner sees it first. */
	data object Changed : AskSent

	data object NothingToAsk : AskSent

	data class NotRead(val state: FacetState<Nothing>) : AskSent
}

internal const val SCOPE_FRESH_MS = 60_000L

/** What one preflight claimed, which the send then submits. */
private data class Claimed(val send: AskSend, val answers: Int, val root: String, val text: String)

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

	/** One sweep at a time, or an older sweep's answer lands after a newer one's. */
	private val sweeping = Mutex()

	/** One preflight at a time, or two sends pick the same pairs before either records them. */
	private val preflight = Mutex()

	val scopeViews: StateFlow<Map<ScopeKey, ScopeView>> = scopes.all

	val requestStates: StateFlow<Map<RequestKey, RequestState>> = outbox.states

	suspend fun keepScope(key: ScopeKey) = scopes.keep(key, ::ScopeView) { ticket -> landScope(ticket, readScope(key)) }

	/**
	 * A read under a minute old is what the sheet counted, so it goes as it is. Anything older is read
	 * again first, since the owner is about to commit a session to every answer in it.
	 */
	suspend fun send(subject: AskSubject, selection: AskSelection, reviewed: Set<AskedKey>): AskSent {
		val generation = host.generation.capture()
		val claimed = preflight.withLock {
			val key = ScopeKey(subject.target, readTarget(subject, selection.scope), Include.LOCALS in selection.include)
			val fresh =
				scopes.of(key)?.read?.takeIf { now() - it.readAt < SCOPE_FRESH_MS && scopeState(it.answer) is ScopeState.Listed }
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
			val pairs = askedPairs(address, answer, picked)
			if (reviewChanged(reviewed, pairs.keys)) return AskSent.Changed
			val text = askMessage(subject, selection.scope, answer, picked)
			overBudget(text)?.let { return AskSent.TooLarge(it) }
			// Written before the send, so a reply that beats the send's answer already finds its pairs.
			val sent = store.record(address, answer.root, scopeSubject(subject, selection.scope), pairs)
			Claimed(sent, answers, answer.root, text)
		}
		return withContext(NonCancellable) {
			when (outbox.submit(requestKey(subject, claimed.root, selection.scope), claimed.text, generation)) {
				Submitted.Sent -> AskSent.Sent(claimed.answers)
				Submitted.Unknown -> AskSent.Unknown(claimed.answers)
				Submitted.Failed -> AskSent.Failed.also { store.withdraw(claimed.send) }
				Submitted.AlreadySending -> AskSent.AlreadySending.also { store.withdraw(claimed.send) }
			}
		}
	}

	/** Progress is read back from Lexicon, so a scope on screen is re-read while any pair is out. */
	suspend fun onForeground() = sweeping.withLock {
		if (!store.anyOutstanding()) return@withLock
		for (key in scopes.kept()) {
			val ticket = scopes.begin(key) ?: continue
			landScope(ticket, readScope(key))
		}
	}

	override suspend fun clearInMemory() {
		scopes.clear()
		store.clear()
	}

	/** The ticket is taken before the read, so a newer one never takes an older read's answer. */
	private suspend fun readAgain(key: ScopeKey): WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>> {
		val ticket = scopes.begin(key)
		val read = readScope(key)
		if (ticket != null) landScope(ticket, read)
		return read
	}

	/** A read the ticket no longer covers lands nothing and settles nothing. */
	private suspend fun landScope(
		ticket: PublishedViews.ReadTicket<ScopeKey>,
		read: WorkspaceAnswer<WorkspaceListing<WorkspaceKnowledgeScopeAnswer>>,
	) {
		if (!scopes.update(ticket) { it.copy(read = ScopeRead(read, now())) }) return
		val answer = (scopeState(read) as? ScopeState.Listed)?.answer ?: return
		val target = ticket.key.target
		for (symbolId in store.settle(target.address, answer)) onRecorded(target, symbolId)
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
