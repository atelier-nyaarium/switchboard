package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppStateStoreRelicKeyTest {
	@Test
	fun everyRetiredKeyIsDroppedOnTheFirstOpenAndNothingElseIs() {
		val prefs = TestPreferences()
		prefs.edit().apply {
			AppStateStore.RETIRED_KEYS.forEach { putString(it, "held") }
			putString("domain_id", "d1")
			putString("not_retired", "kept")
		}.apply()

		val store = AppStateStore(java.io.File("/tmp/switchboard-test"), prefs, encrypted = true)

		assertTrue(AppStateStore.RETIRED_KEYS.isNotEmpty())
		AppStateStore.RETIRED_KEYS.forEach { assertFalse(it, prefs.contains(it)) }
		assertEquals("d1", store.loadDomainId())
		assertTrue(prefs.contains("not_retired"))
	}
}
