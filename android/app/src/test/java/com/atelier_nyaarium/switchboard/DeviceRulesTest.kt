package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantHomeReport
import com.atelier_nyaarium.switchboard.proto.DeviceCandidate
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSchedule
import com.atelier_nyaarium.switchboard.proto.DeviceScheduleRule
import com.atelier_nyaarium.switchboard.proto.KasaClock
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.time.OffsetDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun rule(time: String, days: List<Boolean> = List(7) { true }) =
	DeviceScheduleRule(id = "r-$time", days = days, time = time, action = "on", enabled = true)

private val lamp = DeviceRecord(id = "aa:bb:cc:dd:ee:01", name = "Lamp", kind = "switch", driver = "kasa", address = "10.0.0.1", revision = 2L)

class DeviceRulesTest {
	@Test
	fun `a draft edits rules by position and keeps the plug's ids`() {
		val draft = scheduleDraftOf(DeviceSchedule(enabled = true, rules = listOf(rule("07:00"), rule("22:00"))))
		val toggled = draft.dayToggled(1, 0)
		assertEquals(List(7) { it != 0 }, toggled.rules[1].days)
		assertEquals(draft.rules[0], toggled.rules[0])
		val edited = draft.withAction(0, Protocol.Wire.DeviceScheduleAction.OFF).removed(1).added()
		assertEquals(listOf("r-07:00", null), edited.toSchedule().rules.map { it.id })
		assertEquals("off", edited.rules[0].action)
		assertEquals("18:00", edited.rules[1].time)
	}

	@Test
	fun `a rule with no day is not savable, and a full schedule adds nothing`() {
		val noDays = scheduleDraftOf(DeviceSchedule(enabled = true, rules = listOf(rule("07:00", List(7) { false }))))
		assertFalse(noDays.savable)
		assertTrue(scheduleDraftOf(DeviceSchedule(enabled = true, rules = listOf(rule("07:00")))).savable)
		val full = ScheduleDraft(true, List(Protocol.DEVICE_MAX_RULES) { rule("%02d:00".format(it % 24)) })
		assertTrue(full.full)
		assertEquals(full, full.added())
	}

	@Test
	fun `the plug clock reads as drift from the read instant`() {
		val readAt = OffsetDateTime.parse("2026-11-02T18:00:00-08:00").toInstant().toEpochMilli()
		fun line(time: String) = clockLine(KasaClock(time = time, zone = "PST8PDT"), readAt)
		assertEquals("Clock: in sync (PST8PDT)", line("2026-11-02T18:00:20-08:00"))
		assertEquals("Clock: 4 min ahead (PST8PDT)", line("2026-11-02T18:03:59-08:00"))
		assertEquals("Clock: 3 h behind (PST8PDT)", line("2026-11-02T15:00:00-08:00"))
		assertEquals("Clock: in sync (PST8PDT)", line("2026-11-03T02:00:00Z"))
	}

	@Test
	fun `days read as the common shapes, then by name`() {
		assertEquals("Every day", daysText(List(7) { true }))
		assertEquals("Weekdays", daysText(List(7) { it in 1..5 }))
		assertEquals("Weekends", daysText(List(7) { it == 0 || it == 6 }))
		assertEquals("Mon Wed", daysText(List(7) { it == 1 || it == 3 }))
	}

	@Test
	fun `the switch line says when it shows the last known state`() {
		assertEquals("Reading", liveLine(null))
		assertEquals("On", liveLine(DeviceLive("on")))
		assertEquals("Off · last known", liveLine(DeviceLive("off", stale = true)))
	}

	@Test
	fun `power is known once confirmed or flipped, and never guessed`() {
		assertNull(null.knownOn())
		assertNull(DeviceLive("unknown", failed = "The plug did not answer").knownOn())
		assertEquals(false, DeviceLive("off", stale = true).knownOn())
		assertEquals(true, DeviceLive("unknown", pending = true).knownOn())
	}

	@Test
	fun `a rename needs a different name that fits`() {
		assertFalse(renameReady("  Lamp ", lamp))
		assertFalse(renameReady("   ", lamp))
		assertFalse(renameReady("x".repeat(65), lamp))
		assertTrue(renameReady("Desk lamp", lamp))
	}

	@Test
	fun `a device page resolves back to Integrations once its plug is no longer listed`() {
		val page = AssistantPage.Device("sakura", lamp.id)
		val state = ChatState()
		assertEquals(page, page.resolved(state) { DeviceListView.Listed(listOf(lamp), 1L) })
		assertEquals(page, page.resolved(state) { DeviceListView.Loading })
		assertEquals(AssistantPage.Integrations, page.resolved(state) { DeviceListView.Listed(emptyList(), 2L) })
		val movedAway = ChatState(
			assistantHome = AssistantHome.Read(
				AssistantHomeRecord(version = 1L, gatewayId = "mikan"),
				AssistantHomeReport(version = 1L, gatewayId = "mikan", outcome = "placed"),
			),
		)
		assertEquals(AssistantPage.Integrations, page.resolved(movedAway) { DeviceListView.Listed(listOf(lamp), 1L) })
		assertEquals(page, pageOf(pageWords(page)))
		assertEquals(AssistantPage.Integrations, assistantPageBack(page))
	}

	@Test
	fun `found plugs are offered only beside a known list, and a write's reason outranks a read's`() {
		val fan = DeviceCandidate("aa:bb:cc:dd:ee:02", "10.0.0.2", "Fan", "HS103", "3.0", "1.0.3")
		val found = DevicesView(scan = ScanView.Found(listOf(fan)))
		assertNull(found.addable())
		assertEquals(listOf(fan), found.copy(list = DeviceListView.Listed(listOf(lamp), 1L)).addable())
		val failedPlug = Plug(1L, live = DeviceLive("unknown", failed = "The plug did not answer"))
		val failed = DevicesView(plugs = mapOf(lamp.id to failedPlug))
		assertEquals("The plug did not answer", failed.alert(lamp.id))
		assertEquals("Changed elsewhere", failed.copy(work = mapOf(lamp.id to Work(said = "Changed elsewhere"))).alert(lamp.id))
	}
}
