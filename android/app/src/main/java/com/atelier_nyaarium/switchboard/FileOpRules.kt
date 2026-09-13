package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileDestination
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer

/** What a folder's screen draws: its tree, and the one file operation begun from it. */
internal data class FolderView(
	/** Null while the first read is out. */
	val listing: WorkspaceAnswer<WorkspaceTreeAnswer>? = null,
	val busy: Boolean = false,
	val outcome: FolderOutcome? = null,
	val asking: PathAsk? = null,
	val confirming: ArmedFileOp? = null,
	/** A created file the screen opens, then acknowledges. */
	val openRaw: String? = null,
)

/** How the last operation begun from a folder ended. */
internal sealed interface FolderOutcome {
	data class Finished(val action: FileAction, val result: FileOpResult) : FolderOutcome

	data class NotArmed(val reason: String) : FolderOutcome
}

internal fun outcomeText(outcome: FolderOutcome): String =
	when (outcome) {
		is FolderOutcome.Finished -> fileOpNotice(outcome.action, outcome.result)
		is FolderOutcome.NotArmed -> outcome.reason
	}

internal const val MUTATION_DONE = "done"
internal const val MUTATION_STALE = "stale"
internal const val MUTATION_DESTINATION_CHANGED = "destinationChanged"

/** What a path held when read. A mutation is armed from it, and an unanswered one settled by it. */
internal sealed interface FileFact {
	data object Absent : FileFact

	data object Folder : FileFact

	data class File(val hash: String, val identity: String) : FileFact

	/** Unhashable, or a state this build does not know. */
	data object Unnamed : FileFact
}

internal fun fileFactOf(answer: WorkspaceFileStateAnswer): FileFact =
	when (answer.state) {
		"absent" -> FileFact.Absent
		"directory" -> FileFact.Folder
		"file" -> {
			val hash = answer.hash
			val identity = answer.identity
			if (hash != null && identity != null) FileFact.File(hash, identity) else FileFact.Unnamed
		}
		else -> FileFact.Unnamed
	}

internal sealed interface FileAction {
	val path: String
}

/** Takes nothing that exists, so it needs no confirmation. */
internal data class CreateFile(override val path: String) : FileAction

/** Acts on a file that exists, so it is armed from a read and confirmed. */
internal sealed interface ArmedAction : FileAction {
	data class Delete(override val path: String) : ArmedAction

	data class Move(override val path: String, val to: String) : ArmedAction

	data class Copy(override val path: String, val to: String) : ArmedAction
}

/** What a confirmation shows, and exactly what it sends. */
internal data class ArmedFileOp(
	val action: ArmedAction,
	val source: FileFact.File,
	/** Absent or a file; null for a delete. */
	val destination: FileFact?,
	/** Raw editor typing held for the source, which stays keyed to its old path. */
	val typingHeld: Boolean,
) {
	val replaces: Boolean get() = destination is FileFact.File

	val mutation: WorkspaceFileMutation
		get() = when (action) {
			is ArmedAction.Delete -> WorkspaceFileMutation.Delete(action.path, source.hash, source.identity)
			is ArmedAction.Move ->
				WorkspaceFileMutation.Move(action.path, source.hash, source.identity, action.to, destinationOf(destination))
			is ArmedAction.Copy -> WorkspaceFileMutation.Copy(action.path, source.hash, action.to, destinationOf(destination))
		}
}

private fun destinationOf(fact: FileFact?): WorkspaceFileDestination =
	if (fact is FileFact.File) WorkspaceFileDestination.Replace(fact.hash, fact.identity) else WorkspaceFileDestination.Absent

internal sealed interface Arming {
	data class Armed(val op: ArmedFileOp) : Arming

	data class Refused(val reason: String) : Arming
}

internal fun armedOf(action: ArmedAction, source: FileFact, destination: FileFact?, typingHeld: Boolean): Arming {
	val file = when (source) {
		is FileFact.File -> source
		FileFact.Absent -> return Arming.Refused("${action.path} is not there")
		FileFact.Folder -> return Arming.Refused("Folders are not changed from here")
		FileFact.Unnamed -> return Arming.Refused("${action.path} is too large to check")
	}
	val to = when (action) {
		is ArmedAction.Delete -> return Arming.Armed(ArmedFileOp(action, file, null, typingHeld))
		is ArmedAction.Move -> action.to
		is ArmedAction.Copy -> action.to
	}
	if (to == action.path) return Arming.Refused("$to is where it already is")
	return when (destination) {
		FileFact.Absent, is FileFact.File -> Arming.Armed(ArmedFileOp(action, file, destination, typingHeld))
		FileFact.Folder -> Arming.Refused("$to is a folder")
		FileFact.Unnamed, null -> Arming.Refused("$to is too large to check")
	}
}

/** The dialog asking where. `from` is the file for a move or copy, and the folder a create starts in. */
internal data class PathAsk(val kind: Kind, val from: String) {
	enum class Kind { Create, Move, Copy }

	val title: String get() = when (kind) {
		Kind.Create -> "New file"
		Kind.Move -> "Move $from to"
		Kind.Copy -> "Copy $from to"
	}

	val prefill: String get() = if (kind == Kind.Create && from.isNotEmpty()) "$from/" else if (kind == Kind.Create) "" else from

	fun actionOf(typed: String): FileAction? {
		val to = typedPath(typed, if (kind == Kind.Create) "" else from.substringAfterLast('/')) ?: return null
		return when (kind) {
			Kind.Create -> CreateFile(to)
			Kind.Move -> ArmedAction.Move(from, to)
			Kind.Copy -> ArmedAction.Copy(from, to)
		}
	}
}

