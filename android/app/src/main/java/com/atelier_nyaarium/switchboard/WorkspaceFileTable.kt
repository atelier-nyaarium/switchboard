package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileDestination
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeEntry
import java.security.MessageDigest
import java.text.Collator
import java.util.Locale

/**
 * A workspace as the plugin answers it, over paths and text rather than a disk: its confinement, file state
 * and mutation preconditions. The sandbox and the test fakes answer through it, and
 * `tests/fixtures/workspace-file-ops/vectors.json` runs against both it and the plugin's own handlers.
 *
 * Links, encodings, size caps and races are the disk's, and are not modelled.
 */
internal class WorkspaceFileTable(folders: Iterable<String> = emptyList(), files: Map<String, String> = emptyMap()) {
	internal data class Entry(val text: String, val identity: String)

	private val folders = folders.toMutableSet()

	private val entries = LinkedHashMap<String, Entry>()

	private var minted = 0L

	init {
		for ((path, text) in files) put(path, text)
	}

	@Synchronized
	fun textOf(path: String): String? = entries[path]?.text

	@Synchronized
	fun identityOf(path: String): String? = entries[path]?.identity

	@Synchronized
	fun files(): Map<String, String> = entries.mapValues { it.value.text }

	/** A new file at `path`, as another writer would make one. */
	@Synchronized
	fun put(path: String, text: String) {
		entries[path] = Entry(text, "t${++minted}")
	}

	/** Changed in place, keeping its identity. */
	@Synchronized
	fun edit(path: String, text: String) {
		entries[path] = entries.getValue(path).copy(text = text)
	}

	@Synchronized
	fun remove(path: String) {
		entries.remove(path)
	}

	/** The path as the plugin names it, or null where it refuses one. */
	@Synchronized
	fun canonical(written: String): String? = (placed(written) as? Placed.At)?.relative

	/** The workspace-relative path, or why it is refused. */
	private fun placed(written: String): Placed {
		if (written.startsWith("/") || (written.length > 1 && written[1] == ':' && written[0].isLetter())) {
			return Placed.Refused("$written is not workspace-relative")
		}
		val segments = ArrayDeque<String>()
		for (segment in written.split('/')) {
			when (segment) {
				"", "." -> Unit
				".." -> if (segments.isEmpty()) return Placed.Refused("$written leaves the workspace") else segments.removeLast()
				else -> segments.addLast(segment)
			}
		}
		if (segments.any { segment -> segment.any { it.code < 0x20 || it.code == 0x7f } }) {
			return Placed.Refused("$written holds a control character")
		}
		val relative = segments.joinToString("/")
		// A folder holds no bytes, so its name is withheld only where the name alone is.
		val leafIsFile = relative !in folders
		for ((index, segment) in segments.withIndex()) {
			val lower = segment.lowercase()
			if (lower == ".git" || (index == segments.lastIndex && leafIsFile && withheldLeaf(lower))) {
				return Placed.Refused("$segment is not served")
			}
		}
		return Placed.At(relative)
	}

	private sealed interface Placed {
		data class At(val relative: String) : Placed

		data class Refused(val reason: String) : Placed
	}

	private fun isFolder(relative: String) = relative.isEmpty() || relative in folders

	private fun parentOf(relative: String) = relative.substringBeforeLast('/', "")

	@Synchronized
	fun tree(written: String): WorkspaceAnswer<WorkspaceTreeAnswer> {
		val relative = when (val place = placed(written)) {
			is Placed.Refused -> return WorkspaceAnswer.Refused(place.reason)
			is Placed.At -> place.relative
		}
		if (!isFolder(relative)) return WorkspaceAnswer.Refused("$relative is not a folder")
		val childFolders = folders.filter { it.isNotEmpty() && parentOf(it) == relative && listable(it) }.sortedWith(BY_NAME)
		val childFiles = entries.keys.filter { parentOf(it) == relative && listable(it) }.sortedWith(BY_NAME)
		return WorkspaceAnswer.Read(
			WorkspaceTreeAnswer(
				path = relative,
				truncated = false,
				entries = childFolders.map { folder ->
					val children = folders.count { parentOf(it) == folder && listable(it) } +
						entries.keys.count { parentOf(it) == folder && listable(it) }
					WorkspaceTreeEntry(name = folder.substringAfterLast('/'), directory = true, children = children.toLong())
				} + childFiles.map {
					WorkspaceTreeEntry(name = it.substringAfterLast('/'), directory = false, bytes = bytesOf(entries.getValue(it).text))
				},
			),
		)
	}

