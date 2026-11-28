package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.GatewayList
import com.atelier_nyaarium.switchboard.ListEmpty
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
	fun `a source's page lists the rows its events trigger, and a sensor's the crossings of its numbers`() {
		val rows = listOf(
			row("github-a", AutomationTrigger.Event("github", emptyList())),
			row("ifttt-a", AutomationTrigger.Event("ifttt", emptyList())),
			row("outside-cold", AutomationTrigger.Crossing("ce:1c", "temperature", "below", 2.0, 0.5, 600L)),
			row("freezer-warm", AutomationTrigger.Crossing("aa:11", "temperature", "above", -12.0, 0.5, 600L)),
			row("value", AutomationTrigger.Value("ce:1c", kotlinx.serialization.json.JsonPrimitive("low"), 0L)),
			row("github-b", AutomationTrigger.Event("github", emptyList())),
			row("outside-damp", AutomationTrigger.Crossing("ce:1c", "humidity", "above", 90.0, 2.0, 600L)),
		)

		assertEquals(listOf("github-a", "github-b"), triggeredBy("github", rows).map { it.id })
		assertEquals(listOf("outside-cold", "outside-damp"), usedBy("ce:1c", rows).map { it.id })
	}

	@Test
	fun `a source's page keeps each answer of its Gateway's list apart`() {
		val rows = listOf(row("github-a", AutomationTrigger.Event("github", emptyList())))
		val read = { list: GatewayList<AutomationRow>, source: String -> usesOf("sakura", list) { triggeredBy(source, it) } }

		assertEquals(UsedBy.Rows(rows), read(GatewayList.Listed(rows), "github"))
		assertEquals(
			listOf(ListEmpty.None, ListEmpty.Reading, ListEmpty.Unreachable, ListEmpty.NotServed(listOf("sakura"))),
			listOf(
				read(GatewayList.Listed(rows), "ifttt"),
				read(GatewayList.Unread, "github"),
				read(GatewayList.Unreachable, "github"),
				read(GatewayList.NotServed, "github"),
			).map { (it as UsedBy.Empty).why },
		)
		// Listed answers count.
		val counts = { uses: UsedBy -> usesLine(uses).any(Char::isDigit) }
		assertEquals(
			listOf(true, false, false, false, false),
			listOf(
				UsedBy.Rows(rows),
				UsedBy.Empty(ListEmpty.None),
				UsedBy.Empty(ListEmpty.Reading),
				UsedBy.Empty(ListEmpty.Unreachable),
				UsedBy.Empty(ListEmpty.NotServed(listOf("sakura"))),
			).map(counts),
		)
		assertEquals(listOf(true, false, false), listOf(ListEmpty.Reading, ListEmpty.None, ListEmpty.Unreachable).map { sensorUsesLine(it) == null })
		// Unknown list warns, no count.
		val warns = { uses: UsedBy -> removeSensorLine(uses).let { it.contains("automation") to it.any(Char::isDigit) } }
		assertEquals(
			listOf(true to false, true to false, true to false, false to false, true to true),
			listOf(
				UsedBy.Empty(ListEmpty.Reading),
				UsedBy.Empty(ListEmpty.Unreachable),
				UsedBy.Empty(ListEmpty.NotServed(listOf("sakura"))),
				UsedBy.Empty(ListEmpty.None),
				UsedBy.Rows(rows),
			).map(warns),
		)
	}
}
