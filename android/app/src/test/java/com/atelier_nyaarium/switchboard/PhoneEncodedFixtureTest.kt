package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.IntervalUnit
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.conditionOf
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.proto.AppOpenAnswer
import com.atelier_nyaarium.switchboard.proto.AssistantHomeSealed
import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.PhoneStatusAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneStatusKey
import com.atelier_nyaarium.switchboard.proto.VaultRemember
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_ONCE
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_WINDOW
import com.atelier_nyaarium.switchboard.vault.entryAnswerOp
import java.io.File
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

private const val FIXTURE = "phone-encoded/cases.json"

/**
 * What this phone encodes, as it encodes it; `phone-encoded.test.ts` parses the same file by schema.
 * Regenerate with `UPDATE_FIXTURES=1 ./gradlew :app:testDebugUnitTest --tests '*PhoneEncodedFixtureTest*'`.
 */
class PhoneEncodedFixtureTest {
	private fun source(id: String, label: String, grants: List<String>, enabled: Boolean, triggers: Boolean) = AssistantSource(
		id = id,
		label = label,
		grants = grants,
		unread = 0L,
		fieldSpecs = emptyList(),
		actions = emptyList(),
		enabled = enabled,
		triggers = triggers,
	)

	private fun event(id: String, conditions: List<AutomationCondition>, tell: String, enabled: Boolean = true) = AutomationRow(
		id,
		3L,
		Automation(
			enabled = enabled,
			trigger = AutomationTrigger.Event("github", conditions),
			actions = listOf(AutomationAction.TellAssistant(tell)),
		),
		sentence = id,
	)

	private val alert = AutomationRow(
		"threshold-a-low",
		1L,
		Automation(
			label = "Outside below 2.0",
			enabled = true,
			trigger = AutomationTrigger.Value("threshold-a", JsonPrimitive("low"), 0L),
			actions = listOf(AutomationAction.TellAssistant("quietly")),
		),
		sentence = "Outside below 2.0",
	)

	private val mention = conditionOf("reason", "is", listOf("mention"))

	private val unlisted = listOf(conditionOf("reason", "is_not", listOf("mention", "subscribed")), conditionOf("repository", "contains_not", listOf("fork")))

	private val current = ConsoleAssistantStateResult(
		workdir = "~/notes",
		sources = listOf(
			source("github", "GitHub notifications", listOf("pat"), enabled = true, triggers = true),
			source("sensors", "Sensors", emptyList(), enabled = false, triggers = false),
		),
		approveEverySend = false,
		temperatureUnit = "F",
		integrations = listOf(AssistantIntegration("ifttt", "IFTTT webhook", emptyList())),
	)

	private val offer = offerOf(SANDBOX_SERVES, away = false)

	private fun draft(trigger: TriggerDraft, vararg actions: ActionDraft) =
		AutomationDraft("a", trigger, actions.mapIndexed { index, action -> StepDraft.Action("action-$index", action) }, enabled = true, revision = 0L, EditContext(offer, emptyList()), display = "F")

	/** What the editor saves, typed as an owner types it. */
	private val edited = listOf(
		"a crossing that switches a plug and tells with a message" to draft(
			TriggerDraft.Crossing(SANDBOX_SENSOR, "temperature", "below", "35.6", "0.9", "10", "C"),
			plugDraft(SANDBOX_DEVICE, "on"),
			toldDraft("quietly", "It is {reading} at {device}."),
		),
		"a time of day that sends to IFTTT with one value" to draft(
			TriggerDraft.Time("18:30", setOf(1, 5), "America/Los_Angeles"),
			iftttDraft("door_open", "Lamp at {time}"),
		),
		"an interval that tells with no message" to draft(
			TriggerDraft.Interval("2", IntervalUnit.HOURS),
			toldDraft("now", ""),
		),
	)

