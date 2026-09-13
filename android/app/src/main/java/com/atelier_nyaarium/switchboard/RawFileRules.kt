package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer

/** A whole file in the raw editor. `hash` is the whole binding: a write lands only while the file hashes to it. */
internal data class RawEdit(
	val path: String,
	/** What the file held when read. */
	val original: String,
	val hash: String,
	val draft: String? = null,
	val stale: Boolean = false,
	override val incarnation: Long = 0,
) : Drafted {
	val edited: Boolean get() = draft != null && draft != original
	val shown: String get() = draft ?: original
	val stamp: RawStamp get() = RawStamp(incarnation, hash)

	override val draftKey: DraftKey get() = DraftKey.File(path)

	override val heldDraft: HeldDraft? get() = draft?.let { HeldDraft(hash, it) }
}

internal data class RawStamp(val incarnation: Long, val hash: String)

/** What opening a file shows. A read-only file is drawn, never held, since it has no draft. */
internal sealed interface RawOpened {
	data object Editable : RawOpened

	data class ReadOnly(val text: String, val reason: String) : RawOpened
}

/** Null without a hash, which names nothing a write could be checked against. Keyed by the path asked for. */
internal fun rawEditOf(path: String, answer: WorkspaceReadAnswer, incarnation: Long): RawEdit? =
	answer.hash?.let { RawEdit(path = path, original = answer.text, hash = it, incarnation = incarnation) }

internal fun readOnlyOf(answer: WorkspaceReadAnswer): RawOpened.ReadOnly =
	RawOpened.ReadOnly(answer.text, answer.readOnly ?: "This session's plugin cannot save files; update it")

/** As `restored` does for a window. */
internal fun restoredRaw(edit: RawEdit, held: HeldDraft?): RawEdit =
	when {
		held == null -> edit
		held.base == edit.hash -> edit.copy(draft = held.text)
		else -> edit.copy(hash = held.base, draft = held.text, stale = true)
	}

/**
 * The file as read now, against what is held. Nothing of the owner's at stake adopts silently; typing that
 * would be lost raises the banner. Null lets go of a file that can no longer be written and holds no typing.
 */
internal fun refreshRaw(held: RawEdit, fresh: WorkspaceReadAnswer): RawEdit? {
	val hash = fresh.hash
	if (hash == held.hash) return held
	if (hash == null) return if (held.edited) held.copy(stale = true) else null
	// The file caught up with the draft, which is what an applied ask looks like.
	if (!held.edited || fresh.text == held.shown) {
		return held.copy(original = fresh.text, hash = hash, draft = null, stale = false)
	}
	return held.copy(stale = true)
}

/** The text a write sent is now the file. Typing that arrived during the write stays a draft. */
internal fun written(held: RawEdit, sent: String, hash: String): RawEdit =
	held.copy(original = sent, hash = hash, draft = held.draft?.takeIf { it != sent }, stale = false)

internal const val MUTATION_DONE = "done"
internal const val MUTATION_STALE = "stale"

/** What one Save did, never a Boolean. */
internal sealed interface RawSave {
	data object Written : RawSave

	/** The file moved since it was read, so nothing was written. */
	data class Stale(val gone: Boolean) : RawSave

	data class Refused(val reason: String) : RawSave

	/** Read back as it was before the write, so nothing landed. */
	data class NotWritten(val reason: String?) : RawSave

	/** Neither answered nor read back. */
	data object Unconfirmed : RawSave

	data object NothingEdited : RawSave
}

/** An unanswered write, settled by what a read back found. */
internal sealed interface ReadBack {
	data class Landed(val hash: String) : ReadBack

	data object Untouched : ReadBack

	data object Moved : ReadBack
}

internal fun readBackOf(sent: String, expectedHash: String, fresh: WorkspaceReadAnswer): ReadBack {
	val hash = fresh.hash
	return when {
		hash != null && fresh.text == sent -> ReadBack.Landed(hash)
		hash == expectedHash -> ReadBack.Untouched
		else -> ReadBack.Moved
	}
}

internal fun rawSaveNotice(save: RawSave): String? =
	when (save) {
		RawSave.Written -> "Saved"
		// The banner already says it changed.
		is RawSave.Stale -> if (save.gone) "Deleted on disk. Not saved" else "Not saved"
		is RawSave.Refused -> save.reason
		is RawSave.NotWritten -> listOfNotNull("Not saved", save.reason).joinToString(". ")
		RawSave.Unconfirmed -> "Not confirmed"
		RawSave.NothingEdited -> null
	}
