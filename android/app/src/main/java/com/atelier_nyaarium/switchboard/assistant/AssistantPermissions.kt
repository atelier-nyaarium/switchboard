package com.atelier_nyaarium.switchboard.assistant

import android.Manifest
import com.atelier_nyaarium.switchboard.CapabilityAvailability
import com.atelier_nyaarium.switchboard.PhoneCapabilityBinding
import com.atelier_nyaarium.switchboard.assistantSetupLine

////////////////////////////////
//  Interfaces & Types

internal enum class PermissionDoor { REQUEST, APP_SETTINGS, LISTENER_SETTINGS }

/** Row destinations. */
internal enum class PhoneSettingDoor { PICKER, NOTIFICATIONS, NOTIFICATION_PAGE }

internal data class PhoneSettingFacts(
	val roleHeld: Boolean,
	val sessionAdopted: Boolean,
	val screenData: Boolean,
	val notifications: Boolean,
) {
	val assistantOn: Boolean get() = roleHeld && sessionAdopted
}

internal data class PhoneSettingRow(val label: String, val on: Boolean, val offWord: String, val door: PhoneSettingDoor)

internal data class FeatureRow(val key: String, val label: String, val guarded: Boolean, val needs: List<String>)

/** `wanted` survives a revoke. */
internal data class FeatureView(
	val row: FeatureRow,
	val wanted: Boolean,
	val granted: Boolean,
	val missing: List<String> = emptyList(),
) {
	val on: Boolean get() = wanted && granted
	val lost: Boolean get() = wanted && !granted
}

internal sealed interface GearTarget {
	data class Need(val need: String) : GearTarget

	data object AppSettings : GearTarget
}

/** Optional settings gear. */
internal data class FeatureRowModel(val switchEnabled: Boolean, val gear: GearTarget?)

private const val NOTIFICATIONS_NEED = "notifications"

////////////////////////////////
//  Functions & Helpers

internal fun manifestPermissionOf(need: String): String? = when (need) {
	"contacts" -> Manifest.permission.READ_CONTACTS
	"calendar" -> Manifest.permission.READ_CALENDAR
	"send_sms" -> Manifest.permission.SEND_SMS
	"call_phone" -> Manifest.permission.CALL_PHONE
	NOTIFICATIONS_NEED -> Manifest.permission.POST_NOTIFICATIONS
	"notification_access" -> null
	else -> null
}

internal fun needLabel(need: String): String = when (need) {
	"contacts" -> "Contacts"
	"calendar" -> "Calendar"
	"send_sms" -> "SMS"
	"call_phone" -> "Phone calls"
	NOTIFICATIONS_NEED -> "Notifications"
	"notification_access" -> "Notification access"
	else -> need
}

internal fun phoneSettingRows(facts: PhoneSettingFacts): List<PhoneSettingRow> = listOf(
	PhoneSettingRow(
		"Default assistant",
		facts.assistantOn,
		assistantSetupLine(facts.roleHeld, facts.sessionAdopted) ?: "Off",
		PhoneSettingDoor.PICKER,
	),
	PhoneSettingRow("Screen and app data", facts.screenData, "Off", PhoneSettingDoor.PICKER),
	PhoneSettingRow(
		"Notifications",
		facts.notifications,
		"Not granted",
		if (facts.notifications) PhoneSettingDoor.NOTIFICATION_PAGE else PhoneSettingDoor.NOTIFICATIONS,
	),
)

/** Registry order. */
internal fun featureRows(bindings: Collection<PhoneCapabilityBinding>): List<FeatureRow> =
	bindings.map { binding ->
		FeatureRow(
			key = binding.key,
			label = binding.label,
			guarded = binding.kind == "guarded",
			needs = binding.needs,
		)
	}

/** Row availability. */
internal fun featureViews(
	rows: List<FeatureRow>,
	wanted: Set<String>,
	grants: (String) -> CapabilityAvailability,
): List<FeatureView> =
	rows.map { row ->
		val availability = grants(row.key)
		FeatureView(row, wanted = row.key in wanted, granted = availability.available, missing = availability.missing)
	}

internal fun enabledLine(assistantRole: Boolean, screenData: Boolean, views: List<FeatureView>): String {
	val names = listOfNotNull("Assistant".takeIf { assistantRole }, "Screen data".takeIf { screenData }) +
		views.filter { it.on }.map { it.row.label }
	return "Enabled: ${names.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "none"}"
}

/** Lost-grant warning. */
internal fun lostLine(views: List<FeatureView>): String? {
	val needs = views.filter { it.lost }.flatMap { it.missing }.distinct().map(::needLabel)
	return needs.takeIf { it.isNotEmpty() }?.let { "Permission missing for: ${it.joinToString(", ")}" }
}

/** Missing-grant line. */
internal fun needsLine(view: FeatureView): String? = when {
	view.granted -> null
	view.missing.isNotEmpty() -> "Needs: ${view.missing.joinToString(", ", transform = ::needLabel)}"
	else -> "Not supported"
}

/** Require grants to enable. */
internal fun toggledWanted(view: FeatureView, on: Boolean): Boolean = on && view.granted

internal fun featureRowModel(view: FeatureView): FeatureRowModel = FeatureRowModel(
	switchEnabled = view.granted || view.wanted,
	gear = when {
		view.row.needs.isEmpty() -> null
		else -> view.missing.firstOrNull()?.let(GearTarget::Need) ?: GearTarget.AppSettings
	},
)

/** Final denial opens settings. */
internal fun askable(need: String, denied: Set<String>, rationale: Boolean): Boolean = need !in denied || rationale

internal fun permissionDoor(need: String, askable: Boolean): PermissionDoor = when {
	need == "notification_access" -> PermissionDoor.LISTENER_SETTINGS
	manifestPermissionOf(need) != null && askable -> PermissionDoor.REQUEST
	else -> PermissionDoor.APP_SETTINGS
}
