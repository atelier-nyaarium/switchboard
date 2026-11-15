package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AppOpenAnswer
import com.atelier_nyaarium.switchboard.proto.AssistantHomeSealed
import com.atelier_nyaarium.switchboard.proto.AssistantIntegration
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
import com.atelier_nyaarium.switchboard.proto.PhoneStatusAnswer
import com.atelier_nyaarium.switchboard.proto.PhoneStatusKey
import java.io.File
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
		device = "ce:1c",
	)

	private val mention = AutomationCondition("reason", "is", "mention")

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

	private val older = ConsoleAssistantStateResult(
		workdir = "~/notes",
		watchers = listOf(
			AssistantWatcher(
				id = "github",
				label = "GitHub notifications",
				grants = emptyList(),
				unread = 0L,
				rules = AssistantWatcherRules(
					listOf(AssistantRule("mentions", listOf(AssistantRuleCondition("reason", "is", "mention")), "wake", 4L)),
					AssistantRuleOtherwise("inbox", 1L),
					5L,
				),
			),
		),
	)

	private val cases = listOf(
		"a home that lists automations" to AssistantHomeSealed(
			"~/notes",
			carriedOf(
				current,
				listOf(
					event("mentions", listOf(mention), "now"),
					event("everything", emptyList(), "now"),
					event("quiet", listOf(mention), "quietly"),
					event("off", listOf(mention), "now", enabled = false),
					alert,
				),
			),
		),
		"a home with no automations" to AssistantHomeSealed("~/notes", carriedOf(current, emptyList())),
		"a home on an older build" to AssistantHomeSealed("~/notes", carriedOf(older, null)),
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
		case("an app opened with nothing else to say", AppOpenAnswer.serializer(), AppOpenAnswer(opened = true))

	private class Case(val name: String, val schema: String, val value: JsonElement)

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
