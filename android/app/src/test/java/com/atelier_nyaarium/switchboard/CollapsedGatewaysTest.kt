package com.atelier_nyaarium.switchboard

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

class CollapsedGatewaysTest {
	@Test
	fun collapsedMachinesSurviveARestartAndAReprovisionClearsThem() {
		val prefs = TestPreferences()
		val dir = File("/tmp/switchboard-test")
		AppStateStore(dir, prefs, encrypted = true).collapsedGateways = setOf("dom/gw-a", "friend:dom-b")

		val restarted = AppStateStore(dir, prefs, encrypted = true)
		assertEquals(setOf("dom/gw-a", "friend:dom-b"), restarted.collapsedGateways)
		restarted.clearProvisioning()
		assertEquals(emptySet<String>(), AppStateStore(dir, prefs, encrypted = true).collapsedGateways)
	}
}
