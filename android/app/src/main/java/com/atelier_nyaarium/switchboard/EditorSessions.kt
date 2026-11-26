package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.atomic.AtomicLong
import kotlin.reflect.KProperty
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet

/** A record edited on one Gateway; a null id is a new one. */
internal data class EditKey(val gatewayId: String, val id: String?)

/** Why a save or delete was turned down, and the revision held instead. */
/** Typed value refused. */
internal data class SaveSaid(val reason: String, val heldRevision: Long? = null, val marks: String? = null)

/** An edit in progress. Its opening is its identity. */
internal data class EditSession<D, S>(
	val draft: D,
	/** As the editor opened it. */
	val opened: D,
	val opening: Long,
	/** What the last send left to show. */
	val said: S? = null,
	val busy: Boolean = false,
	/** What it said reached the owner off the editor; told once. */
	val told: Boolean = false,
)

/** A Back that asked, for one opening. */
internal data class LeaveAsk<K>(val key: K, val opening: Long)

internal data class EditState<K, D, S>(
	val held: Map<K, EditSession<D, S>> = emptyMap(),
	val shown: K? = null,
	val leaving: LeaveAsk<K>? = null,
) {
	fun asks(key: K): Boolean = leaving != null && leaving.key == key && leaving.opening == held[key]?.opening
}

internal sealed interface EditOutcome<out D, out S> {
	/** Landed; the editor closes. */
	data object Done : EditOutcome<Nothing, Nothing>

	/** Stays open. A draft replaces the held one; `reopened` makes it what was opened. */
	data class Stays<D, S>(val said: S?, val draft: D? = null, val reopened: Boolean = false) : EditOutcome<D, S>
}

internal fun leftLine(name: String, fallback: String, reason: String): String = "${name.ifBlank { fallback }}: $reason"

/** Whether an editor has its record to open on. */
internal enum class EditStanding { READY, READING, UNREACHABLE, NOT_SERVED, GONE }

/** A new record, with no lookup, is ready; a held one stands as its list answered. */
internal fun editStanding(held: Lookup<*>?): EditStanding = when (held) {
	null, is Lookup.Found -> EditStanding.READY
	Lookup.Gone -> EditStanding.GONE
	Lookup.Reading -> EditStanding.READING
	Lookup.Unreachable -> EditStanding.UNREACHABLE
	Lookup.NotServed -> EditStanding.NOT_SERVED
}

/** New opens fresh, found on itself, else nothing. */
internal fun <R, D> openingDraft(held: Lookup<R>?, fresh: () -> D, of: (R) -> D): D? = when (held) {
	null -> fresh()
	is Lookup.Found -> of(held.row)
	Lookup.Gone, Lookup.Reading, Lookup.Unreachable, Lookup.NotServed -> null
}

