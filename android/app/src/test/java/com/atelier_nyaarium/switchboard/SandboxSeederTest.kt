package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class SandboxSeederTest {
	@Test
	fun sandboxSeedCarriesTheHomeGatewayFromTheTeamIntoStateInput() {
		assertEquals("home", sandboxHomeGateway("domain.home.session", "old"))
	}

	@Test
	fun theSandboxRosterHoldsOneAdmittedGatewayThatNeverRegistered() {
		val registry = sandboxRegistry(listOf("sandbox", "parsing", "idle-box"), now = 5)
		assertEquals(RegistryProvenance.Current, registry.provenance)
		assertEquals(listOf("idle-box", "parsing", "sandbox", SANDBOX_NEVER_REGISTERED), registry.ids())
		assertEquals(false, registry.entry(SANDBOX_NEVER_REGISTERED)?.seen)
		assertEquals(true, registry.entry("sandbox")?.connected)
	}
}
