package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SandboxAutomationGatewayTest {
	private var trips = 0

	private fun gateway() = SandboxAutomationGateway(now = { 1_000_000_000L }, pause = { trips += 1 })

	private suspend fun SandboxAutomationGateway.rows(gatewayId: String) =
		(list(gatewayId) as AutomationListAnswer.Listed).automations

	private fun mention(tell: String = "now") = Automation(
		enabled = true,
		trigger = AutomationTrigger.Event("github", listOf(AutomationCondition("reason", "is", "mention"))),
		actions = listOf(AutomationAction.TellAssistant(tell)),
	)

	@Test
	fun aWriteLandsOnlyOverTheRevisionItReadAndSurvivesTheReadAfterIt() = runBlocking {
		val gateway = gateway()
		val before = gateway.rows("sandbox").map { it.id }

		val added = gateway.put("sandbox", "new", mention(), 0L)
		val stale = gateway.put("sandbox", "new", mention("quietly"), 0L)
		val edited = gateway.put("sandbox", "new", mention("quietly"), 1L)

		assertEquals("GitHub: reason is mention", added.row?.sentence)
		assertEquals(listOf(false, 1L), listOf(stale.stored, stale.row?.revision))
		assertEquals(listOf(true, 2L), listOf(edited.stored, edited.revision))
		assertEquals(before + "new", gateway.rows("sandbox").map { it.id })
		assertEquals(false, gateway.delete("sandbox", "new", 1L).deleted)
		assertEquals(true, gateway.delete("sandbox", "new", 2L).deleted)
		assertEquals(before, gateway.rows("sandbox").map { it.id })
		// One shelf per Gateway.
		assertEquals(before, gateway.rows("another").map { it.id })
	}

	@Test
	fun anAlertsRowRefusesAWriteHere() = runBlocking {
		val gateway = gateway()
		val alert = gateway.rows("sandbox").first { it.device != null }

		assertEquals(false, gateway.put("sandbox", alert.id, alert.automation.copy(enabled = false), alert.revision).stored)
		assertEquals(false, gateway.delete("sandbox", alert.id, alert.revision).deleted)
	}

	@Test
	fun theSecondGatewayRefusesAsAnOlderBuildTheEmptyOneListsNoneAndEveryCallTakesARoundTrip() = runBlocking {
		val gateway = gateway()

		assertEquals(AutomationListAnswer.Refused, gateway.list(SECOND_SANDBOX_GATEWAY))
		assertEquals(false, gateway.put(SECOND_SANDBOX_GATEWAY, "new", mention(), 0L).stored)
		assertNull(gateway.preview(SECOND_SANDBOX_GATEWAY, mention().trigger))
		assertEquals(AutomationListAnswer.Listed(emptyList()), gateway.list(EMPTY_GATEWAY))
		assertEquals(AutomationListAnswer.Unreachable, gateway.list(SANDBOX_NEVER_REGISTERED))
		assertEquals(1L, gateway.preview("sandbox", mention().trigger)?.matched)
		assertEquals(6, trips)
	}
}
