package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.GatewayList
import com.atelier_nyaarium.switchboard.ListEmpty
import com.atelier_nyaarium.switchboard.emptyLine
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger

/** The rows one source's events trigger. */
internal fun triggeredBy(sourceId: String, rows: List<AutomationRow>): List<AutomationRow> =
	rows.filter { (it.automation.trigger as? AutomationTrigger.Event)?.source == sourceId }

/** The rows crossing one sensor's numbers. */
internal fun usedBy(deviceId: String, rows: List<AutomationRow>): List<AutomationRow> =
	rows.filter { (it.automation.trigger as? AutomationTrigger.Crossing)?.device == deviceId }

/** Rows, or why there are none. */
internal sealed interface UsedBy {
	data class Rows(val rows: List<AutomationRow>) : UsedBy

	data class Empty(val why: ListEmpty) : UsedBy
}

/** Answers apart. */
internal fun usesOf(gatewayId: String, list: GatewayList<AutomationRow>, pick: (List<AutomationRow>) -> List<AutomationRow>): UsedBy =
	when (list) {
		is GatewayList.Listed -> pick(list.rows).let { if (it.isEmpty()) UsedBy.Empty(ListEmpty.None) else UsedBy.Rows(it) }
		GatewayList.Unread -> UsedBy.Empty(ListEmpty.Reading)
		GatewayList.Unreachable -> UsedBy.Empty(ListEmpty.Unreachable)
		GatewayList.NotServed -> UsedBy.Empty(ListEmpty.NotServed(listOf(gatewayId)))
	}

/** Names automations left behind; an unread list gives no count. */
internal fun removeSensorLine(uses: UsedBy): String = when (uses) {
	is UsedBy.Rows -> when (uses.rows.size) {
		1 -> "Switchboard stops reading it. 1 automation uses it and will stop working."
		else -> "Switchboard stops reading it. ${uses.rows.size} automations use it and will stop working."
	}
	is UsedBy.Empty -> when (uses.why) {
		ListEmpty.None -> "Switchboard stops reading it."
		ListEmpty.NoRoster, ListEmpty.Reading, ListEmpty.Unreachable, is ListEmpty.NotServed, ListEmpty.NoGateway ->
			"Switchboard stops reading it. Any automation that uses it will stop working."
	}
}

/** A sensor's empty list; null while reading. */
internal fun sensorUsesLine(why: ListEmpty): String? = when (why) {
	ListEmpty.Reading -> null
	ListEmpty.None -> "No automation uses this sensor."
	ListEmpty.NoRoster, ListEmpty.Unreachable, is ListEmpty.NotServed, ListEmpty.NoGateway -> emptyLine(why, "automations")
}

internal fun usesLine(uses: UsedBy): String = when (uses) {
	is UsedBy.Rows -> usesText(uses.rows.size)
	is UsedBy.Empty -> when (uses.why) {
		ListEmpty.None -> usesText(0)
		ListEmpty.NoRoster, ListEmpty.Reading, ListEmpty.Unreachable, is ListEmpty.NotServed, ListEmpty.NoGateway ->
			emptyLine(uses.why, "automations")
	}
}
