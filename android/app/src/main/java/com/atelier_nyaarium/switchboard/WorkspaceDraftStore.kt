package com.atelier_nyaarium.switchboard

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/** Which draft a file holds. */
internal sealed interface DraftKey {
	data class Span(val symbolId: String) : DraftKey

	data class File(val path: String) : DraftKey
}

/**
 * Typing, and the hash of the text it was typed over. A draft outlives that text, so a reopen compares
 * the two rather than landing the typing over whatever the file holds now.
 */
internal data class HeldDraft(val base: String, val text: String)

/**
 * Remove 2026-09-26. The base of a draft written before bases were kept: no hash equals it, so the typing
 * comes back stale and a save of it is refused rather than landing over whatever moved meanwhile.
 */
internal const val UNKNOWN_BASE = "unknown-base"

/**
 * Unsaved window and raw file text, on disk, so a restart costs the owner nothing.
 *
 * ONE FILE PER DRAFT: a combined file would rewrite every draft on every keystroke batch, which is
 * what `RunbookManager` pays by serialising its library into one preferences string.
 *
 * Nothing indexes the files; a listing would be a second source of truth about which windows exist.
 *
 * Every touch goes through one queue, reads included, so a save asked for before a clear cannot land
 * after it and leave the file holding text the window has already dropped. A caller says what the
 * draft is and never when the disk gets there, so the two cannot be ordered wrongly from outside.
 */
internal class WorkspaceDraftStore(private val dir: File, scope: CoroutineScope) {
	private val work = Channel<() -> Unit>(Channel.UNLIMITED)

	private sealed interface Intent {
		data class Hold(val draft: HeldDraft) : Intent

		data object Drop : Intent
	}

	/**
	 * The newest intent per file, taken by whichever queued job reaches it first. Typing that outruns the
	 * disk writes a whole file once rather than once per keystroke, and still lands in asked order.
	 */
	private val intents = ConcurrentHashMap<String, Intent>()

	init {
		scope.launch {
			try {
				for (job in work) run(job)
			} finally {
				// Shut before drained, so nothing waits on a worker that has gone.
				work.close()
				while (true) run(work.tryReceive().getOrNull() ?: break)
			}
		}
	}

	/** Guarded, or one throw ends the worker and leaves the queue dead. */
	private fun run(job: () -> Unit) {
		runCatching { job() }.onFailure { DebugLog.log("Drafts", "draft work failed: ${it.message}") }
	}

	/** Onto the queue, or on the caller once the queue is shut. An unbounded send refuses nothing else. */
	private fun hand(job: () -> Unit) {
		if (work.trySend(job).isFailure) run(job)
	}

	/**
	 * Hashed because a symbol id carries spaces, slashes and parentheses, none of them a filename. A file
	 * key nests one level deeper, so no span key can spell it.
	 */
	private fun fileFor(target: WorkspaceTarget, key: DraftKey): File {
		val name = when (key) {
			is DraftKey.Span -> separated(target.key, key.symbolId)
			is DraftKey.File -> separated(separated(target.key, "file"), key.path)
		}
		val digest = MessageDigest.getInstance("SHA-256").digest(name.toByteArray())
		return File(dir, digest.joinToString("") { "%02x".format(it) } + ".draft")
	}

	// Remove 2026-09-26, with `UNKNOWN_BASE`: a draft from before bases were kept, named without the extension.
	private fun legacyOf(file: File): File = File(file.parentFile, file.nameWithoutExtension)

	/**
	 * The fallback is for a throwing job alone, since `hand` leaves nothing unrun. Logged on the way
	 * past, or an unreadable draft answers as no draft and the owner's typing goes without a word.
	 */
	private suspend fun <T> queued(fallback: T, job: () -> T): T {
		val answer = CompletableDeferred<T>()
		hand {
			answer.complete(
				runCatching { job() }
					.onFailure { DebugLog.log("Drafts", "draft work failed: ${it.message}") }
					.getOrDefault(fallback),
			)
		}
		return answer.await()
	}

	private fun settle(file: File, intent: Intent) {
		intents[file.name] = intent
		hand { intents.remove(file.name)?.let { perform(file, it) } }
	}

	/**
	 * Write-then-rename, so a kill mid-write leaves the previous draft rather than half of this one.
	 * Deleting first to make room is the one choice with a window holding neither copy.
	 *
	 * Nothing is caught here: a full disk and a refused rename both have to reach the log, or a lost
	 * draft reads exactly like a saved one. The temp file is cleaned up either way, best effort.
	 */
	private fun perform(final: File, intent: Intent) {
		val legacy = legacyOf(final)
		when (intent) {
			is Intent.Hold -> {
				val base = intent.draft.base
				check(base.isNotEmpty() && '\n' !in base) { "a draft base is empty or holds a line break" }
				dir.mkdirs()
				val tmp = File(final.parentFile, "${final.name}.part")
				try {
					tmp.writeText("$base\n${intent.draft.text}")
					check(tmp.renameTo(final)) { "rename refused" }
				} finally {
					tmp.delete()
				}
				legacy.delete()
			}
			Intent.Drop -> {
				check(final.delete() || !final.exists()) { "a draft would survive its window" }
				check(legacy.delete() || !legacy.exists()) { "a draft would survive its window" }
			}
		}
	}

	fun save(target: WorkspaceTarget, key: DraftKey, draft: HeldDraft) {
		settle(fileFor(target, key), Intent.Hold(draft))
	}

	/** Null for no draft, which a caller reads as the text being untouched. */
	suspend fun load(target: WorkspaceTarget, key: DraftKey): HeldDraft? =
		queued(null) {
			val file = fileFor(target, key)
			val legacy = legacyOf(file)
			when {
				file.isFile -> file.readText().let { HeldDraft(it.substringBefore('\n').ifEmpty { UNKNOWN_BASE }, it.substringAfter('\n')) }
				legacy.isFile -> HeldDraft(base = UNKNOWN_BASE, text = legacy.readText())
				else -> null
			}
		}

	/**
	 * Called once a draft has been saved or abandoned, so a closed window leaves nothing behind. Absent
	 * is the ordinary case; a file that survives is text a reopen would put back, so it reaches the log.
	 */
	fun clear(target: WorkspaceTarget, key: DraftKey) {
		settle(fileFor(target, key), Intent.Drop)
	}

	/** A re-provision: no key is known for the previous owner's drafts, so the directory goes. */
	suspend fun clearAll() {
		queued(Unit) { check(dir.deleteRecursively() || !dir.exists()) { "the previous owner's drafts stayed" } }
	}
}