	private fun listable(relative: String) =
		placed(relative) is Placed.At && relative.substringAfterLast('/').lowercase() != "node_modules"

	@Synchronized
	fun read(written: String): WorkspaceAnswer<WorkspaceReadAnswer> {
		val relative = when (val place = placed(written)) {
			is Placed.Refused -> return WorkspaceAnswer.Refused(place.reason)
			is Placed.At -> place.relative
		}
		if (isFolder(relative)) return WorkspaceAnswer.Refused("$relative is not a file")
		val entry = entries[relative] ?: return WorkspaceAnswer.Refused("$relative does not exist")
		return WorkspaceAnswer.Read(
			WorkspaceReadAnswer(
				path = relative,
				text = entry.text,
				lines = entry.text.split("\n").size.toLong(),
				hash = hashOf(entry.text),
			),
		)
	}

	@Synchronized
	fun state(written: String): WorkspaceAnswer<WorkspaceFileStateAnswer> {
		val relative = when (val place = placed(written)) {
			is Placed.Refused -> return WorkspaceAnswer.Refused(place.reason)
			is Placed.At -> place.relative
		}
		val entry = entries[relative]
		return WorkspaceAnswer.Read(
			when {
				isFolder(relative) -> WorkspaceFileStateAnswer(path = relative, state = "directory")
				entry == null -> WorkspaceFileStateAnswer(path = relative, state = "absent")
				else -> WorkspaceFileStateAnswer(
					path = relative,
					state = "file",
					bytes = bytesOf(entry.text),
					hash = hashOf(entry.text),
					identity = entry.identity,
				)
			},
		)
	}

	@Synchronized
	fun mutate(mutation: WorkspaceFileMutation): WorkspaceAnswer<WorkspaceFileMutationAnswer> =
		when (mutation) {
			is WorkspaceFileMutation.Write -> write(mutation)
			is WorkspaceFileMutation.Create -> create(mutation)
			is WorkspaceFileMutation.Delete -> delete(mutation)
			is WorkspaceFileMutation.Move -> move(mutation)
			is WorkspaceFileMutation.Copy -> copy(mutation)
		}

	/** What an operation acts on, or the answer that stops it. */
	private sealed interface Check<out T> {
		data class Pass<T>(val value: T) : Check<T>

		data class Stop(val answer: WorkspaceAnswer<WorkspaceFileMutationAnswer>) : Check<Nothing>
	}

	private fun answer(relative: String, outcome: String, hash: String? = null, gone: Boolean? = null) =
		WorkspaceAnswer.Read(WorkspaceFileMutationAnswer(path = relative, outcome = outcome, hash = hash, gone = gone))

	private fun file(written: String): Check<String> =
		when (val place = placed(written)) {
			is Placed.Refused -> Check.Stop(WorkspaceAnswer.Refused(place.reason))
			is Placed.At ->
				if (place.relative.isEmpty()) Check.Stop(WorkspaceAnswer.Refused("a file path is required")) else Check.Pass(place.relative)
		}

	private fun source(written: String, expectedHash: String, expectedIdentity: String?): Check<Pair<String, Entry>> {
		val relative = when (val placed = file(written)) {
			is Check.Stop -> return placed
			is Check.Pass -> placed.value
		}
		if (isFolder(relative)) return Check.Stop(WorkspaceAnswer.Refused("$relative is a folder"))
		val entry = entries[relative] ?: return Check.Stop(answer(relative, MUTATION_STALE, gone = true))
		if (expectedIdentity != null && entry.identity != expectedIdentity) return Check.Stop(answer(relative, MUTATION_STALE))
		if (hashOf(entry.text) != expectedHash) return Check.Stop(answer(relative, MUTATION_STALE))
		return Check.Pass(relative to entry)
	}

