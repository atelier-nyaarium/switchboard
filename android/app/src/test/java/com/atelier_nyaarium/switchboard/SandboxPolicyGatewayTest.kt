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

		// A save over the revision it named lands, and the record is an ordinary one after.
		val moved = (gateway.list("sandbox") as PolicyListAnswer.Listed).policies.first { it.id == "held-elsewhere" }
		val over = gateway.put("sandbox", moved.copy(revision = 9L), 9L)
		assertEquals(true, over.stored)
		assertEquals(true, gateway.enable("sandbox", "held-elsewhere", false, over.revision).stored)
		assertEquals(true, gateway.delete("sandbox", "held-elsewhere", over.revision + 1).deleted)
	}

	@Test
	fun aStaleBaseIsRefusedWithTheHeldRevisionAsTheGatewayWould() = runBlocking {
		val gateway = SandboxPolicyGateway()
		val apt = (gateway.list("sandbox") as PolicyListAnswer.Listed).policies.first { it.id == "apt" }

		val refused = gateway.enable("sandbox", "apt", false, apt.revision - 1)
		assertEquals(false, refused.stored)
		assertEquals(apt.revision, refused.revision)
		assertEquals(true, (gateway.list("sandbox") as PolicyListAnswer.Listed).policies.first { it.id == "apt" }.enabled)

		assertEquals(false, gateway.put("sandbox", apt.copy(name = "Renamed"), null).stored)
		assertEquals(false, gateway.delete("sandbox", "apt", apt.revision + 5).deleted)
		assertEquals(true, gateway.enable("sandbox", "apt", false, apt.revision).stored)
	}
}
