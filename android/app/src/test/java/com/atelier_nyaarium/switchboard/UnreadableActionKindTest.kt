package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.ActionOffer
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.ParamOffer
import com.atelier_nyaarium.switchboard.assistant.actionLine
import com.atelier_nyaarium.switchboard.assistant.actionOf
import com.atelier_nyaarium.switchboard.assistant.addableActions
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.canRemove
import com.atelier_nyaarium.switchboard.assistant.editable
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A build that knows neither an action's kind nor its parameter kinds, as 8.14.83 met `run_function`:
 * the kinds here are names no build knows, so this keeps proving the rule after the codegen learns them.
 */
class UnreadableActionKindTest {
	private val kind = "future_call"

	private val raw: JsonObject = buildJsonObject {
		put("kind", kind)
		put("function", "fn-1")
		putJsonObject("values") {
			put("name", "porch")
			put("count", 3)
		}
	}

	private val unread = AutomationAction.Unknown(kind, raw)

	private val served = offerOf(SANDBOX_SERVES, away = false).let { offer ->
		offer.copy(
			actions = offer.actions + ActionOffer(
				kind = kind,
				label = "Run a function",
				danger = false,
				params = listOf(ParamOffer("function", "Function", "future_function_kind"), ParamOffer("values", "Values", "future_values_kind")),
			),
		)
	}

	private fun row(vararg actions: AutomationAction) =
		AutomationRow("a", 1L, Automation(enabled = true, trigger = AutomationTrigger.Event("github", emptyList()), actions = actions.toList()), sentence = "a")

	private fun jsonOf(action: AutomationAction) = wireJson.encodeToJsonElement(AutomationAction.serializer(), action)

	@Test
	fun anActionThisBuildCannotDrawIsKeptLabelledNeverOfferedAndSavedAsSent() {
		val alone = row(unread)
		val draft = automationDraftOf(alone, EditContext(served, emptyList()))!!

		assertTrue(draft.actions.single() is ActionDraft.Kept)
		assertEquals("Run a function", actionLine(unread, served))
		assertTrue(editable(alone, served))
		assertTrue(addableActions(served, draft.actions).none { it.kind == kind })
		// The only action stays while its Gateway still offers it.
		assertFalse(canRemove(draft, 0, served))
		assertTrue(canRemove(automationDraftOf(row(AutomationAction.TellAssistant("now"), unread), EditContext(served, emptyList()))!!, 1, served))

		assertEquals(raw, jsonOf(actionOf(draft.actions.single(), served)!!))
		assertEquals(raw, jsonOf(written(draft.toAutomation(served)!!).single()))
	}

	/** Why a record or a kind an older build re-encodes never gains a key: only a new kind survives it. */
	@Test
	fun aReEncodeKeepsAnUnknownActionKindWholeAndDropsAnUnknownRecordKey() {
		val stored = buildJsonObject {
			put("enabled", true)
			put("trigger", wireJson.encodeToJsonElement(AutomationTrigger.serializer(), AutomationTrigger.Event("github", emptyList())))
			put("actions", kotlinx.serialization.json.JsonArray(listOf(raw)))
			put("future_field", "kept nowhere")
		}

		// As a toggle from the list row sends it.
		val toggled = wireJson.decodeFromJsonElement(Automation.serializer(), stored).copy(enabled = false)
		val sent = wireJson.encodeToJsonElement(Automation.serializer(), toggled).jsonObject

		assertEquals(raw, sent.getValue("actions").jsonArray.single())
		assertFalse("future_field" in sent)
	}
}
