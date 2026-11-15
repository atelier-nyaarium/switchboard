package com.atelier_nyaarium.switchboard

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
import java.io.File
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

private const val FIXTURE = "assistant-home/sealed.json"

/**
 * The sealed home payload as this phone encodes it; `assistant-home-sealed.test.ts` parses the same file.
 * Regenerate with `UPDATE_FIXTURES=1 ./gradlew :app:testDebugUnitTest --tests '*AssistantHomeSealedFixtureTest*'`.
 */
class AssistantHomeSealedFixtureTest {
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
	)

	@OptIn(ExperimentalSerializationApi::class)
	private fun rendered(): String {
		val pretty = Json(sealedJson) {
			prettyPrint = true
			prettyPrintIndent = "\t"
		}
		val corpus = buildJsonObject {
			put("description", "The assistant home's sealed plaintext, as the Kotlin phone encodes it.")
			put(
				"cases",
				buildJsonArray {
					for ((name, sealed) in cases) {
						add(
							buildJsonObject {
								put("name", name)
								put("sealed", sealedJson.encodeToJsonElement(AssistantHomeSealed.serializer(), sealed))
							},
						)
					}
				},
			)
		}
		return pretty.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), corpus) + "\n"
	}

	@Test
	fun theCommittedPayloadsAreWhatThisPhoneSeals() {
		val fresh = rendered()
		if (System.getenv("UPDATE_FIXTURES") != null) {
			File("../../tests/fixtures/$FIXTURE").writeText(fresh)
			return
		}
		val committed = javaClass.classLoader?.getResourceAsStream(FIXTURE)?.bufferedReader()?.use { it.readText() }
		assertEquals(fresh, committed)
	}
}
