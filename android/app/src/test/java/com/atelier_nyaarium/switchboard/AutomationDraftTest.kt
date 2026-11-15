package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.automationsEmpty
import com.atelier_nyaarium.switchboard.assistant.AutomationEditing
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.automationEditing
import com.atelier_nyaarium.switchboard.assistant.automationGroups
import com.atelier_nyaarium.switchboard.assistant.doesText
import com.atelier_nyaarium.switchboard.assistant.editable
import com.atelier_nyaarium.switchboard.assistant.fittingAutomation
import com.atelier_nyaarium.switchboard.assistant.newAutomationDraft
import com.atelier_nyaarium.switchboard.assistant.openedDraft
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.assistant.previewHead
import com.atelier_nyaarium.switchboard.assistant.producesText
import com.atelier_nyaarium.switchboard.assistant.ranText
import com.atelier_nyaarium.switchboard.assistant.sourceChoices
import com.atelier_nyaarium.switchboard.assistant.testsOf
import com.atelier_nyaarium.switchboard.assistant.usesOf
import com.atelier_nyaarium.switchboard.assistant.usesText
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

private val SPECS = listOf(
	AssistantFieldSpec.Enumeration(
		"reason",
		"Reason",
		listOf(AssistantFieldOption("review_requested", "Review requested"), AssistantFieldOption("mention", "Mention")),
	),
	AssistantFieldSpec.Text("repository", "Repository"),
)

private val fields = SourceFields(SPECS)

private fun source(id: String, triggers: Boolean = true) = AssistantSource(
	id = id,
	label = id.replaceFirstChar { it.uppercase() },
	grants = emptyList(),
	unread = 0L,
	fieldSpecs = SPECS,
	actions = emptyList(),
	enabled = true,
	triggers = triggers,
)

private fun reason(value: String, test: String = "is") = AutomationCondition("reason", test, value)

private fun event(vararg conditions: AutomationCondition, tell: String = "now", enabled: Boolean = true) = Automation(
	enabled = enabled,
	trigger = AutomationTrigger.Event("github", conditions.toList()),
	actions = listOf(AutomationAction.TellAssistant(tell)),
)

private fun row(id: String, automation: Automation, revision: Long = 1L, device: String? = null, lastRanAt: Long? = null) =
	AutomationRow(id, revision, automation, sentence = id, lastRanAt = lastRanAt, device = device)

private val alert = Automation(
	label = "Outside below 2",
	enabled = true,
	trigger = AutomationTrigger.Value("threshold-a", JsonPrimitive("low"), 0L),
	actions = listOf(AutomationAction.TellAssistant("quietly")),
)

private val future = AutomationAction.Unknown("switch_plug", buildJsonObject { put("kind", "switch_plug") })

class AutomationDraftTest {
	@Test
	fun aNewDraftTakesTheFirstTriggeringSourceAndSavesWithNoConditions() {
		val draft = newAutomationDraft(listOf(source("sensors", triggers = false), source("github")))!!

		assertEquals("github", draft.source)
		assertEquals(0L, draft.revision)
		assertEquals(event(), fittingAutomation(draft, fields))
		assertNull(newAutomationDraft(listOf(source("sensors", triggers = false))))
	}

	@Test
	fun aConditionSavesTrimmedAndBlocksSaveWhileBlankOrOffItsList() {
		val draft = newAutomationDraft(listOf(source("github")))!!.withCondition(fields)
		val typed = draft.changed(0) { it.copy(value = " mention ") }
		val off = draft.changed(0) { it.copy(value = "retired") }

		assertEquals(reason(""), draft.conditions.single())
		assertNull(fittingAutomation(draft, fields))
		assertEquals(event(reason("mention")), fittingAutomation(typed, fields))
		assertNull(fittingAutomation(off, fields))
		assertNotNull(fields.issueOf(off.conditions.single()))
		assertEquals(event(), fittingAutomation(typed.withoutCondition(0), fields))
	}

	@Test
	fun aKindChangeClearsTheValueAndKeepsOnlyATestTheNewKindTakes() {
		val onText = AutomationDraft("a", "github", listOf(AutomationCondition("repository", "contains", "atelier")), "now", true, 0L)
		val onChoice = AutomationDraft("a", "github", listOf(reason("mention", "is_not")), "now", true, 0L)

		assertEquals(reason(""), onText.withField(0, "reason", fields).conditions.single())
		assertEquals(AutomationCondition("repository", "is_not", ""), onChoice.withField(0, "repository", fields).conditions.single())
		assertEquals(listOf("is", "is_not"), testsOf(fields.specOf("reason")))
		assertEquals(listOf("subscribed", "review_requested", "mention"), fields.choicesFor("reason", "subscribed"))
		assertEquals(emptyList<AutomationCondition>(), onText.withSource("other").conditions)
	}

