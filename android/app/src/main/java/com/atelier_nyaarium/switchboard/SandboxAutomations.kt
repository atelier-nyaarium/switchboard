package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.testLabel
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewMatch
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive

private const val AUTOMATION_ROUND_TRIP_MS = 400L
private const val OLDER_GATEWAY = "unknown op automation_put"
private const val ALERT_OWNED = "its sensor page sets this alert"
private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 60 * MINUTE_MS

/** One shelf for both hosts. */
internal val sandboxAutomations by lazy { SandboxAutomationGateway() }

private fun inSentence(label: String): String = label.replaceFirstChar { it.lowercase() }

/** As a Gateway writes it. */
internal fun sandboxSentence(automation: Automation): String {
	val trigger = automation.trigger as? AutomationTrigger.Event ?: return automation.label ?: "Automation"
	val fields = SourceFields(SANDBOX_FIELD_SPECS)
	val said = trigger.conditions.map {
		"${inSentence(fields.fieldLabelOf(it.field))} ${testLabel(it.test)} ${inSentence(fields.valueLabelOf(it.field, it.value))}"
	}
	return "GitHub: ${if (said.isEmpty()) "every event" else said.joinToString(" and ")}"
}

/** The second Gateway refuses as an older build; the empty one lists none. */
internal class SandboxAutomationGateway(
	private val now: () -> Long = System::currentTimeMillis,
	private val pause: suspend () -> Unit = { delay(AUTOMATION_ROUND_TRIP_MS) },
) : AutomationGateway {
	private val shelves = mutableMapOf<String, List<AutomationRow>>()

	private fun github(id: String, field: String, value: String, ranAgoMs: Long?): AutomationRow {
		val automation = Automation(
			enabled = true,
			trigger = AutomationTrigger.Event("github", listOf(AutomationCondition(field, "is", value))),
			actions = listOf(AutomationAction.TellAssistant("now")),
		)
		return AutomationRow(id, 1L, automation, sandboxSentence(automation), lastRanAt = ranAgoMs?.let { now() - it })
	}

	private fun alert(): AutomationRow {
		val label = "Outside thermometer temperature below 2.0 °C"
		val automation = Automation(
			label = label,
			enabled = true,
			trigger = AutomationTrigger.Value("threshold-ce1c44063c5d-temperature", JsonPrimitive("low"), 0L),
			actions = listOf(AutomationAction.TellAssistant("quietly")),
		)
		return AutomationRow(
			"threshold-ce1c44063c5d-temperature-low",
			4L,
			automation,
			label,
			lastRanAt = now() - 26 * HOUR_MS,
			device = "ce:1c:44:06:3c:5d",
		)
	}

	private fun shelf(gatewayId: String): List<AutomationRow> = shelves.getOrPut(gatewayId) {
		if (gatewayId == EMPTY_GATEWAY) {
			emptyList()
		} else {
			listOf(
				github("reviews", "reason", "review_requested", 3 * HOUR_MS),
				github("mentions", "reason", "mention", null),
				github("subscribed", "reason", "subscribed", 26 * HOUR_MS),
				github("pulls", "type", "PullRequest", 40 * MINUTE_MS),
				alert(),
			)
		}
	}

	override suspend fun list(gatewayId: String): ListAnswer<AutomationRow> {
		pause()
		return when (gatewayId) {
			SANDBOX_NEVER_REGISTERED -> ListAnswer.Unreachable
			SECOND_SANDBOX_GATEWAY -> ListAnswer.NotServed
			else -> ListAnswer.Listed(shelf(gatewayId))
		}
	}

	override suspend fun put(gatewayId: String, automationId: String, automation: Automation, baseRevision: Long): ConsoleAutomationPutResult {
		pause()
		if (gatewayId == SECOND_SANDBOX_GATEWAY) return ConsoleAutomationPutResult(stored = false, revision = 0L, reason = OLDER_GATEWAY)
		val held = shelf(gatewayId).find { it.id == automationId }
		val revision = held?.revision ?: 0L
		if (held?.device != null) return ConsoleAutomationPutResult(false, revision, held, ALERT_OWNED)
		if (revision != baseRevision) return ConsoleAutomationPutResult(false, revision, held, "revision $revision is stored")
		val row = AutomationRow(automationId, revision + 1, automation, sandboxSentence(automation), lastRanAt = held?.lastRanAt)
		shelves[gatewayId] = if (held == null) shelf(gatewayId) + row else shelf(gatewayId).map { if (it.id == automationId) row else it }
		return ConsoleAutomationPutResult(true, row.revision, row)
	}

	override suspend fun delete(gatewayId: String, automationId: String, baseRevision: Long): ConsoleAutomationDeleteResult {
		pause()
		val held = shelf(gatewayId).find { it.id == automationId } ?: return ConsoleAutomationDeleteResult(false, "not stored")
		if (held.device != null) return ConsoleAutomationDeleteResult(false, ALERT_OWNED)
		if (held.revision != baseRevision) return ConsoleAutomationDeleteResult(false, "revision ${held.revision} is stored")
		shelves[gatewayId] = shelf(gatewayId) - held
		return ConsoleAutomationDeleteResult(true)
	}

	/** Matches titles by each value. */
	override suspend fun preview(gatewayId: String, trigger: AutomationTrigger): ConsoleAutomationPreviewResult? {
		pause()
		if (gatewayId == SANDBOX_NEVER_REGISTERED || gatewayId == SECOND_SANDBOX_GATEWAY) return null
		val wanted = (trigger as? AutomationTrigger.Event)?.conditions.orEmpty().map { it.value.replace('_', ' ') }
		val recent = listOf(
			AutomationPreviewMatch("Review requested: split the pane reader", now() - 3 * HOUR_MS),
			AutomationPreviewMatch("Mention in the release thread", now() - 9 * HOUR_MS),
			AutomationPreviewMatch("Review requested: bump Bun to 1.4.2", now() - 26 * HOUR_MS),
		)
		val matches = recent.filter { match -> wanted.all { match.title.contains(it, ignoreCase = true) } }
		return ConsoleAutomationPreviewResult(matched = matches.size.toLong(), of = 50L, matches = matches)
	}
}
