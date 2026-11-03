package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.PhoneCapabilities
import com.atelier_nyaarium.switchboard.PhoneLocation
import com.atelier_nyaarium.switchboard.assistantSetupLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AssistantPermissionsTest {
	private val rows = featureRows(PhoneCapabilities.bindings.values)
	private fun row(key: String) = rows.single { it.key == key }

	@Test
	fun featureRowsKeepRegistryOrder() {
		assertEquals(PhoneCapabilities.bindings.keys.toList(), rows.map { it.key })
	}

	@Test
	fun communicationRowsKeepTheirLabelsAndPermissionNeeds() {
		assertEquals("Text", row("sms").label)
		assertEquals(listOf("send_sms", "notifications"), row("sms").needs)
		assertEquals("Call", row("call").label)
		assertEquals(listOf("call_phone", "notifications"), row("call").needs)
	}

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
	fun aLostGrantWarnsAndSwitchesOffAndTurningOnAsksBeforeItLands() {
		val lost = FeatureView(row("contacts_search"), wanted = true, granted = false, missing = listOf("contacts"))
		val neverOn = lost.copy(wanted = false)
		val granted = lost.copy(granted = true, missing = emptyList())

		assertEquals("Permission missing for: Contacts", lostLine(listOf(lost)))
		assertEquals("Needs: Contacts", needsLine(lost))
		assertNull(lostLine(listOf(neverOn)))
		assertNotNull(needsLine(neverOn))
		assertNull(needsLine(FeatureView(row("torch"), wanted = false, granted = true)))
		assertEquals(FeatureToggle.Want(false), featureToggle(lost, on = false))
		assertEquals(FeatureToggle.Ask("contacts"), featureToggle(neverOn, on = true))
		assertEquals(FeatureToggle.Want(true), featureToggle(granted, on = true))
		assertEquals(listOf(true, true, true), listOf(lost, neverOn, granted).map(::switchEnabled))
		assertEquals(false, grantedAfterAsk(listOf(neverOn), neverOn.row.key))
		assertEquals(true, grantedAfterAsk(listOf(granted), granted.row.key))
		assertEquals(PermissionDoor.APP_SETTINGS, permissionDoor("mystery", askable = true))
		assertEquals(PermissionDoor.APP_SETTINGS, permissionDoor("contacts", askable("contacts", setOf("contacts"), rationale = false)))
		assertEquals(PermissionDoor.REQUEST, permissionDoor("contacts", askable("contacts", setOf("contacts"), rationale = true)))
	}

	@Test
	fun notificationAccessUsesItsSystemSettingsDoor() {
		val recent = FeatureView(
			row("notifications_recent"),
			wanted = true,
			granted = false,
			missing = listOf("notification_access"),
		)

		assertNull(manifestPermissionOf("notification_access"))
		assertEquals(FeatureToggle.Ask("notification_access"), featureToggle(recent.copy(wanted = false), on = true))
		assertEquals(PermissionDoor.LISTENER_SETTINGS, permissionDoor("notification_access", askable = false))
	}

	@Test
	fun aFeatureWithoutItsHardwareReadsUnsupportedAndCannotSwitchOn() {
		val unsupported = FeatureView(row("torch"), wanted = false, granted = false)

		assertEquals("Not supported", needsLine(unsupported))
		assertNull(lostLine(listOf(unsupported.copy(wanted = true))))
		assertEquals(FeatureToggle.Want(false), featureToggle(unsupported, on = true))
		assertEquals(false, switchEnabled(unsupported))
	}

	@Test
	fun phoneSettingRowsReadTheirCurrentStatusAndDestinations() {
		val held = PhoneSettingFacts(
			roleHeld = true,
			sessionAdopted = true,
			screenData = true,
			notifications = true,
			location = PhoneLocation.ON,
		)
		val unheld = held.copy(roleHeld = false)
		val unadopted = held.copy(sessionAdopted = false)
		fun setting(facts: PhoneSettingFacts, label: String) = phoneSettingRows(facts).single { it.label == label }

		assertEquals(listOf("Default assistant", "Screen and app data", "Notifications", "Location"), phoneSettingRows(held).map { it.label })
		assertEquals(listOf(true, true, true, true), phoneSettingRows(held).map { it.on })
		assertEquals(false, phoneSettingRows(unadopted).first().on)
		assertEquals(assistantSetupLine(false, true), phoneSettingRows(unheld).first().offWord)
		assertEquals(false, setting(held.copy(notifications = false), "Notifications").on)
		assertEquals(PhoneSettingDoor.NOTIFICATIONS, setting(held.copy(notifications = false), "Notifications").door)
		assertEquals(PhoneSettingDoor.NOTIFICATION_PAGE, setting(held, "Notifications").door)
		val location = mapOf(
			PhoneLocation.NOT_GRANTED to (false to PhoneSettingDoor.LOCATION),
			PhoneLocation.OFF to (false to PhoneSettingDoor.LOCATION_SETTINGS),
			PhoneLocation.ON to (true to PhoneSettingDoor.APP_SETTINGS),
		)
		for ((state, expected) in location) {
			val row = setting(held.copy(location = state), "Location")
			assertEquals(expected, row.on to row.door)
		}
	}

	@Test
	fun locationAsksForPreciseWithApproximateBeside() {
		assertEquals(PermissionDoor.REQUEST, permissionDoor(LOCATION_NEED, askable = true))
		assertEquals(
			setOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION),
			requestedPermissionsOf(LOCATION_NEED).toSet(),
		)
		assertEquals(listOf(manifestPermissionOf("contacts")), requestedPermissionsOf("contacts").toList())
		assertEquals(0, requestedPermissionsOf("notification_access").size)
	}
}
