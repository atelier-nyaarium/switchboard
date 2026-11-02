package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

interface FeatureToggleStore {
	fun loadAssistantFeatures(): String?
	fun saveAssistantFeatures(json: String): Boolean
}

internal class FeatureToggles(private val store: FeatureToggleStore) {
	private val serializer = ListSerializer(String.serializer())
	private val _wanted = MutableStateFlow(load())
	val wanted: StateFlow<Set<String>> = _wanted.asStateFlow()

	private fun load(): Set<String> =
		store.loadAssistantFeatures()
			?.let { raw -> runIsolated { wireJson.decodeFromString(serializer, raw) }.getOrNull() }
			?.toSet()
			.orEmpty()

	fun isWanted(key: String): Boolean = key in _wanted.value

	/** Persisted before it shows. */
	fun setWanted(key: String, on: Boolean): Boolean {
		val next = if (on) _wanted.value + key else _wanted.value - key
		if (next == _wanted.value) return true
		val saved = runIsolated { store.saveAssistantFeatures(wireJson.encodeToString(serializer, next.sorted())) }
			.getOrDefault(false)
		if (saved) _wanted.value = next
		return saved
	}

	fun clear() {
		_wanted.value = emptySet()
	}
}
