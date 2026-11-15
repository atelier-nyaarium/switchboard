package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.GatewayList
import com.atelier_nyaarium.switchboard.ListEmpty
import com.atelier_nyaarium.switchboard.emptyLine
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger

/** The rows one source's events trigger. */
internal fun triggeredBy(sourceId: String, rows: List<AutomationRow>): List<AutomationRow> =
	rows.filter { (it.automation.trigger as? AutomationTrigger.Event)?.source == sourceId }

/** The rows crossing one device's numbers. */
internal fun watching(deviceId: String, rows: List<AutomationRow>): List<AutomationRow> =
	rows.filter { (it.automation.trigger as? AutomationTrigger.Crossing)?.device == deviceId }

/** Whether New can start watching that device. */
internal fun offersWatch(deviceId: String, offer: AutomationOffer): Boolean =
	newAutomationDraft(emptyList(), offer, watch = deviceId) != null

/** Rows, or why there are none. */
internal sealed interface UsedBy {
	data class Rows(val rows: List<AutomationRow>) : UsedBy

	data class Empty(val why: ListEmpty) : UsedBy
}

/** Answers kept apart. */
internal fun usedBy(gatewayId: String, list: GatewayList<AutomationRow>?, pick: (List<AutomationRow>) -> List<AutomationRow>): UsedBy =
	when (list) {
		is GatewayList.Listed -> pick(list.rows).let { if (it.isEmpty()) UsedBy.Empty(ListEmpty.None) else UsedBy.Rows(it) }
		GatewayList.Unread, null -> UsedBy.Empty(ListEmpty.Reading)
		GatewayList.Unreachable -> UsedBy.Empty(ListEmpty.Unreachable)
		GatewayList.NotServed -> UsedBy.Empty(ListEmpty.NotServed(listOf(gatewayId)))
	}

/** Names automations left behind; an unread list gives no count. */
internal fun removeSensorLine(uses: UsedBy): String = when {
	uses is UsedBy.Rows && uses.rows.size == 1 -> "Switchboard stops reading it. 1 automation watches it and will stop working."
	uses is UsedBy.Rows -> "Switchboard stops reading it. ${uses.rows.size} automations watch it and will stop working."
	uses == UsedBy.Empty(ListEmpty.None) -> "Switchboard stops reading it."
	else -> "Switchboard stops reading it. Any automation watching it will stop working."
}

/** A sensor's empty list; null while reading. */
internal fun watchingEmptyLine(why: ListEmpty): String? = when (why) {
	ListEmpty.Reading -> null
	ListEmpty.None -> "No automation watches this sensor."
	else -> emptyLine(why, "automations")
}