/** Trimmed. A trailing slash names the folder `name` goes into. Null names no file. */
internal fun typedPath(typed: String, name: String): String? {
	val trimmed = typed.trim().trimStart('/')
	val written = if (trimmed.endsWith('/')) trimmed + name else trimmed
	return written.takeUnless { it.isEmpty() || it.endsWith('/') }
}

/** Never a Boolean; each outcome reads differently. */
internal sealed interface FileOpResult {
	data object Done : FileOpResult

	/** Not the file confirmed, so nothing was done. */
	data class SourceChanged(val gone: Boolean) : FileOpResult

	/** Not in the state confirmed, so nothing was done. */
	data object DestinationChanged : FileOpResult

	data class Refused(val reason: String) : FileOpResult

	/** Read back as it was, so nothing landed. */
	data class NotDone(val reason: String?) : FileOpResult

	/** Neither answered nor settled by a read back. */
	data object Unconfirmed : FileOpResult
}

/** Null for `unknown` and any outcome this build does not know, which may have landed. */
internal fun answeredOf(answer: WorkspaceFileMutationAnswer): FileOpResult? =
	when (answer.outcome) {
		MUTATION_DONE -> FileOpResult.Done
		MUTATION_STALE -> FileOpResult.SourceChanged(gone = answer.gone == true)
		MUTATION_DESTINATION_CHANGED -> FileOpResult.DestinationChanged
		else -> null
	}

/** An unanswered mutation, settled by reading its paths back. A null fact could not be read. */
internal fun settledOf(op: ArmedFileOp, source: FileFact?, destination: FileFact?, reason: String?): FileOpResult {
	if (source == null) return FileOpResult.Unconfirmed
	val sourceKept = source == op.source
	return when (op.action) {
		is ArmedAction.Delete -> when {
			source == FileFact.Absent -> FileOpResult.Done
			sourceKept -> FileOpResult.NotDone(reason)
			else -> FileOpResult.SourceChanged(gone = false)
		}
		is ArmedAction.Move -> {
			val carried = (destination as? FileFact.File)?.identity == op.source.identity
			when {
				destination == null -> FileOpResult.Unconfirmed
				carried && source == FileFact.Absent -> FileOpResult.Done
				// Both names on one inode is a move cut short.
				carried -> FileOpResult.Unconfirmed
				sourceKept && destination == op.destination -> FileOpResult.NotDone(reason)
				sourceKept -> FileOpResult.DestinationChanged
				source == FileFact.Absent -> FileOpResult.SourceChanged(gone = true)
				else -> FileOpResult.Unconfirmed
			}
		}
		// A copy that landed holds the confirmed bytes under a new inode, whatever the source became.
		is ArmedAction.Copy -> when {
			destination == null -> FileOpResult.Unconfirmed
			destination == op.destination -> FileOpResult.NotDone(reason)
			(destination as? FileFact.File)?.hash == op.source.hash -> FileOpResult.Done
			else -> FileOpResult.DestinationChanged
		}
	}
}

/** A create sends no text, so an empty file there is what it asked for. */
internal fun createdOf(state: WorkspaceFileStateAnswer?, reason: String?): FileOpResult =
	when {
		state == null -> FileOpResult.Unconfirmed
		state.state == "absent" -> FileOpResult.NotDone(reason)
		state.state == "file" && state.bytes == 0L -> FileOpResult.Done
		else -> FileOpResult.DestinationChanged
	}

internal data class FileOpConfirm(val title: String, val lines: List<String>, val button: String)

internal fun confirmOf(op: ArmedFileOp): FileOpConfirm {
	val path = op.action.path
	val typing = if (op.typingHeld) "Unsaved raw typing stays with $path" else null
	return when (val action = op.action) {
		is ArmedAction.Delete -> FileOpConfirm("Delete $path?", listOfNotNull(typing), "Delete")
		is ArmedAction.Move -> FileOpConfirm(
			"Move $path to ${action.to}?",
			listOfNotNull(replacing(op, action.to), typing),
			if (op.replaces) "Replace" else "Move",
		)
		is ArmedAction.Copy -> FileOpConfirm(
			"Copy $path to ${action.to}?",
			listOfNotNull(replacing(op, action.to)),
			if (op.replaces) "Replace" else "Copy",
		)
	}
}

private fun replacing(op: ArmedFileOp, to: String): String? = if (op.replaces) "Replaces the $to there now" else null

internal fun fileOpNotice(action: FileAction, result: FileOpResult): String {
	val to = when (action) {
		is ArmedAction.Move -> action.to
		is ArmedAction.Copy -> action.to
		else -> action.path
	}
	return when (result) {
		FileOpResult.Done -> when (action) {
			is CreateFile -> "Created ${action.path}"
			is ArmedAction.Delete -> "Deleted ${action.path}"
			is ArmedAction.Move -> "Moved to ${action.to}"
			is ArmedAction.Copy -> "Copied to ${action.to}"
		}
		is FileOpResult.SourceChanged ->
			if (result.gone) "${action.path} is gone. Nothing was done" else "${action.path} changed. Nothing was done"
		FileOpResult.DestinationChanged ->
			if (action is CreateFile) "${action.path} already exists" else "$to changed. Nothing was done"
		is FileOpResult.Refused -> result.reason
		is FileOpResult.NotDone -> listOfNotNull("Not done", result.reason).joinToString(". ")
		FileOpResult.Unconfirmed -> "Not confirmed. Reload to check"
	}
}

/** A refusal or a read back as before changed nothing to show. */
internal fun treeMoved(result: FileOpResult): Boolean = result !is FileOpResult.Refused && result !is FileOpResult.NotDone

/** A new file opens in the raw editor, since an empty file is only ever made to be written. */
internal fun rawToOpen(action: FileAction, result: FileOpResult): String? =
	action.path.takeIf { action is CreateFile && result == FileOpResult.Done }
