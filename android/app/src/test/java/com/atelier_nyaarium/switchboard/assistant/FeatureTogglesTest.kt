package com.atelier_nyaarium.switchboard.assistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureTogglesTest {
	@Test
	fun aSwitchShowsOnlyOnceStoredAndAMalformedStoreReadsAsNothingOn() {
		val store = MemoryStore(raw = "not json")
		val toggles = FeatureToggles(store)
		assertEquals(emptySet<String>(), toggles.wanted.value)

		assertTrue(toggles.setWanted("torch", true))
		assertTrue(toggles.isWanted("torch"))
		assertEquals(setOf("torch"), FeatureToggles(store).wanted.value)

		store.writable = false
		assertFalse(toggles.setWanted("status", true))
		assertFalse(toggles.isWanted("status"))
	}

	private class MemoryStore(var raw: String?, var writable: Boolean = true) : FeatureToggleStore {
		override fun loadAssistantFeatures(): String? = raw
		override fun saveAssistantFeatures(json: String): Boolean {
			if (!writable) return false
			raw = json
			return true
		}
	}
}