	@Test
	fun anEditKeepsWhatTheEditorDoesNotShow() {
		val held = event(reason("mention")).copy(label = "Kept", actions = listOf(future, AutomationAction.TellAssistant("now")))
		val draft = automationDraftOf(row("a", held, revision = 3L)).copy(tell = "quietly")

		val saved = draft.toAutomation()!!

		assertEquals("Kept", saved.label)
		assertEquals(listOf(future, AutomationAction.TellAssistant("quietly")), saved.actions)
		assertEquals(3L, draft.revision)
	}

	@Test
	fun onlyAnEventAutomationTheEditorCanShowWholeIsEditable() {
		assertEquals(true, editable(row("a", event())))
		assertEquals(false, editable(row("a", event(), device = "ce:1c")))
		assertEquals(false, editable(row("a", alert)))
		assertEquals(false, editable(row("a", event().copy(actions = listOf(future)))))
		assertEquals(false, editable(row("a", event().copy(trigger = AutomationTrigger.Unknown("time", buildJsonObject {})))))
		assertNull(openedDraft(AutomationSlot.Held("a"), row("a", alert), listOf(source("github"))))
		assertNotNull(openedDraft(AutomationSlot.Held("a"), row("a", event()), listOf(source("github"))))
	}

	@Test
	fun theEditorAllowsEditingSavingAndDeletingOnlyWhenItCan() {
		val valid = automationDraftOf(row("a", event(reason("mention"))))
		val blank = valid.changed(0) { it.copy(value = " ") }
		val held = AutomationSlot.Held("a")
		val can = { slot: AutomationSlot, draft: AutomationDraft, offered: Boolean, busy: Boolean, gone: Boolean ->
			automationEditing(slot, draft, fields, offered, busy, gone)
		}

		assertEquals(AutomationEditing(edit = true, save = true, delete = true), can(held, valid, true, false, false))
		assertEquals(AutomationEditing(edit = true, save = false, delete = true), can(held, blank, true, false, false))
		assertEquals(AutomationEditing(edit = true, save = false, delete = true), can(held, valid, false, false, false))
		assertEquals(AutomationEditing(edit = false, save = false, delete = false), can(held, valid, true, true, false))
		assertEquals(AutomationEditing(edit = false, save = false, delete = false), can(held, valid, true, false, true))
		assertEquals(AutomationEditing(edit = true, save = true, delete = false), can(AutomationSlot.New, valid, true, false, false))
	}

	@Test
	fun aSourceTheGatewayNoLongerListsStaysFirstInTheMenu() {
		val sources = listOf(source("github"), source("sensors", triggers = false))

		assertEquals(listOf("github"), sourceChoices(sources, "github"))
		assertEquals(listOf("gitlab", "github"), sourceChoices(sources, "gitlab"))
	}

	@Test
	fun aStaleSaveOffersToGoOverWhatIsHeldAndAStaleDeleteShowsIt() {
		val draft = automationDraftOf(row("a", event(reason("mention")), revision = 2L)).copy(tell = "quietly")
		val newer = row("a", event(reason("review_requested")), revision = 5L)
		val refused = AutomationSaved.Refused("revision 5 is stored", newer)

		val save = outcomeOf(refused, draft) as AutomationOutcome.Offer
		val delete = outcomeOf(refused, draft, deleting = true) as AutomationOutcome.Offer

		assertEquals(5L, save.draft.revision)
		assertEquals(listOf(reason("mention")), save.draft.conditions)
		assertEquals(automationDraftOf(newer), delete.draft)
		assertEquals(AutomationOutcome.Done, outcomeOf(AutomationSaved.Stored(newer), draft))
		assertEquals(AutomationOutcome.Said("no"), outcomeOf(AutomationSaved.Refused("no"), draft))
		assertEquals(
			AutomationOutcome.Said("same"),
			outcomeOf(AutomationSaved.Refused("same", row("a", event(), revision = 2L)), draft),
		)
	}

