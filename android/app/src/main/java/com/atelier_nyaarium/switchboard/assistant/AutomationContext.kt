package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.AssistantHome
import com.atelier_nyaarium.switchboard.AssistantRead
import com.atelier_nyaarium.switchboard.AutomationListing
import com.atelier_nyaarium.switchboard.ListAnswer
import com.atelier_nyaarium.switchboard.EditStanding
import com.atelier_nyaarium.switchboard.GatewayList
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.ListEmpty
import com.atelier_nyaarium.switchboard.Lookup
import com.atelier_nyaarium.switchboard.editStanding
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionServes
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger

/** Only an arrived listing says. */
internal sealed interface Served {
	data class Known(val offer: AutomationOffer) : Served

	data class Unknown(val why: ListEmpty) : Served
}

internal sealed interface HomeSources {
	/** Away from the home, none. */
	data class Known(val sources: List<AssistantSource>) : HomeSources

	data object Reading : HomeSources

	data object Refused : HomeSources
}

internal data class AutomationContext(val served: Served, val sources: HomeSources)

/** What an edit was minted with. */
internal data class EditContext(val offer: AutomationOffer, val sources: List<AssistantSource>)

/** Sole reader of serves and `away`. */
internal fun automationContext(registry: GatewayRegistry, home: AssistantHome, gatewayId: String): AutomationContext {
	val placed = when (home) {
		AssistantHome.Unread -> return AutomationContext(Served.Unknown(ListEmpty.Reading), HomeSources.Reading)
		is AssistantHome.Read -> home.record?.gatewayId
	}
	val away = gatewayId != placed
	val served = when (registry.listOn(gatewayId) { it.automations }) {
		is GatewayList.Listed -> registry.entry(gatewayId)?.let { entry ->
			entry.automationServes?.let { Served.Known(offerOf(it, away, entry.automationFunctions)) }
		} ?: Served.Unknown(ListEmpty.Reading)
		GatewayList.Unread -> Served.Unknown(ListEmpty.Reading)
		GatewayList.Unreachable -> Served.Unknown(ListEmpty.Unreachable)
		GatewayList.NotServed -> Served.Unknown(ListEmpty.NotServed(listOf(gatewayId)))
	}
	if (away) return AutomationContext(served, HomeSources.Known(emptyList()))
	val sources = when (val read = registry.assistantRead(gatewayId)) {
		is AssistantRead.Answered -> HomeSources.Known(read.state.sources)
		AssistantRead.Reading -> HomeSources.Reading
		AssistantRead.Refused -> HomeSources.Refused
	}
	return AutomationContext(served, sources)
}

/** Unheard sources mint as none. */
internal fun AutomationContext.minted(): EditContext? = when (served) {
	is Served.Known -> EditContext(served.offer, heardOr(emptyList()))
	is Served.Unknown -> null
}

/** Heard wins; held bridges unread. */
internal fun AutomationContext.over(held: EditContext): EditContext = EditContext(
	offer = when (served) {
		is Served.Known -> served.offer
		is Served.Unknown -> held.offer
	},
	sources = heardOr(held.sources),
)

private fun AutomationContext.heardOr(held: List<AssistantSource>): List<AssistantSource> = when (sources) {
	is HomeSources.Known -> sources.sources
	HomeSources.Reading, HomeSources.Refused -> held
}

private fun standingOf(why: ListEmpty): EditStanding = when (why) {
	ListEmpty.NoRoster, ListEmpty.Reading -> EditStanding.READING
	ListEmpty.Unreachable, ListEmpty.NoGateway -> EditStanding.UNREACHABLE
	is ListEmpty.NotServed -> EditStanding.NOT_SERVED
	ListEmpty.None -> EditStanding.READY
}

/** New also waits on sources. */
internal fun automationStanding(context: AutomationContext, held: Lookup<AutomationRow>?): EditStanding {
	val record = editStanding(held)
	if (record != EditStanding.READY) return record
	val served = when (val known = context.served) {
		is Served.Known -> EditStanding.READY
		is Served.Unknown -> standingOf(known.why)
	}
	return when {
		served != EditStanding.READY -> served
		held == null && context.sources == HomeSources.Reading -> EditStanding.READING
		else -> EditStanding.READY
	}
}

/** Only the home takes an event automation. */
internal fun opensIn(row: AutomationRow, context: AutomationContext): Boolean = when (val served = context.served) {
	is Served.Known -> editable(row, served.offer) && (!served.offer.away || row.automation.trigger !is AutomationTrigger.Event)
	is Served.Unknown -> false
}

/** Whether New can start watching that device. */
internal fun offersWatch(deviceId: String, context: AutomationContext): Boolean = when (val served = context.served) {
	is Served.Known -> newAutomationDraft(EditContext(served.offer, emptyList()), watch = deviceId) != null
	is Served.Unknown -> false
}

/** Unread home: none. Unread list: waits. */
internal fun newAutomationGateways(registry: GatewayRegistry, reachable: List<String>, home: AssistantHome): List<String> {
	if (home == AssistantHome.Unread) return emptyList()
	return reachable.filter { id ->
		val context = automationContext(registry, home, id)
		when (val served = context.served) {
			is Served.Known -> context.sources == HomeSources.Reading || context.minted()?.let(::newAutomationDraft) != null
			is Served.Unknown -> served.why == ListEmpty.Reading
		}
	}
}

/** What a Gateway says of functions; unread is never none. */
internal sealed interface FunctionsServed {
	data class Serves(val served: AutomationFunctionServes) : FunctionsServed

	data object None : FunctionsServed

	data object Reading : FunctionsServed

	data object Unreachable : FunctionsServed
}

internal fun functionsServed(registry: GatewayRegistry, home: AssistantHome, gatewayId: String): FunctionsServed =
	when (val served = automationContext(registry, home, gatewayId).served) {
		is Served.Known -> served.offer.functions?.served?.let(FunctionsServed::Serves) ?: FunctionsServed.None
		is Served.Unknown -> when (served.why) {
			ListEmpty.NoRoster, ListEmpty.Reading, ListEmpty.None -> FunctionsServed.Reading
			ListEmpty.Unreachable, ListEmpty.NoGateway -> FunctionsServed.Unreachable
			// An older build lists none.
			is ListEmpty.NotServed -> FunctionsServed.None
		}
	}

/** A kind's label there. */
internal fun actionLabelOn(registry: GatewayRegistry, home: AssistantHome, gatewayId: String): (String) -> String? =
	when (val served = automationContext(registry, home, gatewayId).served) {
		is Served.Known -> { kind -> served.offer.actions.find { it.kind == kind }?.label }
		is Served.Unknown -> { _ -> null }
	}

/** A fresh listing's word. */
internal fun functionsServedBy(listing: AutomationListing?): FunctionsServed = when (listing?.rows) {
	is ListAnswer.Listed -> listing.serves?.functions?.let(FunctionsServed::Serves) ?: FunctionsServed.None
	ListAnswer.NotServed -> FunctionsServed.None
	ListAnswer.Unreachable, null -> FunctionsServed.Unreachable
}

/** Unknown names kinds raw. */
internal fun doesText(automation: Automation, served: Served): String = when (served) {
	is Served.Known -> written(automation).joinToString(" · ") { action ->
		actionLine(action, served.offer) + if (homeOnly(kindOf(action), served.offer)) " (only where the assistant lives)" else ""
	}
	is Served.Unknown -> written(automation).joinToString(" · ") { action -> kindOf(action) }
}