	private val cases = listOf(
		"a home that lists automations" to AssistantHomeSealed(
			"~/notes",
			carriedOf(
				current,
				listOf(
					event("mentions", listOf(mention), "now"),
					event("listed", unlisted, "now"),
					event("everything", emptyList(), "now"),
					event("quiet", listOf(mention), "quietly"),
					event("off", listOf(mention), "now", enabled = false),
					alert,
				),
			),
		),
		"a home with no automations" to AssistantHomeSealed("~/notes", carriedOf(current, emptyList())),
		"nothing carried" to AssistantHomeSealed("~/fresh", null),
	).map { (name, sealed) -> case(name, AssistantHomeSealed.serializer(), sealed) } +
		listOf(
			PhoneStatusAnswer(holder = null, keys = emptyList()),
			PhoneStatusAnswer(
				holder = "pixel",
				keys = listOf(
					PhoneStatusKey("torch", available = false, reason = "disabled", needs = emptyList()),
					PhoneStatusKey("alarm", available = true, needs = emptyList()),
				),
			),
		).map { case("a status held by ${it.holder ?: "nobody"}", PhoneStatusAnswer.serializer(), it) } +
		case("an app opened with nothing else to say", AppOpenAnswer.serializer(), AppOpenAnswer(opened = true)) +
		edited.map { (name, draft) -> case(name, Automation.serializer(), draft.toAutomation(offer)!!) } +
		listOf(
			"a save the owner agreed to" to ConsoleOp.AutomationPut("door", edited[1].second.toAutomation(offer)!!, 2L, confirmed = true),
			"a save that needs no go-ahead" to ConsoleOp.AutomationPut("hourly", edited[2].second.toAutomation(offer)!!, 0L),
			"a preview of a text with placeholders" to
				ConsoleOp.AutomationPreview(edited[0].second.toAutomation(offer)!!.trigger, text = "It is {reading} at {device}."),
			"a preview with function args" to ConsoleOp.AutomationPreview(
				edited[0].second.toAutomation(offer)!!.trigger,
				text = "The room is {room}.",
				params = listOf(FunctionParam("room", "text")),
				args = JsonObject(mapOf("room" to JsonPrimitive("Office"))),
			),
			"a preview of a trigger alone" to ConsoleOp.AutomationPreview(edited[2].second.toAutomation(offer)!!.trigger),
			"a function save with a result name" to ConsoleOp.AutomationSave(
				automationId = "notice",
				automation = Automation(
					enabled = true,
					trigger = edited[2].second.toAutomation(offer)!!.trigger,
					actions = listOf(AutomationAction.RunFunction("notice")),
				),
				automationBase = 2L,
				function = AutomationSaveFunction.Edit(
					id = "notice",
					base = 1L,
					body = AutomationFunction(
						name = "Notice",
						params = emptyList(),
						steps = listOf(FunctionStep.Action(action = "tell_assistant", `as` = "result", args = JsonObject(mapOf("when" to literal("now"), "message" to literal("Done"))))),
					),
				),
			),
			"a sudo request answered with a secret, remembered into its policy" to
				entryAnswerOp("req-1", "nyaarium", VAULT_DECISION_WINDOW, VaultRemember(policyId = "sakura-sudo"))!!,
			"a sudo request answered with a secret, remembered as a new policy" to
				entryAnswerOp("req-2", "old-pass", VAULT_DECISION_ONCE, VaultRemember(policyId = "policy-1a2b3c4d", name = "Old Pass"))!!,
		).map { (name, op) -> case(name, ConsoleOp.serializer(), op) } +
		Case(
			"a scheduled message with a file",
			"ScheduledBody",
			sortedKeys(
				wireJson.parseToJsonElement(
					String(
						scheduledPlaintext(
							"Morning standup notes",
							"sched-op",
							listOf(MessageFile("notes.txt", "text/plain", src = "/tmp/sched-op/notes.txt", size = 12, blobId = "sha256-${"ab".repeat(32)}", role = ROLE_ATTACHMENT)),
						),
					),
				),
			),
		)

	private class Case(val name: String, val schema: String, val value: JsonElement)

	/** Upstream org.json keeps no key order. */
	private fun sortedKeys(value: JsonElement): JsonElement = when (value) {
		is kotlinx.serialization.json.JsonObject -> kotlinx.serialization.json.JsonObject(value.toSortedMap().mapValues { sortedKeys(it.value) })
		is kotlinx.serialization.json.JsonArray -> kotlinx.serialization.json.JsonArray(value.map(::sortedKeys))
		else -> value
	}

	/** Labelled by the class encoded. */
	private fun <T> case(name: String, serializer: KSerializer<T>, value: T) =
		Case(name, serializer.descriptor.serialName.substringAfterLast('.'), wireJson.encodeToJsonElement(serializer, value))

	@OptIn(ExperimentalSerializationApi::class)
	private fun rendered(): String {
		val pretty = Json(wireJson) {
			prettyPrint = true
			prettyPrintIndent = "\t"
		}
		val corpus = buildJsonObject {
			put("description", "Values the Kotlin phone encodes, each named by the schema the Gateway parses it with.")
			put(
				"cases",
				buildJsonArray {
					for (case in cases) {
						add(
							buildJsonObject {
								put("name", case.name)
								put("schema", case.schema)
								put("value", case.value)
							},
						)
					}
				},
			)
		}
		return pretty.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), corpus) + "\n"
	}

	@Test
	fun theCommittedCasesAreWhatThisPhoneEncodes() {
		val fresh = rendered()
		if (System.getenv("UPDATE_FIXTURES") != null) {
			File("../../tests/fixtures/$FIXTURE").writeText(fresh)
			return
		}
		val committed = javaClass.classLoader?.getResourceAsStream(FIXTURE)?.bufferedReader()?.use { it.readText() }
		assertEquals(fresh, committed)
	}
}
