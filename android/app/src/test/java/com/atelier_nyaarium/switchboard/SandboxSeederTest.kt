package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class SandboxSeederTest {
	@Test
	fun theSandboxRosterHoldsOneAdmittedGatewayThatNeverRegistered() {
		val registry = sandboxRegistry(listOf("sandbox", "parsing", "idle-box"), now = 5)
		assertEquals(RegistryProvenance.Current, registry.provenance)
		assertEquals(listOf("idle-box", "parsing", "sandbox", SANDBOX_NEVER_REGISTERED), registry.ids())
		assertEquals(false, registry.entry(SANDBOX_NEVER_REGISTERED)?.seen)
		assertEquals(true, registry.entry("sandbox")?.connected)
	}

	@Test
	fun theAssistantsThreadIsSeededWithoutATab() {
		val assistant = Team("local.sandbox.host.assistant", Presence.ended(), role = ASSISTANT_ROLE)
		val demo = Team("local.sandbox.host.demo", Presence.ended())
		val threads = mapOf(assistant.name to listOf(Message(false, "hi", 1L)), demo.name to listOf(Message(false, "yo", 2L)))

		assertEquals(listOf(demo.name), sandboxTabs(listOf(assistant, demo), threads))
	}
}
