package com.atelier_nyaarium.switchboard.vault

import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.Line
import com.atelier_nyaarium.switchboard.OwnerPrompt
import com.atelier_nyaarium.switchboard.passes

internal const val VAULT_PRESENCE_TITLE = "Approve request"
internal const val VAULT_PRESENCE_SUBTITLE = "Confirm it's you."

/** What the gate answered. */
internal sealed interface Presence {
	/** A prompt passed just now. */
	data class Asked(val receipt: PresenceReceipt) : Presence

	/** Nothing was asked. */
	data object NotOwed : Presence

	data object CouldNotAsk : Presence

	data object Refused : Presence
}

/** A passed prompt; only the gate mints one. */
internal interface PresenceReceipt

/** `carries`: "Every approval", lock on and passed, when asked. */
private class Minted(val lockEpoch: Int, val carries: Boolean, val at: Long) : PresenceReceipt {
	var spent = false
}

/** A presence answer as a request card reads it. */
internal sealed interface CardPresence {
	data object Passed : CardPresence

	data object Declined : CardPresence

	/** The phone could not ask. */
	data class Fault(val line: String) : CardPresence
}

internal fun cardPresence(answer: Presence): CardPresence = when (answer) {
	is Presence.Asked, Presence.NotOwed -> CardPresence.Passed
	Presence.Refused -> CardPresence.Declined
	Presence.CouldNotAsk -> CardPresence.Fault(Line.PRESENCE_FAULT.text)
}

/** The one owner-presence gate for vault approvals, reveals, and the setting that picks the policy. */
internal class ApprovalGate(
	private val policy: () -> String,
	private val persist: (String) -> Unit,
	private val authenticate: suspend (FragmentActivity?, String, String) -> OwnerPrompt,
	/** The app lock; off means the vault is already reachable. */
	private val lockOn: () -> Boolean,
	private val unlocked: () -> Boolean,
	/** Moves at every relock. */
	private val lockEpoch: () -> Int,
	/** Monotonic; ages the window and the carry. */
	private val elapsed: () -> Long,
) {
	private val lock = Any()

	/** Null until a prompt passes. */
	private var unlockedAt: Long? = null

	/** One matched approval's presence. */
	private var match: MatchPresenceProof? = null

	fun policy(): String = policy.invoke()

	/** Whether `require` would prompt. */
	fun owed(): Boolean {
		if (!lockOn()) return false
		return when (policy()) {
			VAULT_UNLOCK_EVERY -> true
			VAULT_UNLOCK_WINDOW -> synchronized(lock) { unlockedAt }?.let { elapsed() - it > VAULT_UNLOCK_WINDOW_MS } ?: true
			else -> false
		}
	}

	/** The answer when no prompt is owed; null when one is. */
	fun notOwed(): Presence.NotOwed? = Presence.NotOwed.takeUnless { owed() }

	/** Prompts when owed. */
	suspend fun require(activity: FragmentActivity?): Presence {
		notOwed()?.let { return it }
		// Read before the prompt.
		val epoch = lockEpoch()
		val carries = carries()
		return when (authenticate(activity, VAULT_PRESENCE_TITLE, VAULT_PRESENCE_SUBTITLE)) {
			OwnerPrompt.PASSED -> {
				val at = elapsed()
				synchronized(lock) { unlockedAt = at }
				Presence.Asked(Minted(epoch, carries, at))
			}
			OwnerPrompt.NO_SCREEN_LOCK -> Presence.NotOwed
			OwnerPrompt.REFUSED -> Presence.Refused
			OwnerPrompt.COULD_NOT_ASK -> Presence.CouldNotAsk
		}
	}

	/** "Every approval", lock on and passed. */
	private fun carries(): Boolean = lockOn() && unlocked() && policy() == VAULT_UNLOCK_EVERY

	/** Carries a receipt to one approval of that entry, once; its minute runs from the prompt. */
	fun grantMatch(receipt: PresenceReceipt, requestId: String, entryId: String, revision: Long) {
		val minted = receipt as? Minted ?: return
		synchronized(lock) {
			val fresh = !minted.spent && minted.carries && minted.lockEpoch == lockEpoch() && carries()
			minted.spent = true
			match = if (fresh) MatchPresenceProof(requestId, entryId, revision, minted.lockEpoch, minted.at) else null
		}
	}

	/** Any read spends it. `revision` is the held entry's; null when it is gone. */
	fun spendMatch(requestId: String, entryId: String, revision: Long?): Boolean = synchronized(lock) {
		val decision = consumeMatchPresenceProof(
			match,
			requestId,
			entryId,
			revision,
			lockEpoch(),
			elapsed(),
			appLockEngaged = lockOn() && !unlocked(),
		)
		match = decision.remaining
		decision.reuse && carries()
	}

	fun dropMatch() {
		synchronized(lock) { match = null }
	}

	/** Another owner starts with nothing. */
	fun forget() {
		synchronized(lock) {
			unlockedAt = null
			match = null
		}
	}

	/** Tightening is free; loosening asks the owner; any change ends the window and the carry. */
	suspend fun changePolicy(value: String, activity: FragmentActivity?): OwnerPrompt {
		val current = policy()
		if (value == current) return OwnerPrompt.PASSED
		if (strength(value) < strength(current)) {
			val answer = authenticate(activity, VAULT_PRESENCE_TITLE, VAULT_PRESENCE_SUBTITLE)
			if (!passes(answer)) return answer
		}
		persist(value)
		forget()
		return OwnerPrompt.PASSED
	}

	private fun strength(value: String): Int = when (value) {
		VAULT_UNLOCK_EVERY -> 2
		VAULT_UNLOCK_WINDOW -> 1
		else -> 0
	}
}