	@Test
	fun aDraftAsksBeforeLeavingOnlyOnceItDiffersFromWhatOpened() {
		val opened = automationDraftOf(row("a", event(reason("mention"))))

		assertEquals(false, opened.changedFrom(opened))
		assertEquals(true, opened.copy(tell = "quietly").changedFrom(opened))
		assertEquals(true, opened.withCondition(fields).changedFrom(opened))
		assertEquals(true, opened.withSource("other").changedFrom(opened))
	}

	@Test
	fun aRowSaysWhatItDoesWhenItRanAndHowManyUseASource() {
		val rows = listOf(row("a", event()), row("b", event(tell = "quietly"), lastRanAt = 9L), row("c", alert))

		assertEquals("Tell the assistant now", doesText(event()))
		assertEquals("switch_plug · Tell the assistant quietly", doesText(event(tell = "quietly").copy(actions = listOf(future, AutomationAction.TellAssistant("quietly")))))
		assertEquals(listOf("Never ran", "Ran 9 ago", "Never ran"), rows.map { ranText(it) { at -> "$at ago" } })
		assertEquals(2, usesOf("github", rows))
		assertEquals(listOf("1 uses this source", "2 use this source"), listOf(1, 2).map(::usesText))
		assertEquals("reason, repository", producesText(SPECS))
	}

	@Test
	fun thePreviewHeadCountsMatchesAndSaysNothingForNoEvents() {
		assertEquals("Would have matched 2 of the last 50", previewHead(ConsoleAutomationPreviewResult(2L, 50L, emptyList())))
		assertNull(previewHead(ConsoleAutomationPreviewResult(0L, 0L, emptyList())))
	}

	@Test
	fun groupsListOnlyGatewaysWithAutomationsTheHomeFirstAndOnlyTheHomesRowsEdit() {
		fun entry(id: String, rows: List<AutomationRow>?) =
			GatewayEntry(
				id,
				connected = true,
				incarnation = 1L,
				lastRegisteredAt = 1L,
				automations = rows?.let { GatewayList.Listed(it) } ?: GatewayList.NotServed,
			)
		val registry = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(
				entry("mikan", listOf(row("m", event()))),
				entry("older", null),
				entry("idle", emptyList()),
				entry("sakura", listOf(row("a", event()), row("t", alert))),
			),
		)

		val groups = automationGroups(registry, home = "sakura")

		assertEquals(listOf("sakura" to true, "mikan" to false), groups.map { it.gatewayId to it.assistant })
		assertEquals(listOf(true, false, false), groups.flatMap { group -> group.rows.map(group::edits) })
	}

	@Test
	fun anEmptyAutomationsViewTellsAnUnreadListFromAnEmptyOneAndAnOlderHomeFromAFault() {
		fun registry(vararg lists: Pair<String, GatewayList<AutomationRow>>) = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = lists.map { (id, list) ->
				GatewayEntry(id, connected = true, incarnation = 1L, lastRegisteredAt = 1L, automations = list)
			},
		)
		val listed = GatewayList.Listed(emptyList<AutomationRow>())
		val serving = AssistantWord.Answered(
			com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult(workdir = "~/notes", sources = emptyList()),
		)

		assertEquals(ListEmpty.NoRoster, automationsEmpty(GatewayRegistry(), "sakura"))
		assertEquals(ListEmpty.Reading, automationsEmpty(registry("sakura" to GatewayList.Unread), "sakura"))
		assertEquals(ListEmpty.Unreachable, automationsEmpty(registry("sakura" to GatewayList.Unreachable), "sakura"))
		assertEquals(ListEmpty.NotServed(listOf("sakura")), automationsEmpty(registry("sakura" to GatewayList.NotServed), "sakura"))
		// A home that answers sources serves the list, whatever one refusal said.
		val refusedOnce = registry("sakura" to GatewayList.NotServed).withEntry("sakura") { it.copy(assistant = serving) }
		assertEquals(ListEmpty.Unreachable, automationsEmpty(refusedOnce, "sakura"))
		assertEquals(ListEmpty.None, automationsEmpty(registry("sakura" to listed, "older" to GatewayList.NotServed), "sakura"))
		assertEquals(ListEmpty.None, automationsEmpty(registry("sakura" to listed), null))
		val cached = registry("sakura" to GatewayList.Unread).copy(provenance = RegistryProvenance.Cached)
		assertEquals(ListEmpty.Reading, automationsEmpty(cached, "sakura"))
	}
}
