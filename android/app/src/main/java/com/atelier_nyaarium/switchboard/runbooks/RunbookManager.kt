package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ClearsOnReprovision
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.proto.Runbook
import kotlinx.serialization.json.Json

interface RunbookStore {
	fun loadRunbooks(): String?

	fun saveRunbooks(json: String)
}

/**
 * One copy per gateway. A revision describes one gateway's record, so a single library would carry
 * one gateway's numbers into another and call the two the same runbook.
 */
class RunbookManager(private val store: RunbookStore) : ClearsOnReprovision {
	private val json = Json { ignoreUnknownKeys = true }

	private val stateLock = Any()

	@Volatile private var libraries: Map<String, List<Runbook>> = load()

	private fun load(): Map<String, List<Runbook>> {
		val raw = store.loadRunbooks() ?: return emptyMap()
		runCatching { json.decodeFromString<Map<String, List<Runbook>>>(raw) }.getOrNull()?.let { return it }
		DebugLog.log("Runbook", "stored library could not be decoded; starting empty")
		return emptyMap()
	}

	private fun libraryOf(gatewayId: String): List<Runbook> = libraries[gatewayId].orEmpty()

	fun all(gatewayId: String): List<Runbook> = libraryOf(gatewayId)

	/** Every gateway with a library. */
	fun placed(): Map<String, List<Runbook>> = libraries

	fun find(gatewayId: String, runbookId: String): Runbook? = libraryOf(gatewayId).find { it.id == runbookId }

	fun merge(gatewayId: String, incoming: List<Runbook>): List<Runbook> = synchronized(stateLock) {
		val byId = libraryOf(gatewayId).associateByTo(LinkedHashMap()) { it.id }
		for (candidate in incoming) {
			val held = byId[candidate.id]
			if (held == null || candidate.revision > held.revision) byId[candidate.id] = candidate
		}
		commit(gatewayId, byId.values.sorted())
	}

	/**
	 * Takes a record whatever its revision, because the gateway names it. `merge` cannot serve here:
	 * it keeps the higher one, and a gateway's successor is not always higher than what is held.
	 */
	fun adopt(gatewayId: String, runbook: Runbook): List<Runbook> = synchronized(stateLock) {
		val byId = libraryOf(gatewayId).associateByTo(LinkedHashMap()) { it.id }
		byId[runbook.id] = runbook
		commit(gatewayId, byId.values.sorted())
	}

	fun remove(gatewayId: String, runbookId: String): List<Runbook> = synchronized(stateLock) {
		commit(gatewayId, libraryOf(gatewayId).filterNot { it.id == runbookId })
	}

	private fun Collection<Runbook>.sorted(): List<Runbook> = sortedWith(compareBy({ it.name }, { it.id }))

	private fun commit(gatewayId: String, next: List<Runbook>): List<Runbook> {
		val candidate = libraries + (gatewayId to next)
		val written = runCatching { store.saveRunbooks(json.encodeToString(candidate)) }
		if (written.isFailure) {
			DebugLog.log("Runbook", "library could not be written: ${written.exceptionOrNull()?.message}")
			return libraryOf(gatewayId)
		}
		libraries = candidate
		return next
	}

	override suspend fun clearInMemory() {
		synchronized(stateLock) {
			libraries = emptyMap()
			runCatching { store.saveRunbooks(json.encodeToString(emptyMap<String, List<Runbook>>())) }
				.onFailure { DebugLog.log("Runbook", "library could not be cleared: ${it.message}") }
		}
	}
}
