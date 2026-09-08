package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ClearsOnReprovision
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.proto.Runbook
import kotlinx.serialization.json.Json

interface RunbookStore {
	fun loadRunbooks(): String?

	fun saveRunbooks(json: String)
}

class RunbookManager(private val store: RunbookStore) : ClearsOnReprovision {
	private val json = Json { ignoreUnknownKeys = true }

	private val stateLock = Any()

	@Volatile private var library: List<Runbook> = load()

	private fun load(): List<Runbook> {
		val raw = store.loadRunbooks() ?: return emptyList()
		return runCatching { json.decodeFromString<List<Runbook>>(raw) }.getOrNull()
			?: emptyList<Runbook>().also { DebugLog.log("Runbook", "stored library could not be decoded; starting empty") }
	}

	fun all(): List<Runbook> = library

	fun find(runbookId: String): Runbook? = library.find { it.id == runbookId }

	fun merge(incoming: List<Runbook>): List<Runbook> = synchronized(stateLock) {
		val byId = library.associateByTo(LinkedHashMap()) { it.id }
		for (candidate in incoming) {
			val held = byId[candidate.id]
			if (held == null || candidate.revision > held.revision) byId[candidate.id] = candidate
		}
		commit(byId.values.sortedWith(compareBy({ it.name }, { it.id })))
	}

	/**
	 * Takes a record whatever its revision, because the gateway names it. `merge` cannot serve here:
	 * it keeps the higher one, and a gateway's successor is not always higher than what is held.
	 */
	fun adopt(runbook: Runbook): List<Runbook> = synchronized(stateLock) {
		val byId = library.associateByTo(LinkedHashMap()) { it.id }
		byId[runbook.id] = runbook
		commit(byId.values.sortedWith(compareBy({ it.name }, { it.id })))
	}

	fun remove(runbookId: String): List<Runbook> = synchronized(stateLock) {
		commit(library.filterNot { it.id == runbookId })
	}

	private fun commit(next: List<Runbook>): List<Runbook> {
		val written = runCatching { store.saveRunbooks(json.encodeToString(next)) }
		if (written.isFailure) {
			DebugLog.log("Runbook", "library could not be written: ${written.exceptionOrNull()?.message}")
			return library
		}
		library = next
		return next
	}

	override suspend fun clearInMemory() {
		synchronized(stateLock) {
			library = emptyList()
			runCatching { store.saveRunbooks(json.encodeToString(emptyList<Runbook>())) }
				.onFailure { DebugLog.log("Runbook", "library could not be cleared: ${it.message}") }
		}
	}
}
