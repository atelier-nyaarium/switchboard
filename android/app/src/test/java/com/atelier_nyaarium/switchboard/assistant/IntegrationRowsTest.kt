package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IntegrationRowsTest {
	private fun entry(
		id: String,
		title: String,
		hasValue: Boolean = true,
		gateways: List<String>? = null,
		gatewaysUnreadable: Boolean = false,
	) = VaultEntryView(
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
		gatewaysUnreadable = gatewaysUnreadable,
		hasValue = hasValue,
	)

	@Test
	fun rowsRenderGrantLinesAndOnlyOfferUsableEntries() {
		val entries = listOf(
			entry("key", "IFTTT key"),
			entry("empty", "Empty", hasValue = false),
			entry("other", "Other", gateways = listOf("another")),
			entry("locked", "Locked", gatewaysUnreadable = true),
		)
		val integrations = listOf(
			AssistantIntegration("ifttt", "IFTTT webhook", listOf("key", "missing")),
		)

		val rows = integrationRows(integrations, entries, "gateway")

		assertEquals(listOf("ifttt"), rows.map { it.integration.id })
		assertTrue(rows.single().grantedLine.contains("IFTTT key"))
		assertTrue(rows.single().grantedLine.contains("1 no longer in the vault"))
		assertEquals(listOf("key"), rows.single().offered.map { it.id })
		assertEquals(rows.single(), integrationRowForGrant(rows, "ifttt"))
		assertEquals(null, integrationRowForGrant(rows, "missing"))
	}

	@Test
	fun missingPlacementOrIntegrationsProducesNoRows() {
		val entries = listOf(entry("key", "IFTTT key"))
		val integration = AssistantIntegration("ifttt", "IFTTT webhook", listOf("key"))

		assertTrue(integrationRows(listOf(integration), entries, null).isEmpty())
		assertTrue(integrationRows(null, entries, "gateway").isEmpty())
	}
}
