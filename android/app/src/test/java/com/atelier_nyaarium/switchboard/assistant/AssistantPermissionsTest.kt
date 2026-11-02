package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.PhoneCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AssistantPermissionsTest {
	private val rows = featureRows(PhoneCapabilities.bindings.values)
	private fun row(key: String) = rows.single { it.key == key }

	@Test
	fun theIndexLineNamesTheRoleAndEveryFeatureThatIsOnAndGranted() {
		val views = listOf(
			FeatureView(row("status"), wanted = true, granted = true),
			FeatureView(row("torch"), wanted = false, granted = true),
			FeatureView(row("contacts_search"), wanted = true, granted = false),
		)

		assertEquals("Enabled: Assistant, Screen data, Phone status", enabledLine(assistantRole = true, screenData = true, views))
		assertEquals("Enabled: none", enabledLine(assistantRole = false, screenData = false, views.map { it.copy(wanted = false) }))
	}

	@Test
	fun aLostGrantWarnsAndSwitchesOffButNotBackOnUntilGranted() {
		val lost = FeatureView(row("contacts_search"), wanted = true, granted = false, missing = listOf("contacts"))
		val neverOn = lost.copy(wanted = false)
		val granted = lost.copy(granted = true, missing = emptyList())

		assertEquals("Permission missing for: Contacts", lostLine(listOf(lost)))
		assertNull(lostLine(listOf(neverOn)))
		assertNotNull(needsLine(neverOn))
		assertNull(needsLine(FeatureView(row("torch"), wanted = false, granted = true)))
		assertEquals(false, toggledWanted(lost, on = false))
		assertEquals(false, toggledWanted(neverOn, on = true))
		assertEquals(true, toggledWanted(granted, on = true))
		assertEquals(FeatureRowModel(switchEnabled = true, gear = GearTarget.Need("contacts")), featureRowModel(lost))
		assertEquals(FeatureRowModel(switchEnabled = false, gear = GearTarget.Need("contacts")), featureRowModel(neverOn))
		assertEquals(FeatureRowModel(switchEnabled = true, gear = GearTarget.AppSettings), featureRowModel(granted))
		assertNull(featureRowModel(FeatureView(row("status"), wanted = false, granted = true)).gear)
		assertEquals("Phone", row("torch").group)
		assertEquals(PermissionDoor.APP_SETTINGS, permissionDoor("mystery", askable = true))
		assertEquals(PermissionDoor.APP_SETTINGS, permissionDoor("contacts", askable("contacts", setOf("contacts"), rationale = false)))
		assertEquals(PermissionDoor.REQUEST, permissionDoor("contacts", askable("contacts", setOf("contacts"), rationale = true)))
	}

	@Test
	fun aFeatureWithoutItsHardwareReadsUnsupportedAndCannotSwitchOn() {
		val unsupported = FeatureView(row("torch"), wanted = false, granted = false)

		assertNotNull(needsLine(unsupported))
		assertNull(lostLine(listOf(unsupported.copy(wanted = true))))
		assertEquals(false, toggledWanted(unsupported, on = true))
		assertEquals(false, featureRowModel(unsupported).switchEnabled)
	}

	@Test
	fun theRequiredRowsReadOffWithTheSetupStepUntilEveryFactHolds() {
		val held = RequiredFacts(roleHeld = true, sessionAdopted = true, screenData = true, notifications = true)
		val unheld = held.copy(roleHeld = false)
		val unadopted = held.copy(sessionAdopted = false)

		assertEquals(listOf(true, true, true), requiredRows(held).map { it.on })
		assertEquals(false, requiredRows(unadopted).first().on)
		assertNotNull(requiredRows(unheld).first().offWord)
		assertEquals(false, requiredRows(held.copy(notifications = false)).last().on)
		assertEquals(RequiredDoor.NOTIFICATIONS, requiredRows(held.copy(notifications = false)).last().door)
		assertEquals(RequiredDoor.NOTIFICATION_PAGE, requiredRows(held).last().door)
	}
}
