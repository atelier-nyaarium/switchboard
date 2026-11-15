package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.atomic.AtomicLong
import kotlin.reflect.KProperty
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet

/** A record edited on one Gateway; a null id is a new one. */
internal data class EditKey(val gatewayId: String, val id: String?)

/** Why a save or delete was turned down, and the revision held instead. */
internal data class SaveSaid(val reason: String, val heldRevision: Long? = null)

/** An edit in progress. Its opening is its identity. */
internal data class EditSession<D, S>(
	val draft: D,
	/** As the editor opened it. */
	val opened: D,
	val opening: Long,
	/** What the last send left to show. */
	val said: S? = null,
	val busy: Boolean = false,
	/** Its page left while it was kept. */
	val unattended: Boolean = false,
)

/** A Back that asked, for one opening. */
internal data class LeaveAsk<K>(val key: K, val opening: Long)

internal sealed interface EditOutcome<out D, out S> {
	/** Landed; the editor closes. */
	data object Done : EditOutcome<Nothing, Nothing>

	/** Stays open. A draft replaces the held one; `reopened` makes it what was opened. */
	data class Stays<D, S>(val said: S?, val draft: D? = null, val reopened: Boolean = false) : EditOutcome<D, S>
}

/** While the lock hides an editor: one whose edit is gone does not return. */
internal fun <K> hiddenEditor(open: K?, held: Set<K>): K? = open?.takeIf { it in held }

/** Shown over its own opening. */
internal fun <K> leaveShown(ask: LeaveAsk<K>?, key: K, held: EditSession<*, *>?): Boolean =
	ask != null && ask.key == key && ask.opening == held?.opening

/** What a send that stayed tells the owner once its page has left. */
internal fun leftLine(name: String, fallback: String, reason: String): String = "${name.ifBlank { fallback }}: $reason"

internal enum class EditorShowing { OPENING, DRAWN, CLOSING }

/** A page draws its own opening. One that landed, was discarded or was taken by another closes. */
internal fun editorShowing(shown: Long?, held: EditSession<*, *>?): EditorShowing = when {
	shown == null -> EditorShowing.OPENING
	held?.opening == shown -> EditorShowing.DRAWN
	else -> EditorShowing.CLOSING
}

/** Whether an editor has its record to open on. */
internal enum class EditStanding { READY, WAITING, GONE }

/** A new record is ready; a held one waits for its list, and is gone once the list lacks it. */
internal fun editStanding(id: String?, held: Any?, listed: Boolean): EditStanding = when {
	id == null || held != null -> EditStanding.READY
	listed -> EditStanding.GONE
	else -> EditStanding.WAITING
}

/** What a screen types, written through to its session as it changes. */
internal class MirroredDraft<D : Any>(initial: D, private val mirror: (D) -> Unit) {
	private var typed by mutableStateOf(initial)

	operator fun getValue(thisRef: Any?, property: KProperty<*>): D = typed

	operator fun setValue(thisRef: Any?, property: KProperty<*>, value: D) {
		typed = value
		mirror(value)
	}
}

/** One editor kind's edits in progress, held past the screen that draws them. */
internal class EditorSessions<K : Any, D : Any, S : Any>(
	/** Whether Back asks: the draft against what was opened. */
	private val changed: (D, D) -> Boolean = { draft, opened -> draft != opened },
	/** A send that stayed with no page to show why. */
	private val unattended: (EditSession<D, S>) -> Unit = {},
) {
	val held = MutableStateFlow<Map<K, EditSession<D, S>>>(emptyMap())

	val leaving = MutableStateFlow<LeaveAsk<K>?>(null)

	private val openings = AtomicLong()

	fun clear() {
		held.value = emptyMap()
		leaving.value = null
	}

	/** The only mint. A held key keeps its opening and its draft, and is attended again. */
	fun open(key: K, draft: D): Long {
		val minted = openings.incrementAndGet()
		return held.updateAndGet { now ->
			val kept = now[key]
			now + (key to (kept?.copy(unattended = false) ?: EditSession(draft, draft, minted)))
		}.getValue(key).opening
	}

	/** Its own opening only, never while its op is out. */
	fun edit(key: K, opening: Long, change: (D) -> D) {
		held.update { now ->
			val session = now[key]
			if (session == null || session.opening != opening || session.busy) now
			else now + (key to session.copy(draft = change(session.draft)))
		}
	}

	fun discard(key: K, opening: Long) {
		held.update { now -> if (now[key]?.opening == opening) now - key else now }
		leaving.update { if (it?.key == key && it.opening == opening) null else it }
	}

	/** True leaves now: nothing changed, or a send in flight, which still lands. */
	fun askLeave(key: K): Boolean {
		val session = held.value[key] ?: return true
		// No page draws an unattended one, so nothing could ask.
		if (session.busy || session.unattended) return true
		if (!changed(session.draft, session.opened)) {
			discard(key, session.opening)
			return true
		}
		leaving.value = LeaveAsk(key, session.opening)
		return false
	}

	fun stay() {
		leaving.value = null
	}

	/** A settled edit its page left untouched has nothing to wait for. */
	private fun kept(settled: EditSession<D, S>): Boolean = !settled.unattended || changed(settled.draft, settled.opened)

	/** Its page left: an untouched edit goes, a touched or busy one waits unattended, unasked. */
	fun park(key: K, opening: Long) {
		held.update { now ->
			val session = now[key]
			when {
				session == null || session.opening != opening -> now
				!session.busy && !changed(session.draft, session.opened) -> now - key
				else -> now + (key to session.copy(unattended = true))
			}
		}
		leaving.update { if (it?.key == key && it.opening == opening) null else it }
	}

	/** Null when nothing was sent: another opening holds the key, or its op is out. */
	suspend fun send(key: K, opening: Long, op: suspend (D) -> EditOutcome<D, S>): EditOutcome<D, S>? {
		val before = held.getAndUpdate { now ->
			val session = now[key]
			if (session == null || session.opening != opening || session.busy) now
			else now + (key to session.copy(busy = true, said = null))
		}
		val sent = before[key]?.takeIf { it.opening == opening && !it.busy } ?: return null
		var outcome: EditOutcome<D, S>? = null
		try {
			outcome = op(sent.draft)
		} finally {
			var stayed: EditSession<D, S>? = null
			held.update { now ->
				stayed = null
				// A page may have left meanwhile.
				val current = now[key]?.takeIf { it.opening == sent.opening } ?: return@update now
				when (val result = outcome) {
					EditOutcome.Done -> now - key
					is EditOutcome.Stays -> {
						val draft = result.draft ?: current.draft
						val opened = if (result.reopened) draft else current.opened
						val settled = current.copy(draft = draft, opened = opened, said = result.said, busy = false)
						stayed = settled
						if (kept(settled)) now + (key to settled) else now - key
					}
					null -> current.copy(said = sent.said, busy = false).let { if (kept(it)) now + (key to it) else now - key }
				}
			}
			if (outcome == EditOutcome.Done) leaving.update { if (it?.key == key && it.opening == sent.opening) null else it }
			stayed?.takeIf { it.unattended && it.said != null }?.let(unattended)
		}
		return outcome
	}
}
