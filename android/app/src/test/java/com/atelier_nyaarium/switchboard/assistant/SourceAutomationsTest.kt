package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import org.junit.Assert.assertEquals
import org.junit.Test

class SourceAutomationsTest {
	private fun row(id: String, trigger: AutomationTrigger) = AutomationRow(
		id,
		1L,
		Automation(enabled = true, trigger = trigger, actions = listOf(AutomationAction.TellAssistant("now"))),
		sentence = id,
	)

	@Test
	fun `a source's page lists the rows its events trigger, the same rows its count counts`() {
		val rows = listOf(
			row("github-a", AutomationTrigger.Event("github", emptyList())),
			row("ifttt-a", AutomationTrigger.Event("ifttt", emptyList())),
			row("alert", AutomationTrigger.Value("threshold-a", kotlinx.serialization.json.JsonPrimitive("low"), 0L)),
			row("github-b", AutomationTrigger.Event("github", emptyList())),
		)

		assertEquals(listOf("github-a", "github-b"), triggeredBy("github", rows).map { it.id })
		assertEquals(usesOf("github", rows), triggeredBy("github", rows).size)
	}
}