	private fun destination(source: String, written: String, expected: WorkspaceFileDestination): Check<String> {
		val relative = when (val placed = file(written)) {
			is Check.Stop -> return placed
			is Check.Pass -> placed.value
		}
		if (relative == source) return Check.Stop(WorkspaceAnswer.Refused("$relative is where it already is"))
		val changed = Check.Stop(answer(source, MUTATION_DESTINATION_CHANGED))
		val entry = entries[relative]
		if (entry == null && !isFolder(relative)) {
			if (expected !is WorkspaceFileDestination.Absent) return changed
			if (!isFolder(parentOf(relative))) return Check.Stop(WorkspaceAnswer.Refused("${parentOf(relative)} is not a folder here"))
			return Check.Pass(relative)
		}
		if (isFolder(relative)) return Check.Stop(WorkspaceAnswer.Refused("$relative is a folder"))
		if (expected !is WorkspaceFileDestination.Replace) return changed
		if (entry!!.identity != expected.expectedIdentity || hashOf(entry.text) != expected.expectedHash) return changed
		return Check.Pass(relative)
	}

	private fun write(write: WorkspaceFileMutation.Write): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
		val relative = when (val placed = file(write.path)) {
			is Check.Stop -> return placed.answer
			is Check.Pass -> placed.value
		}
		if (isFolder(relative)) return WorkspaceAnswer.Refused("$relative is not a file")
		val entry = entries[relative] ?: return answer(relative, MUTATION_STALE, gone = true)
		if (hashOf(entry.text) != write.expectedHash) return answer(relative, MUTATION_STALE)
		// The plugin renames a temp into place, which is a new file.
		put(relative, write.text)
		return answer(relative, MUTATION_DONE, hash = hashOf(write.text))
	}

	private fun create(create: WorkspaceFileMutation.Create): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
		val relative = when (val placed = file(create.path)) {
			is Check.Stop -> return placed.answer
			is Check.Pass -> placed.value
		}
		if (relative in entries || isFolder(relative)) return answer(relative, MUTATION_DESTINATION_CHANGED)
		if (!isFolder(parentOf(relative))) return WorkspaceAnswer.Refused("${parentOf(relative)} is not a folder here")
		put(relative, create.text)
		return answer(relative, MUTATION_DONE, hash = hashOf(create.text))
	}

	private fun delete(delete: WorkspaceFileMutation.Delete): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
		val (relative, _) = when (val checked = source(delete.path, delete.expectedHash, delete.expectedIdentity)) {
			is Check.Stop -> return checked.answer
			is Check.Pass -> checked.value
		}
		entries.remove(relative)
		return answer(relative, MUTATION_DONE)
	}

	private fun move(move: WorkspaceFileMutation.Move): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
		val (from, entry) = when (val checked = source(move.path, move.expectedHash, move.expectedIdentity)) {
			is Check.Stop -> return checked.answer
			is Check.Pass -> checked.value
		}
		val to = when (val checked = destination(from, move.to, move.destination)) {
			is Check.Stop -> return checked.answer
			is Check.Pass -> checked.value
		}
		entries.remove(from)
		entries[to] = entry
		return answer(from, MUTATION_DONE, hash = move.expectedHash)
	}

	private fun copy(copy: WorkspaceFileMutation.Copy): WorkspaceAnswer<WorkspaceFileMutationAnswer> {
		val (from, entry) = when (val checked = source(copy.path, copy.expectedHash, null)) {
			is Check.Stop -> return checked.answer
			is Check.Pass -> checked.value
		}
		val to = when (val checked = destination(from, copy.to, copy.destination)) {
			is Check.Stop -> return checked.answer
			is Check.Pass -> checked.value
		}
		put(to, entry.text)
		return answer(from, MUTATION_DONE, hash = copy.expectedHash)
	}

	private companion object {
		val SERVED_ENV_SUFFIXES = setOf("example", "sample", "template")

		/** The plugin's `localeCompare`, so `b.md` lists before `C.md`. */
		val BY_NAME: Comparator<String> = compareBy(Collator.getInstance(Locale.ROOT)) { it.substringAfterLast('/') }

		fun withheldLeaf(lower: String): Boolean =
			lower == ".env" || (lower.startsWith(".env.") && lower.removePrefix(".env.") !in SERVED_ENV_SUFFIXES)

		fun bytesOf(text: String) = text.toByteArray(Charsets.UTF_8).size.toLong()

		fun hashOf(text: String): String =
			MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
	}
}
