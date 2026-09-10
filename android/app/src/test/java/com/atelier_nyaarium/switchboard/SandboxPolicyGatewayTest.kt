package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

// The read after a mutation drew the old fixture once, and only the emulator's screen could see it.
class SandboxPolicyGatewayTest {
	private suspend fun SandboxPolicyGateway.ids(gatewayId: String) =
		(list(gatewayId) as PolicyListAnswer.Listed).policies.map { it.id }

	@Test
	fun aMutationSurvivesTheReadAfterItAndTheRefusingIdRefuses() = runBlocking {
		val gateway = SandboxPolicyGateway()
		val before = gateway.ids("sandbox")
		val docker = (gateway.list("sandbox") as PolicyListAnswer.Listed).policies.first { it.id == "docker" }
		assertEquals(false, docker.enabled)

		assertEquals(true, gateway.enable("sandbox", "docker", true, docker.revision).stored)
		val after = (gateway.list("sandbox") as PolicyListAnswer.Listed).policies
		assertEquals(before, after.map { it.id })
		assertEquals(true, after.first { it.id == "docker" }.enabled)

		assertEquals(true, gateway.delete("sandbox", "docker", docker.revision + 1).deleted)
		assertEquals(before - "docker", gateway.ids("sandbox"))
		// One shelf per Gateway.
		assertEquals(before, gateway.ids("another"))

		assertEquals(false, gateway.enable("sandbox", "held-elsewhere", false, 2L).stored)
		assertEquals(false, gateway.delete("sandbox", "held-elsewhere", 2L).deleted)
		assertEquals(true, "held-elsewhere" in gateway.ids("sandbox"))
	}
}