/** What an editor with no record to open on says; null spins. */
internal fun waitingLine(standing: EditStanding): String? = when (standing) {
	EditStanding.GONE -> "Deleted elsewhere."
	EditStanding.UNREACHABLE -> "This Gateway could not be read."
	EditStanding.NOT_SERVED -> "This Gateway does not serve this."
	EditStanding.READY, EditStanding.READING -> null
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

/** Pages Back closes first. */
internal class InnerPages<D : Any>(
	/** Mirror key. */
	val open: (D) -> Any?,
	val close: (D) -> D,
) {
	fun closed(draft: D): D? = if (open(draft) != null) close(draft) else null
}

/** Sole owner of edits and shown key. */
internal class EditorSessions<K : Any, D : Any, S : Any>(
	/** Whether Back asks: the draft against what was opened. */
	private val changed: (D, D) -> Boolean = { draft, opened -> draft != opened },
	/** A send that stayed with no page to show why. */
	private val unattended: (EditSession<D, S>) -> Unit = {},
	/** Closed by Back first. */
	private val inner: InnerPages<D>? = null,
	/** A said clears once the draft changes. */
	private val clears: (S) -> Boolean = { false },
) {
	private val written = MutableStateFlow(EditState<K, D, S>())

	val state: StateFlow<EditState<K, D, S>> = written.asStateFlow()

	private val openings = AtomicLong()

	fun clear() {
		written.value = EditState()
	}

	/** Mirror key. */
	fun page(draft: D): Any? = inner?.open?.invoke(draft)

	private fun EditSession<D, S>.keeps(): Boolean = busy || changed(draft, opened)

	private fun EditState<K, D, S>.hidden(): EditState<K, D, S> {
		val key = shown ?: return this
		val session = held[key]
		return copy(held = if (session == null || session.keeps()) held else held - key, shown = null, leaving = null)
	}

	fun show(key: K) {
		written.update { now -> if (now.shown == key) now else now.hidden().copy(shown = key) }
	}

	/** Untouched goes; touched or busy waits. */
	fun hide() {
		var unseen: EditSession<D, S>? = null
		written.update { now ->
			val key = now.shown
			val telling = key?.let { now.held[it] }?.takeIf { it.said != null && !it.busy && !it.told }
			unseen = telling
			val marked = if (key != null && telling != null) now.copy(held = now.held + (key to telling.copy(told = true))) else now
			marked.hidden()
		}
		unseen?.let(unattended)
	}

	/** Only mint; shown key only. */
	fun open(key: K, draft: D): Long? {
		val minted = openings.incrementAndGet()
		return written.updateAndGet { now ->
			if (now.shown != key || key in now.held) now
			else now.copy(held = now.held + (key to EditSession(draft, draft, minted)))
		}.held[key]?.opening
	}

	/** Its own opening only, never while its op is out. */
	fun edit(key: K, opening: Long, change: (D) -> D) {
		written.update { now ->
			val session = now.held[key]
			if (session == null || session.opening != opening || session.busy) return@update now
			val next = change(session.draft)
			val said = session.said?.takeUnless { clears(it) && changed(next, session.draft) }
			now.copy(held = now.held + (key to session.copy(draft = next, said = said)))
		}
	}

	private fun EditState<K, D, S>.without(key: K): EditState<K, D, S> =
		copy(held = held - key, shown = shown.takeUnless { it == key }, leaving = leaving.takeUnless { it?.key == key })

	fun discard(key: K, opening: Long) {
		written.update { now -> if (now.held[key]?.opening == opening) now.without(key) else now }
	}

	/** True leaves now; a send in flight still lands. */
	fun askLeave(): Boolean {
		var left = true
		written.update { now ->
			val key = now.shown
			val session = key?.let { now.held[it] }
			val closed = session?.takeUnless { it.busy }?.let { inner?.closed(it.draft) }
			if (key != null && session != null && closed != null) {
				left = false
				return@update now.copy(held = now.held + (key to session.copy(draft = closed)))
			}
			left = session == null || !session.keeps() || session.busy
			if (left) now.hidden() else now.copy(leaving = LeaveAsk(key!!, session!!.opening))
		}
		return left
	}

	fun stay() {
		written.update { it.copy(leaving = null) }
	}

	/** Null when nothing was sent: another opening holds the key, or its op is out. */
	suspend fun send(key: K, opening: Long, op: suspend (D) -> EditOutcome<D, S>): EditOutcome<D, S>? {
		val before = written.getAndUpdate { now ->
			val session = now.held[key]
			if (session == null || session.opening != opening || session.busy) now
			else now.copy(held = now.held + (key to session.copy(busy = true, said = null, told = false)))
		}
		val sent = before.held[key]?.takeIf { it.opening == opening && !it.busy } ?: return null
		var outcome: EditOutcome<D, S>? = null
		try {
			outcome = op(sent.draft)
		} finally {
			var unseen: EditSession<D, S>? = null
			written.update { now ->
				unseen = null
				// Discarded or cleared meanwhile.
				val current = now.held[key]?.takeIf { it.opening == sent.opening } ?: return@update now
				val settled = when (val result = outcome) {
					EditOutcome.Done -> return@update now.without(key)
					is EditOutcome.Stays -> {
						val draft = result.draft ?: current.draft
						current.copy(draft = draft, opened = if (result.reopened) draft else current.opened, said = result.said, busy = false)
					}
					null -> current.copy(said = sent.said, busy = false)
				}
				val shown = now.shown == key
				val telling = !shown && outcome != null && settled.said != null
				if (telling) unseen = settled
				val kept = settled.copy(told = telling)
				if (shown || kept.keeps()) now.copy(held = now.held + (key to kept)) else now.copy(held = now.held - key)
			}
			unseen?.let(unattended)
		}
		return outcome
	}
}

internal sealed interface ShownEditor {
	data class Runbook(val key: EditKey) : ShownEditor

	data class Routine(val key: EditKey) : ShownEditor

	data class Policy(val key: EditKey) : ShownEditor

	data class Automation(val key: AutomationDraftKey) : ShownEditor
}

internal fun shownEditorOf(runbook: EditKey?, routine: EditKey?, policy: EditKey?, automation: AutomationDraftKey?): ShownEditor? =
	policy?.let(ShownEditor::Policy) ?: routine?.let(ShownEditor::Routine) ?: runbook?.let(ShownEditor::Runbook)
		?: automation?.let(ShownEditor::Automation)

/** A policy needs the vault on; an event automation needs its Gateway to still be the assistant's. */
internal fun editorStands(
	editor: ShownEditor?,
	vaultOn: Boolean,
	movesWithHome: (AutomationDraftKey) -> Boolean,
	assistantLeft: (String) -> Boolean,
): Boolean = when (editor) {
	is ShownEditor.Policy -> vaultOn
	is ShownEditor.Automation -> !(movesWithHome(editor.key) && assistantLeft(editor.key.gatewayId))
	is ShownEditor.Runbook, is ShownEditor.Routine, null -> true
}

internal class Editors(
	private val runbooks: EditorSessions<EditKey, *, *>,
	private val routines: EditorSessions<EditKey, *, *>,
	private val policies: EditorSessions<EditKey, *, *>,
	private val automations: EditorSessions<AutomationDraftKey, *, *>,
) {
	private val kinds get() = listOf(runbooks, routines, policies, automations)

	fun show(editor: ShownEditor) {
		when (editor) {
			is ShownEditor.Runbook -> only(runbooks, editor.key)
			is ShownEditor.Routine -> only(routines, editor.key)
			is ShownEditor.Policy -> only(policies, editor.key)
			is ShownEditor.Automation -> only(automations, editor.key)
		}
	}

	// Its own kind keeps a key shown twice.
	private fun <K : Any> only(kind: EditorSessions<K, *, *>, key: K) {
		kinds.filter { it !== kind }.forEach { it.hide() }
		kind.show(key)
	}

	fun hideAll() = kinds.forEach { it.hide() }

	fun askLeave(): Boolean = kinds.map { it.askLeave() }.all { it }
}
