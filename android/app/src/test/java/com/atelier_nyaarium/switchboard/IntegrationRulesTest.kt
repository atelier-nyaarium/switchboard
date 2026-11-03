package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.proto.DeviceCapability
import com.atelier_nyaarium.switchboard.proto.DeviceRecord
import com.atelier_nyaarium.switchboard.proto.DeviceSettingPut
import com.atelier_nyaarium.switchboard.proto.DeviceSettings
import com.atelier_nyaarium.switchboard.proto.INTEGRATIONS
import com.atelier_nyaarium.switchboard.proto.IntegrationGroup
import com.atelier_nyaarium.switchboard.proto.KasaClock
import com.atelier_nyaarium.switchboard.proto.KasaSettingPut
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IntegrationRulesTest {
	private fun entry(id: String, title: String, gateways: List<String>? = null) = VaultEntryView(
		id = id,
		revision = 1,
		createdBy = "owner",
		createdAt = 1,
		updatedAt = 1,
		publicTitle = title,
		publicDescription = null,
		privateTitle = null,
		privateDescription = null,
		gateways = gateways,
		gatewaysUnreadable = false,
		hasValue = true,
	)

	private fun plug(id: String, name: String, driver: String = "kasa") =
		DeviceRecord(id = id, name = name, kind = "switch", driver = driver, address = "192.168.1.$id", revision = 1)

	@Test
	fun `the Add page lists what the Gateway offers, grouped in declared order, and an older Gateway offers nothing`() {
		val all = addGroups(INTEGRATIONS.map { it.id }, "")

		assertEquals(listOf(IntegrationGroup.SERVICE, IntegrationGroup.BRAND), all.map { it.group })
		assertEquals(listOf("kasa"), addGroups(listOf("kasa", "unknown"), "").flatMap { group -> group.entries.map { it.id } })
		assertTrue(addGroups(null, "").isEmpty())
		assertEquals(listOf("ifttt"), addGroups(INTEGRATIONS.map { it.id }, "ift").flatMap { group -> group.entries.map { it.id } })
		assertTrue(addGroups(INTEGRATIONS.map { it.id }, "zigbee").isEmpty())
	}

	@Test
	fun `a service is added once it holds a grant, labelled by the catalogue, and its entry offers only usable vault entries`() {
		val entries = listOf(entry("key", "Hook key"), entry("other", "Elsewhere", gateways = listOf("another")))
		val services = listOf(
			AssistantIntegration("ifttt", "IFTTT webhook", listOf("key")),
			AssistantIntegration("later", "Later", emptyList()),
		)

		val rows = serviceRows(services, entries)
		val ifttt = INTEGRATIONS.first { it.id == "ifttt" }
		val page = serviceEntry(ifttt, services, entries, "gateway")

		assertEquals(listOf("ifttt" to "IFTTT"), rows.map { it.id to it.label })
		assertTrue(rows.single().grantedLine.contains("Hook key"))
		assertEquals(listOf("key"), page?.offered?.map { it.id })
		assertEquals(listOf("key"), page?.grants)
		assertNull(serviceEntry(INTEGRATIONS.first { it.id == "kasa" }, services, entries, "gateway"))
	}

	@Test
	fun `a device row names its brand and shows a status line only while the switch cannot say the state`() {
		val record = plug("aa:bb:cc:dd:ee:01", "Light")

		assertEquals("Kasa", brandLine(record))
		assertEquals("acme", brandLine(record.copy(driver = "acme")))
		assertNull(troubleLine(DeviceLive("on")))
		assertEquals("On · last known", troubleLine(DeviceLive("on", stale = true)))
		assertEquals("Not answering", troubleLine(DeviceLive("unreachable")))
		assertNull(troubleLine(null))
		assertEquals(listOf(DeviceCapability.SWITCH), capabilitiesOf(record.copy(driver = "acme")))
		assertTrue(DeviceCapability.CLOUD in capabilitiesOf(record))
	}

	@Test
	fun `the settings line counts per type and says when nothing is added`() {
		val plugs = listOf(plug("aa:bb:cc:dd:ee:01", "Light"), plug("aa:bb:cc:dd:ee:02", "Sign"))
		val services = listOf(AssistantIntegration("ifttt", "IFTTT", listOf("key")))

		assertEquals("2 plugs · 1 service", integrationCountLine(plugs, services))
		assertEquals("1 plug", integrationCountLine(plugs.take(1), listOf(AssistantIntegration("ifttt", "IFTTT", emptyList()))))
		assertNull(integrationCountLine(emptyList(), null))
		assertEquals(listOf("Plugs"), kindGroups(plugs).map { kindTitle(it.kind) })
	}

	@Test
	fun `every declared act has a write to send, and the cloud act is offered only while the plug is bound`() {
		val declared = INTEGRATIONS.flatMap { it.acts }
		val bound = DeviceSettings.Kasa(led = true, clock = KasaClock(time = "2026-11-02T18:00:00-08:00", zone = "PST8PDT"), cloud = "bound")

		assertTrue(declared.isNotEmpty())
		for (act in declared) assertTrue(act.key, actPut(act.key) != null)
		assertNull(actPut("not-an-act"))
		assertTrue(actOffered(ACT_CLOUD_DISCONNECT, bound))
		assertEquals(false, actOffered(ACT_CLOUD_DISCONNECT, bound.copy(cloud = "disconnected")))
		assertEquals(false, actOffered(ACT_CLOUD_DISCONNECT, null))
		assertEquals(DeviceSettingPut.Kasa(KasaSettingPut.Cloud("disconnected")), actPut(ACT_CLOUD_DISCONNECT))
	}
}
