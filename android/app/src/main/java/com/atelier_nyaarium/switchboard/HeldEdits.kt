package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** What a held edit owes the disk, and what an answer about it was computed against. */
internal interface Drafted {
	/** Minted per open: which opening this is, not which text. */
	val incarnation: Long

	/** The hash of the text the edit is bound to; a save names it. */
	val version: String

	val draftKey: DraftKey

	/** Null: no draft file. */
	val heldDraft: HeldDraft?
}

/**
 * How an answer computed from a held edit lands, now that the edit may have moved while it waited. Every
 * road that awaited anything names one, so none can choose for itself which fields count as moved.
 */
internal sealed interface Landing<T> {
	/** Only over exactly the edit the work began from; anything since outranks it. Null lets it go. */
	data class OverUntouched<T>(val next: T?) : Landing<T>

	/**
	 * Over the same opening still bound to the same version, folding in what changed since, such as typing
	 * that arrived during a save. Null lets it go.
	 */
	class Folded<T>(val fold: (current: T) -> T?) : Landing<T>
}

/**
 * Edits held per session, with ONE road in. Every change is a function of what is held NOW, so a decision
 * made from a value read before a network wait cannot be written back.
 *
 * The disk follows the value. A caller changes an edit and never says what its file should do, so the two
 * cannot drift: a draft that appeared is written, one that went is deleted, and an edit that left takes its
 * file with it. Windows and raw files both hold theirs here, since they share one draft directory.
 */
internal class HeldEdits<T : Drafted>(private val drafts: WorkspaceDraftStore) {
	private val held = MutableStateFlow<Map<WorkspaceTarget, List<T>>>(emptyMap())

	/**
	 * Held across the write and the enqueue that follows it, so the files are asked for in the order the
	 * values landed. A plain monitor rather than a `Mutex`, since the screen calls `apply` off a keystroke
	 * and cannot suspend; nothing inside it reaches the disk or the network.
	 */
	private val applying = Any()

	val all: StateFlow<Map<WorkspaceTarget, List<T>>> = held

	fun of(target: WorkspaceTarget): List<T> = held.value[target].orEmpty()

	fun targets(): Set<WorkspaceTarget> = held.value.keys

	/**
	 * Lands an answer computed from [before]. False when the edit moved past what [landing] accepts, so the
	 * caller can tell a landed answer from one the owner outran.
	 */
	fun land(
		target: WorkspaceTarget,
		before: T,
		landing: Landing<T>,
		settled: ((before: List<T>, after: List<T>) -> Unit)? = null,
	): Boolean {
		var landed = false
		apply(target, settled) { edits ->
			landed = false
			edits.mapNotNull { current ->
				val accepts = when (landing) {
					is Landing.OverUntouched -> current == before
					is Landing.Folded -> current.incarnation == before.incarnation && current.version == before.version
				}
				if (!accepts) return@mapNotNull current
				landed = true
				when (landing) {
					is Landing.OverUntouched -> landing.next
					is Landing.Folded -> landing.fold(current)
				}
			}
		}
		return landed
	}

	/**
	 * For a change to the set, or an edit made without waiting on anything; an answer lands through `land`.
	 * The transform sees the session's edits and returns them; returning the same list writes nothing. It
	 * runs inside the atomic update, so a check it makes is not racing the write it guards. `settled` sees
	 * the winning before and after, under the same monitor.
	 */
	fun apply(
		target: WorkspaceTarget,
		settled: ((before: List<T>, after: List<T>) -> Unit)? = null,
		transform: (List<T>) -> List<T>,
	) {
		synchronized(applying) {
			var before = emptyList<T>()
			var after = emptyList<T>()
			held.update { all ->
				before = all[target].orEmpty()
				after = transform(before)
				if (after == before) all else all + (target to after)
			}
			// Assigned inside a compare-and-set that may retry, so only the winning attempt is persisted.
			persist(target, before, after)
			settled?.invoke(before, after)
		}
	}

	/** Keyed by incarnation, the one notion of identity the callers' guards also read. */
	private fun persist(target: WorkspaceTarget, before: List<T>, after: List<T>) {
		// Departures first: two openings of one key name one file, and the leaver must not delete what the
		// arrival just wrote.
		val kept = after.mapTo(HashSet()) { it.incarnation }
		for (edit in before) {
			if (edit.incarnation in kept) continue
			drafts.clear(target, edit.draftKey)
		}
		val was = before.associateBy { it.incarnation }
		for (edit in after) {
			val draft = edit.heldDraft
			if (was[edit.incarnation]?.heldDraft == draft) continue
			if (draft == null) drafts.clear(target, edit.draftKey) else drafts.save(target, edit.draftKey, draft)
		}
	}
}
