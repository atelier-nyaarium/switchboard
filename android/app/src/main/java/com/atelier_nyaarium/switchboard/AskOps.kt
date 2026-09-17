package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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

/** The one reading of a send's outcome as this surface's word. */
internal fun askSentOf(submitted: Submitted, answers: Int): AskSent =
	when (submitted) {
		Submitted.Sent -> AskSent.Sent(answers)
		Submitted.Unknown -> AskSent.Unknown(answers)
		Submitted.Failed -> AskSent.Failed
		Submitted.AlreadySending -> AskSent.AlreadySending
	}

internal const val SCOPE_FRESH_MS = 60_000L

/**
 * The scope reads the Ask surfaces draw from, the sends they make, and the pairs each send leaves out.
 *
 * Keyed by SESSION, never by gateway: two sessions of one gateway hold different workspaces.
 */
internal class AskOps(
	private val host: WorkspaceHost,
	private val outbox: ComposedRequests,
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
		val admission = outbox.admit()
		val claim = preflight.withLock {
			val key = ScopeKey(subject.target, readTarget(subject, selection.scope), Include.LOCALS in selection.include)
			val fresh =
				scopes.of(key)?.read?.takeIf { now() - it.readAt < SCOPE_FRESH_MS && scopeState(it.answer) is ScopeState.Listed }
			val answer = when (val state = scopeState(fresh?.answer ?: readAgain(key))) {
				is ScopeState.Listed -> state.answer
				is ScopeState.NotRead -> return AskSent.NotRead(state.state)
			}
			val address = subject.target.address
			val outstanding = AskedLookup { id, question -> store.outstanding(AskedKey(address, answer.root, id, question)) }
			val decided = when (val claimed = askClaim(subject, selection, answer, reviewed, outstanding)) {
				is AskClaimed.Refused -> return claimed.sent
				is AskClaim -> claimed
			}
			// Recorded under this lock, or a second send picks the same pairs before either writes them.
			store.record(admission.incarnation, decided.address, decided.root, decided.scopeSubject, decided.pairs)
			decided
		}
		val submitted =
			outbox.submit(claim.key, claim.text, admission, RequestHold { store.withdraw(admission.incarnation) })
		return askSentOf(submitted, claim.answers)
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
		for (symbolId in store.settle(askObservation(target.address, answer))) onRecorded(target, symbolId)
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
