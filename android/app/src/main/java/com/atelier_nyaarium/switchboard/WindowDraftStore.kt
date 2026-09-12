package com.atelier_nyaarium.switchboard

import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * Unsaved window text, on disk, so a restart costs the owner nothing.
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
internal class WindowDraftStore(private val dir: File, scope: CoroutineScope) {
	private val work = Channel<() -> Unit>(Channel.UNLIMITED)

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

	/** Hashed because a symbol id carries spaces, slashes and parentheses, none of them a filename. */
	private fun fileFor(target: WorkspaceTarget, symbolId: String): File {
		val digest = MessageDigest.getInstance("SHA-256").digest(separated(target.key, symbolId).toByteArray())
		return File(dir, digest.joinToString("") { "%02x".format(it) })
	}

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

	/**
	 * Write-then-rename, so a kill mid-write leaves the previous draft rather than half of this one.
	 * Deleting first to make room is the one choice with a window holding neither copy.
	 *
	 * Nothing is caught here: a full disk and a refused rename both have to reach the log, or a lost
	 * draft reads exactly like a saved one. The temp file is cleaned up either way, best effort.
	 */
	fun save(target: WorkspaceTarget, symbolId: String, text: String) {
		hand {
			dir.mkdirs()
			val final = fileFor(target, symbolId)
			val tmp = File(final.parentFile, "${final.name}.part")
			try {
				tmp.writeText(text)
				check(tmp.renameTo(final)) { "rename refused" }
			} finally {
				tmp.delete()
			}
		}
	}

	/** Null for no draft, which a caller reads as the span being untouched. */
	suspend fun load(target: WorkspaceTarget, symbolId: String): String? =
		queued(null) {
			val file = fileFor(target, symbolId)
			if (file.isFile) file.readText() else null
		}

	/**
	 * Called once a draft has been saved or abandoned, so a closed window leaves nothing behind. Absent
	 * is the ordinary case; a file that survives is text a reopen would put back, so it reaches the log.
	 */
	fun clear(target: WorkspaceTarget, symbolId: String) {
		hand {
			val file = fileFor(target, symbolId)
			check(file.delete() || !file.exists()) { "a draft would survive its window" }
		}
	}

	/** A re-provision: no key is known for the previous owner's drafts, so the directory goes. */
	suspend fun clearAll() {
		queued(Unit) { check(dir.deleteRecursively() || !dir.exists()) { "the previous owner's drafts stayed" } }
	}
}
