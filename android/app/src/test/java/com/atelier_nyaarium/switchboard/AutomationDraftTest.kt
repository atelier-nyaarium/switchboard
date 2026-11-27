package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.ActionOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationContext
import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationEditing
import com.atelier_nyaarium.switchboard.assistant.AutomationOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.assistant.HomeSources
import com.atelier_nyaarium.switchboard.assistant.IntervalUnit
import com.atelier_nyaarium.switchboard.assistant.NumberOffer
import com.atelier_nyaarium.switchboard.assistant.PreviewRead
import com.atelier_nyaarium.switchboard.assistant.Served
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.SwitchOffer
import com.atelier_nyaarium.switchboard.assistant.TextPreview
import com.atelier_nyaarium.switchboard.assistant.TriggerChoice
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.conditionDraftsOf
import com.atelier_nyaarium.switchboard.assistant.actionDraftOf
import com.atelier_nyaarium.switchboard.assistant.actionFields
import com.atelier_nyaarium.switchboard.assistant.ParamOffer
import com.atelier_nyaarium.switchboard.assistant.actionHint
import com.atelier_nyaarium.switchboard.assistant.actionIssue
import com.atelier_nyaarium.switchboard.assistant.doesLine
import com.atelier_nyaarium.switchboard.assistant.kindOf
import com.atelier_nyaarium.switchboard.assistant.actionOf
import com.atelier_nyaarium.switchboard.assistant.actionOfferOf
import com.atelier_nyaarium.switchboard.assistant.actionWarning
import com.atelier_nyaarium.switchboard.assistant.addableActions
import com.atelier_nyaarium.switchboard.assistant.askedTrigger
import com.atelier_nyaarium.switchboard.assistant.automationContext
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.automationEditing
import com.atelier_nyaarium.switchboard.assistant.automationGroups
import com.atelier_nyaarium.switchboard.assistant.automationStanding
import com.atelier_nyaarium.switchboard.assistant.automationsEmpty
import com.atelier_nyaarium.switchboard.assistant.withoutValue
import com.atelier_nyaarium.switchboard.assistant.canRemove
import com.atelier_nyaarium.switchboard.assistant.confirmBody
import com.atelier_nyaarium.switchboard.assistant.coolDownSecOf
import com.atelier_nyaarium.switchboard.assistant.coolDownTyped
import com.atelier_nyaarium.switchboard.assistant.crossingSuffix
import com.atelier_nyaarium.switchboard.assistant.doesText
import com.atelier_nyaarium.switchboard.assistant.editable
import com.atelier_nyaarium.switchboard.assistant.fittingAutomation
import com.atelier_nyaarium.switchboard.assistant.freshAction
import com.atelier_nyaarium.switchboard.assistant.freshTrigger
import com.atelier_nyaarium.switchboard.assistant.generalLine
import com.atelier_nyaarium.switchboard.assistant.holeLine
import com.atelier_nyaarium.switchboard.assistant.minted
import com.atelier_nyaarium.switchboard.assistant.newAutomationDraft
import com.atelier_nyaarium.switchboard.assistant.newAutomationGateways
import com.atelier_nyaarium.switchboard.assistant.numberSuffix
import com.atelier_nyaarium.switchboard.assistant.picked
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.offersChoice
import com.atelier_nyaarium.switchboard.assistant.offersWatch
import com.atelier_nyaarium.switchboard.assistant.openedDraft
import com.atelier_nyaarium.switchboard.assistant.opensIn
import com.atelier_nyaarium.switchboard.assistant.over
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.assistant.previewHead
import com.atelier_nyaarium.switchboard.assistant.producesText
import com.atelier_nyaarium.switchboard.assistant.ranText
import com.atelier_nyaarium.switchboard.assistant.refusedHole
import com.atelier_nyaarium.switchboard.assistant.refusedHoleOf
import com.atelier_nyaarium.switchboard.assistant.sourceChoices
import com.atelier_nyaarium.switchboard.assistant.testsOf
import com.atelier_nyaarium.switchboard.assistant.textPreviewOf
import com.atelier_nyaarium.switchboard.assistant.unkeyed
import com.atelier_nyaarium.switchboard.assistant.triggerDraftOf
import com.atelier_nyaarium.switchboard.assistant.triggerHint
import com.atelier_nyaarium.switchboard.assistant.triggerIssue
import com.atelier_nyaarium.switchboard.assistant.triggerOf
import com.atelier_nyaarium.switchboard.assistant.unopenedLine
import com.atelier_nyaarium.switchboard.assistant.usesText
import com.atelier_nyaarium.switchboard.assistant.withValue
import com.atelier_nyaarium.switchboard.assistant.ValueAdd
import com.atelier_nyaarium.switchboard.assistant.conditionOf
import com.atelier_nyaarium.switchboard.assistant.conditionsServed
import com.atelier_nyaarium.switchboard.assistant.testLabel
import com.atelier_nyaarium.switchboard.assistant.valueAddOf
import com.atelier_nyaarium.switchboard.assistant.valueRefusal
import com.atelier_nyaarium.switchboard.assistant.valuesOf
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AssistantHomeRecord
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationConditionServes
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationIssueLevel
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewHole
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationListResult
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

private const val SENSOR = "ce:1c"
private const val PLUG = "aa:bb"
private const val ZONE = "America/Los_Angeles"
private const val EVENT_ACTION_KEY = "event-action"

private val FULL = AutomationOffer(
	triggers = offerOf(SANDBOX_SERVES, away = false).triggers.filter { it.kind != "value" },
	actions = SANDBOX_SERVES.actions.map(::actionOfferOf),
	numbers = listOf(
		NumberOffer(SENSOR, "temperature", "Outside temperature", "C", 1),
		NumberOffer(SENSOR, "humidity", "Outside humidity", "%", 0),
	),
	switches = listOf(SwitchOffer(PLUG, "Desk lamp")),
	away = false,
)

private val TELL_ONLY = tellOnlyOffer()

private val HERE = EditContext(TELL_ONLY, emptyList())

private val FULL_HERE = EditContext(FULL, emptyList())

private fun placed(gatewayId: String?) = AssistantHome.Read(gatewayId?.let { AssistantHomeRecord(1L, it) }, null)

private fun known(offer: AutomationOffer) = AutomationContext(Served.Known(offer), HomeSources.Known(emptyList()))

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

private fun reason(vararg values: String, test: String = "is") = conditionOf("reason", test, values.toList())

private fun event(vararg conditions: AutomationCondition, tell: String = "now", enabled: Boolean = true) = Automation(
	enabled = enabled,
	trigger = AutomationTrigger.Event("github", conditions.toList()),
	actions = listOf(AutomationAction.TellAssistant(tell)),
)

private fun eventDraft(vararg conditions: AutomationCondition) =
	AutomationDraft("a", TriggerDraft.Event("github", conditionDraftsOf(conditions.toList())), listOf(StepDraft.Do(EVENT_ACTION_KEY, toldDraft("now"))), true, 0L, HERE)

private val quietly: (ActionDraft) -> ActionDraft = { toldDraft("quietly") }

private fun row(
	id: String,
	automation: Automation,
	revision: Long = 1L,
	lastRanAt: Long? = null,
	nextRunAt: Long? = null,
) = AutomationRow(id, revision, automation, sentence = id, lastRanAt = lastRanAt, nextRunAt = nextRunAt)

private val alert = Automation(
	label = "Outside below 2",
	enabled = true,
	trigger = AutomationTrigger.Value("threshold-a", JsonPrimitive("low"), 0L),
	actions = listOf(AutomationAction.TellAssistant("quietly")),
)

private val crossing = AutomationTrigger.Crossing(SENSOR, "temperature", "below", 2.0, 0.5, 600L)

private val future = AutomationAction.Unknown("switch_plug", buildJsonObject { put("kind", "switch_plug") })

class AutomationDraftTest {
	@Test
	fun aNewDraftTakesTheFirstTriggeringSourceAndSavesWithNoConditions() {
		val draft = newAutomationDraft(EditContext(TELL_ONLY, listOf(source("sensors", triggers = false), source("github"))))!!

		assertEquals("github", draft.source)
		assertEquals(0L, draft.revision)
		assertEquals(event(), fittingAutomation(draft, TELL_ONLY))
		assertNull(newAutomationDraft(EditContext(TELL_ONLY, listOf(source("sensors", triggers = false)))))
	}

	@Test
	fun aConditionSavesTrimmedEachValueOnceAndSavesBlankOrOffItsList() {
		val draft = newAutomationDraft(EditContext(TELL_ONLY, listOf(source("github"))))!!.withCondition(fields)
		val first = draft.conditionDrafts.single().key
		val typed = draft.changed(first, values = { it + " mention " })
		val listed = typed.changed(first, values = { it + listOf("review_requested", "mention") })
		val off = typed.changed(first, values = { it + "retired" })

		assertEquals(reason(), draft.conditions.single())
		assertEquals(event(reason()), fittingAutomation(draft, TELL_ONLY))
		assertEquals(event(reason("mention")), fittingAutomation(typed, TELL_ONLY))
		assertEquals(event(reason("mention", "review_requested")), fittingAutomation(listed, TELL_ONLY))
		assertEquals(listOf("mention"), valuesOf(listed.changed(first, values = { it - "review_requested" }).conditions.single()))
		assertEquals(event(reason("mention", "retired")), fittingAutomation(off, TELL_ONLY))
		assertEquals(AutomationIssueLevel.WARNING, fields.issueOf(off.conditions.single())?.level)
		assertEquals(listOf(true, false), listOf(off, draft).map { fields.fits(it.conditions.single()) })
		assertEquals(event(), fittingAutomation(typed.withoutCondition(first), TELL_ONLY))
	}

	@Test
	fun aConditionKeepsItsKeyAndValuesWhenOneAboveItIsRemoved() {
		val draft = eventDraft(reason("mention"), conditionOf("repository", "contains", listOf("atelier")))
		val (above, below) = draft.conditionDrafts
		val removed = draft.withoutCondition(above.key)
		val added = removed.withCondition(fields).changed(below.key, values = { it + "nyaa" })

		assertEquals(listOf(below), removed.conditionDrafts)
		assertEquals(below.key, added.conditionDrafts.first().key)
		assertEquals(listOf("atelier", "nyaa"), valuesOf(added.conditionDrafts.first().condition))
		assertEquals(listOf(reason()), added.conditions.drop(1))
		assertEquals(2, added.conditionDrafts.map { it.key }.toSet().size)
		assertEquals(false, draft.changedFrom(eventDraft(reason("mention"), conditionOf("repository", "contains", listOf("atelier")))))
	}

	@Test
	fun aConditionTakesAListOnlyWhereItsGatewayServesOne() {
		val served = AutomationConditionServes(listOf("is", "is_not", "contains", "contains_not"), 16L)
		val text = conditionOf("repository", "contains", listOf("atelier"))
		val choice = reason("mention")

		assertEquals(listOf("is", "is_not", "contains"), fields.testsFor(text, null))
		assertEquals(listOf("is", "is_not", "contains", "contains_not"), fields.testsFor(text, served))
		assertEquals(listOf("is", "is_not"), fields.testsFor(choice, served))
		assertEquals(listOf(ValueAdd.Full, ValueAdd.Type), listOf(null, served).map { valueAddOf(text, fields, it) })
		assertEquals(ValueAdd.Pick(listOf("review_requested")), valueAddOf(choice, fields, served))
		assertEquals(ValueAdd.Full, valueAddOf(reason("mention", "review_requested"), fields, served))
		assertEquals(listOf("Already listed", null), listOf("ATELIER", "nyaa").map { valueRefusal(text, it, served) })
		assertEquals(true, conditionsServed(listOf(text, choice), null))
		assertEquals(listOf(true, false), listOf(served, null).map { conditionsServed(listOf(reason("mention", "review_requested")), it) })
		assertEquals(false, conditionsServed(listOf(conditionOf("repository", "contains_not", listOf("fork"))), null))
		assertEquals(listOf("contains any of", "contains"), listOf(2, 1).map { testLabel("contains", it) })
	}

	@Test
	fun aKindChangeClearsTheValueAndKeepsOnlyATestTheNewKindTakes() {
		val onText = eventDraft(conditionOf("repository", "contains", listOf("atelier", "nyaa")))
		val onChoice = eventDraft(reason("mention", test = "is_not"))

		assertEquals(reason(), onText.withField(onText.conditionDrafts.single().key, "reason", fields).conditions.single())
		assertEquals(
			conditionOf("repository", "is_not", emptyList()),
			onChoice.withField(onChoice.conditionDrafts.single().key, "repository", fields).conditions.single(),
		)
		assertEquals(listOf("is", "is_not"), testsOf(fields.specOf("reason")))
		assertEquals(listOf("review_requested"), fields.choicesFor(reason("mention", "subscribed")))
		assertEquals(emptyList<AutomationCondition>(), onText.withSource("other").conditions)
	}

	@Test
	fun anEditKeepsWhatTheEditorDoesNotShow() {
		val held = event(reason("mention")).copy(label = "Kept", actions = listOf(future, AutomationAction.TellAssistant("now")))
		val opened = automationDraftOf(row("a", held, revision = 3L), HERE)!!
		val draft = opened.withAction(opened.steps[1].key, quietly)

		val saved = draft.toAutomation(TELL_ONLY)!!

		assertEquals("Kept", saved.label)
		assertEquals(listOf(future, AutomationAction.TellAssistant("quietly")), written(saved))
		assertEquals(3L, draft.revision)
	}

	@Test
	fun aRowIsEditableOnlyWhereItsGatewayHoldsItsTriggerAndTheEditorCanDrawItWhole() {
		val watched = event().copy(trigger = crossing)

		assertEquals(true, editable(row("a", event()), TELL_ONLY))
		assertEquals(true, editable(row("threshold-ce1c-temperature-low", watched), FULL))
		assertEquals(false, editable(row("a", alert), TELL_ONLY))
		assertEquals(true, editable(row("a", event().copy(actions = listOf(future))), TELL_ONLY))
		assertEquals(false, editable(row("a", event().copy(trigger = AutomationTrigger.Unknown("moon", buildJsonObject {}))), TELL_ONLY))
		assertEquals(listOf(false, true), listOf(TELL_ONLY, FULL).map { editable(row("a", watched), it) })
		assertNull(openedDraft(AutomationSlot.Held("a"), Lookup.Found(row("a", alert)), EditContext(TELL_ONLY, listOf(source("github")))))
		assertNotNull(openedDraft(AutomationSlot.Held("a"), Lookup.Found(row("a", event())), EditContext(TELL_ONLY, listOf(source("github")))))
	}

	@Test
	fun theEditorAllowsEditingSavingAndDeletingOnlyWhenItCan() {
		val valid = automationDraftOf(row("a", event(reason("mention"))), HERE)!!
		val first = valid.conditionDrafts.single().key
		val blank = valid.changed(first, values = { emptyList() })
		val long = valid.changed(first, values = { listOf("x".repeat(201)) })
		val held = AutomationSlot.Held("a")
		val can = { slot: AutomationSlot, draft: AutomationDraft, offered: Boolean, busy: Boolean, gone: Boolean ->
			automationEditing(slot, draft, fields, offered, busy, gone, TELL_ONLY)
		}

		assertEquals(AutomationEditing(edit = true, save = true, delete = true), can(held, valid, true, false, false))
		assertEquals(AutomationEditing(edit = true, save = true, delete = true), can(held, blank, true, false, false))
		assertEquals(AutomationEditing(edit = true, save = false, delete = true), can(held, long, true, false, false))
		assertEquals(AutomationEditing(edit = true, save = false, delete = true), can(held, valid, false, false, false))
		assertEquals(AutomationEditing(edit = false, save = false, delete = false), can(held, valid, true, true, false))
		assertEquals(AutomationEditing(edit = false, save = false, delete = false), can(held, valid, true, false, true))
		assertEquals(AutomationEditing(edit = true, save = true, delete = false), can(AutomationSlot.New(), valid, true, false, false))
	}

	@Test
	fun aSourceTheGatewayNoLongerListsStaysFirstInTheMenu() {
		val sources = listOf(source("github"), source("sensors", triggers = false))

		assertEquals(listOf("github"), sourceChoices(sources, "github"))
		assertEquals(listOf("gitlab", "github"), sourceChoices(sources, "gitlab"))
	}

	@Test
	fun aRefusedSaveOffersWhatIsHeldAsksForAGoAheadOrMarksTheHoleItFailedOn() {
		val opened = automationDraftOf(row("a", event(reason("mention")), revision = 2L), HERE)!!
		val draft = opened.withAction(opened.steps[0].key, quietly)
		val newer = row("a", event(reason("review_requested")), revision = 5L)
		val refused = AutomationSaved.Refused("revision 5 is stored", newer)
		val span = AutomationHoleSpan(0L, "message", 3L, 6L)

		val save = outcomeOf(refused, draft, false, HERE) as AutomationOutcome.Offer
		val delete = outcomeOf(refused, draft, deleting = true, HERE) as AutomationOutcome.Offer
		val asks = outcomeOf(AutomationSaved.Refused("confirm", confirm = listOf("Send to IFTTT")), draft, false, HERE)
		val hole = outcomeOf(AutomationSaved.Refused("no name x here", hole = refusedHoleOf(span)), draft, false, HERE)

		assertEquals(5L, save.draft.revision)
		assertEquals(listOf(reason("mention")), save.draft.conditions)
		val expectedDelete = automationDraftOf(newer, HERE)!!
		assertEquals(
			expectedDelete.copy(trigger = unkeyed(expectedDelete.trigger), steps = unkeyed(expectedDelete.steps)),
			delete.draft.copy(trigger = unkeyed(delete.draft.trigger), steps = unkeyed(delete.draft.steps)),
		)
		assertEquals(AutomationOutcome.Done, outcomeOf(AutomationSaved.Stored(newer), draft, false, HERE))
		assertEquals(AutomationOutcome.Said("no"), outcomeOf(AutomationSaved.Refused("no"), draft, false, HERE))
		assertEquals(
			AutomationOutcome.Said("same"),
			outcomeOf(AutomationSaved.Refused("same", row("a", event(), revision = 2L)), draft, false, HERE),
		)
		assertEquals(AutomationOutcome.Said(AutomationSaid.Confirm(listOf("Send to IFTTT"))), asks)
		assertEquals(AutomationOutcome.Said(AutomationSaid.Hole(draft.steps[0].key, "message", 3, 6, "no name x here", "")), hole)
	}

	@Test
	fun aDraftAsksBeforeLeavingOnlyOnceItDiffersFromWhatOpened() {
		val opened = automationDraftOf(row("a", event(reason("mention"))), HERE)!!

		assertEquals(false, opened.changedFrom(opened))
		assertEquals(true, opened.withAction(opened.steps[0].key, quietly).changedFrom(opened))
		assertEquals(true, opened.withCondition(fields).changedFrom(opened))
		assertEquals(true, opened.withSource("other").changedFrom(opened))
	}

	@Test
	fun aRowSaysWhatItDoesWhenItRanOrRunsNextAndHowManyUseASource() {
		val rows = listOf(
			row("a", event()),
			row("b", event(tell = "quietly"), lastRanAt = 9L),
			row("c", alert),
			row("d", event(), lastRanAt = 9L, nextRunAt = 20L),
		)
		val lamp = event().copy(actions = listOf(AutomationAction.DeviceSet(PLUG, "on"), AutomationAction.IftttTrigger("door")))

		val tellOnly = Served.Known(TELL_ONLY)
		assertEquals("Tell the assistant: Now", doesText(event(), tellOnly))
		assertEquals("switch_plug · Tell the assistant: Quietly", doesText(event().copy(actions = listOf(future, AutomationAction.TellAssistant("quietly"))), tellOnly))
		assertEquals("Switch a plug: Desk lamp, On · Send to IFTTT: door", doesText(lamp, Served.Known(FULL)))
		assertEquals("device_set · ifttt_trigger", doesText(lamp, tellOnly))
		assertEquals("tell_assistant", doesText(event(), Served.Unknown(ListEmpty.Reading)))
		assertEquals(
			listOf("Never ran", "Ran 9 ago", "Never ran", "Next at 20"),
			rows.map { ranText(it, { at -> "$at ago" }, { at -> "at $at" }) },
		)
		assertEquals(listOf("1 uses this source", "2 use this source"), listOf(1, 2).map(::usesText))
		assertEquals("reason, repository", producesText(SPECS))
	}

	@Test
	fun thePreviewHeadCountsMatchesAndSaysNothingForNoEvents() {
		assertEquals("Would have matched 2 of the last 50", previewHead(ConsoleAutomationPreviewResult(2L, 50L, emptyList())))
		assertNull(previewHead(ConsoleAutomationPreviewResult(0L, 0L, emptyList())))
	}

	@Test
	fun groupsListEveryListedGatewayTheHomeFirstAndOnlyTheHomesRowsEdit() {
		val noValue = SANDBOX_SERVES.copy(triggers = SANDBOX_SERVES.triggers.filter { it.kind != "value" })
		fun entry(id: String, rows: List<AutomationRow>?) =
			GatewayEntry(
				id,
				connected = true,
				incarnation = 1L,
				lastRegisteredAt = 1L,
				automations = rows?.let { GatewayList.Listed(it) } ?: GatewayList.NotServed,
				automationServes = noValue,
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

		val groups = automationGroups(registry, placed("sakura"))

		assertEquals(listOf("sakura" to true, "mikan" to false, "idle" to false), groups.map { it.gatewayId to it.assistant })
		assertEquals(listOf(true, false, false), groups.flatMap { group -> group.rows.map { opensIn(it, group.context) } })
		// Away unknown: nothing opens.
		val unplaced = automationGroups(registry, AssistantHome.Unread)
		assertEquals(listOf(false, false, false), unplaced.flatMap { group -> group.rows.map { opensIn(it, group.context) } })
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
		val serving = AssistantRead.Answered(assistantState(workdir = "~/notes", sources = emptyList()))

		assertEquals(ListEmpty.NoRoster, automationsEmpty(GatewayRegistry(), "sakura"))
		assertEquals(ListEmpty.Reading, automationsEmpty(registry("sakura" to GatewayList.Unread), "sakura"))
		assertEquals(ListEmpty.Unreachable, automationsEmpty(registry("sakura" to GatewayList.Unreachable), "sakura"))
		assertEquals(ListEmpty.NotServed(listOf("sakura")), automationsEmpty(registry("sakura" to GatewayList.NotServed), "sakura"))
		// Classified at landing.
		val refusedOnce = registry("sakura" to GatewayList.NotServed).withEntry("sakura") { it.copy(assistant = serving) }
		assertEquals(ListEmpty.NotServed(listOf("sakura")), automationsEmpty(refusedOnce, "sakura"))
		// A listed Gateway draws its own group.
		assertEquals(null, automationsEmpty(registry("sakura" to listed, "older" to GatewayList.NotServed), "sakura"))
		assertEquals(null, automationsEmpty(registry("older" to GatewayList.NotServed, "sakura" to listed), "older"))
		assertEquals(null, automationsEmpty(registry("sakura" to listed), null))
		val cached = registry("sakura" to GatewayList.Unread).copy(provenance = RegistryProvenance.Cached)
		assertEquals(ListEmpty.Reading, automationsEmpty(cached, "sakura"))
	}
}

class AutomationPartsTest {
	@Test
	fun aCrossingIsTypedInTheOwnersUnitAndSavedInTheStoredOne() {
		val typed = TriggerDraft.Crossing(SENSOR, "temperature", "below", "35.6", "0.9", "10", "C")
		val humid = TriggerDraft.Crossing(SENSOR, "humidity", "above", "70", "2", "0", "%")

		assertEquals(crossing, triggerOf(typed, FULL, "F"))
		assertEquals(typed, triggerDraftOf(crossing, FULL, "F"))
		assertEquals(typed.copy(threshold = "2.0", deadZone = "0.5"), triggerDraftOf(crossing, FULL, null))
		assertEquals(AutomationTrigger.Crossing(SENSOR, "humidity", "above", 70.0, 2.0, 0L), triggerOf(humid, FULL, "F"))
		assertEquals(listOf("0", "1.5", "1.67", "0.02", "1440"), listOf(0L, 90L, 100L, 1L, 86_400L).map(::coolDownTyped))
		assertEquals((0L..3_700L).toList(), (0L..3_700L).map { coolDownSecOf(coolDownTyped(it)) })
		assertEquals(listOf(null, null, null, 30L), listOf("", "-1", "1440.5", "0.5").map(::coolDownSecOf))
		assertEquals(listOf("°F", "°C", "%"), listOf(
			numberSuffix("C", "F"),
			numberSuffix("C", null),
			numberSuffix("%", "F"),
		).map(String::trim))
		val picked = humid.picked(FULL.number(SENSOR, "temperature")!!, FULL, "F")
		assertEquals("°F", numberSuffix(picked.unit, "F").trim())
		assertEquals("70" to "2", picked.threshold to picked.deadZone)
	}

	@Test
	fun aCrossingOpenedWithItsNumberAbsentSavesItsStoredValueOnceTheNumberReturns() {
		val missing = FULL.copy(numbers = FULL.numbers.filterNot { it.measure == "temperature" })
		val opened = triggerDraftOf(crossing, missing, "F") as TriggerDraft.Crossing

		assertEquals(null, triggerOf(opened, missing, "F"))
		assertEquals(crossing, triggerOf(opened, FULL, "F"))
		val temperature = FULL.number(SENSOR, "temperature")!!
		val repicked = opened.picked(temperature, FULL, "F")
		assertEquals(crossing, triggerOf(repicked, FULL, "F"))
		assertEquals(crossing, triggerOf(repicked.picked(temperature, FULL, "F"), FULL, "F"))
		val fine = crossing.copy(threshold = 1.67, deadZone = 0.28)
		val fineOpened = triggerDraftOf(fine, missing, "F") as TriggerDraft.Crossing
		assertEquals(fine, triggerOf(fineOpened, FULL, "F"))
		assertEquals(fine, triggerOf(fineOpened.picked(temperature, FULL, "F"), FULL, "F"))
		// Detour loses raw text
		val detour = opened.picked(FULL.number(SENSOR, "humidity")!!, FULL, "F").picked(temperature, FULL, "F")
		assertEquals("", detour.threshold)
		assertEquals(null, triggerOf(detour, FULL, "F"))
		assertEquals(2.0, (triggerOf(detour.copy(threshold = "35.6"), FULL, "F") as AutomationTrigger.Crossing).threshold, 0.01)
		assertEquals(
			listOf("°F", "°C", ""),
			listOf(
				crossingSuffix("C", "C", "F"),
				crossingSuffix(opened.unit, "C", "F"),
				crossingSuffix(opened.unit, null, "F"),
			).map(String::trim),
		)
	}

	@Test
	fun aDraftKeepsTheUnitItWasTypedInThroughASaveAReopenAndADeleteRebase() {
		val watched = event().copy(trigger = crossing)
		val draft = automationDraftOf(row("a", watched, revision = 2L), FULL_HERE, "F")!!
		val colder = crossing.copy(threshold = 1.0)
		val fresh = newAutomationDraft(FULL_HERE, ZONE, watch = SENSOR, display = "F")!!.onCrossing { it.copy(threshold = "35.6") }
		val newer = row("a", watched.copy(trigger = colder), revision = 5L)
		val rebased = (outcomeOf(AutomationSaved.Refused("moved", newer), draft, deleting = true, FULL_HERE) as AutomationOutcome.Offer).draft

		assertEquals(crossing, draft.toAutomation(FULL)?.trigger)
		assertEquals(colder, draft.onCrossing { it.copy(threshold = "33.8") }.toAutomation(FULL)?.trigger)
		assertEquals(draft.trigger, automationDraftOf(row("a", draft.toAutomation(FULL)!!), FULL_HERE, "F")?.trigger)
		assertEquals(2.0, (fresh.toAutomation(FULL)?.trigger as AutomationTrigger.Crossing).threshold, 0.0)
		assertEquals("33.8" to colder, (rebased.trigger as TriggerDraft.Crossing).threshold to rebased.toAutomation(FULL)?.trigger)
	}

	@Test
	fun aTriggerThatCannotBeSavedSaysWhyOnceItsFieldIsTyped() {
		val blank = TriggerDraft.Crossing(SENSOR, "temperature", "below", "", "0.5", "10", "C")
		val says = { trigger: TriggerDraft -> listOf(triggerIssue(trigger, FULL) != null, triggerHint(trigger, FULL) != null) }

		assertEquals(listOf(true, false), says(blank))
		assertEquals(listOf(true, true), says(blank.copy(coolDownMin = "2000")))
		assertEquals(listOf(true, true), says(blank.copy(threshold = "warm")))
		assertEquals(listOf(true, true), says(blank.copy(threshold = "2", deadZone = "-1")))
		assertEquals(listOf(true, true), says(blank.copy(threshold = "2", coolDownMin = "2000")))
		assertEquals(listOf(true, true), says(blank.copy(device = "gone", threshold = "2")))
		assertEquals(listOf(true, true), says(TriggerDraft.Time("18:00", emptySet(), ZONE)))
		assertEquals(listOf(true, false), says(TriggerDraft.Interval("", IntervalUnit.HOURS)))
		assertEquals(listOf(true, true), says(TriggerDraft.Interval("8", IntervalUnit.DAYS)))
		assertEquals(listOf(false, false), says(TriggerDraft.Interval("7", IntervalUnit.DAYS)))
	}

	@Test
	fun aClockBuildsItsTriggerAndReadsBackInItsLargestWholeUnit() {
		val evening = TriggerDraft.Time("18:30", setOf(3, 1), ZONE)

		assertEquals(AutomationTrigger.Time("18:30", listOf(1L, 3L), ZONE), triggerOf(evening, FULL, null))
		assertEquals(evening, triggerDraftOf(AutomationTrigger.Time("18:30", listOf(1L, 3L), ZONE), FULL, null))
		assertEquals(AutomationTrigger.Interval(120L), triggerOf(TriggerDraft.Interval("2", IntervalUnit.HOURS), FULL, null))
		assertEquals(
			listOf(
				TriggerDraft.Interval("90", IntervalUnit.MINUTES),
				TriggerDraft.Interval("2", IntervalUnit.HOURS),
				TriggerDraft.Interval("1", IntervalUnit.DAYS),
			),
			listOf(90L, 120L, 1_440L).map { triggerDraftOf(AutomationTrigger.Interval(it), FULL, null) },
		)
	}

	@Test
	fun aTriggerSwappedAwayComesBackAsItWasLeft() {
		val opened = eventDraft(reason("mention"))
		val fresh = { choice: TriggerChoice -> { freshTrigger(choice, FULL, "github", ZONE) } }

		val timed = opened.swapped(TriggerChoice.TIME.kinds, fresh(TriggerChoice.TIME)).onTime { it.copy(time = "21:15") }
		val every = timed.swapped(setOf("interval")) { TriggerDraft.Interval("3", IntervalUnit.HOURS) }
		val back = every.swapped(TriggerChoice.EVENT.kinds, fresh(TriggerChoice.EVENT))
		val again = back.swapped(TriggerChoice.TIME.kinds, fresh(TriggerChoice.TIME))

		assertEquals(TriggerDraft.Time("21:15", (1..7).toSet(), ZONE), timed.trigger)
		assertEquals(opened.trigger, back.trigger)
		assertEquals(TriggerDraft.Interval("3", IntervalUnit.HOURS), again.trigger)
		assertEquals(timed.trigger, again.swapped(setOf("time")) { null }.trigger)
		assertEquals(false, back.changedFrom(opened))
	}

	@Test
	fun theChoicesFollowWhatTheGatewayHoldsAndWhetherTheAssistantLivesThere() {
		val offered = { offer: AutomationOffer, sources: Boolean -> TriggerChoice.entries.filter { offersChoice(offer, it, sources) } }
		val away = FULL.copy(away = true)
		val kinds = { offer: AutomationOffer -> addableActions(offer, emptyList()).map { it.kind } }

		assertEquals(TriggerChoice.entries, offered(FULL, true))
		assertEquals(listOf(TriggerChoice.CROSSING, TriggerChoice.TIME), offered(FULL, false))
		assertEquals(listOf(TriggerChoice.CROSSING, TriggerChoice.TIME), offered(away, true))
		assertEquals(listOf(TriggerChoice.EVENT, TriggerChoice.TIME), offered(FULL.copy(numbers = emptyList()), true))
		assertEquals(listOf(TriggerChoice.EVENT), offered(TELL_ONLY, true))
		assertEquals(listOf("tell_assistant", "device_set", "ifttt_trigger"), kinds(FULL))
		assertEquals(listOf("device_set"), kinds(away))
		assertEquals(listOf("tell_assistant", "ifttt_trigger"), kinds(FULL.copy(switches = emptyList())))
		val held = listOf(toldDraft("now"), iftttDraft("door", "open"), ActionDraft.Kept(AutomationAction.TellAssistant("now")), plugDraft(PLUG, "on"))
		assertEquals(listOf(true, true, true, false), held.map { actionWarning(it, away) != null })
		assertEquals(listOf(false, false, false, false), held.map { actionWarning(it, FULL) != null || actionIssue(it, away) != null })
		val leftBehind = Automation(enabled = true, trigger = crossing, actions = listOf(AutomationAction.DeviceSet(PLUG, "on"), AutomationAction.TellAssistant("now")))
		assertEquals(leftBehind, automationDraftOf(row("a", leftBehind), EditContext(away, emptyList()))!!.toAutomation(away))
		assertEquals(
			listOf("Switch a plug: Desk lamp, On", "Tell the assistant: Now (only where the assistant lives)"),
			doesText(leftBehind, Served.Known(away)).split(" · "),
		)
		assertEquals("Switch a plug: Desk lamp, On · Tell the assistant: Now", doesText(leftBehind, Served.Known(FULL)))
		assertEquals(
			emptyList<ActionOffer>(),
			addableActions(FULL, List(Protocol.Wire.AUTOMATION_ACTIONS_MAX) { index -> StepDraft.Do("action-$index", toldDraft("now")) }),
		)
	}

	@Test
	fun aNewAutomationStartsOnlyWhereATriggerAndAnActionAreBothOnOffer() {
		fun entry(id: String, serves: AutomationServes, placed: Boolean) = GatewayEntry(
			id,
			connected = true,
			incarnation = 1L,
			lastRegisteredAt = 1L,
			automations = GatewayList.Listed(emptyList()),
			automationServes = serves,
			assistant = AssistantRead.Answered(assistantState(workdir = "~/notes", sources = listOf(source("github")))).takeIf { placed } ?: AssistantRead.Reading,
		)
		val eventsOnly = SANDBOX_SERVES.copy(triggers = SANDBOX_SERVES.triggers.filter { it.kind == "event" })
		val registry = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(
				entry("sakura", SANDBOX_SERVES, placed = true),
				entry("mikan", SANDBOX_SERVES, placed = false),
				entry("events", eventsOnly, placed = false),
			),
		)
		val all = listOf("sakura", "mikan", "events")
		val there = newAutomationDraft(EditContext(offerOf(SANDBOX_SERVES, away = true), emptyList()), ZONE)!!

		assertEquals(listOf("sakura", "mikan"), newAutomationGateways(registry, all, placed("sakura")))
		assertEquals(listOf("mikan"), newAutomationGateways(registry, listOf("mikan", "events"), placed("sakura")))
		assertEquals(listOf("sakura", "mikan"), newAutomationGateways(registry, all, placed(null)))
		// Unread home: none. Unread list: waits.
		assertEquals(emptyList<String>(), newAutomationGateways(registry, all, AssistantHome.Unread))
		val unlisted = registry.withEntry("events") { it.copy(automations = GatewayList.Unread) }
		assertEquals(all, newAutomationGateways(unlisted, all, placed("sakura")))
		assertEquals("crossing" to listOf("device_set"), there.trigger.kind to there.steps.map { (it as StepDraft.Do).action.kind })
	}

	@Test
	fun aNewAutomationWatchingASensorStartsOnACrossingOfItsFirstNumberOrNotAtAll() {
		val watched = newAutomationDraft(FULL_HERE, ZONE, watch = SENSOR)!!
		val noCrossing = FULL.copy(triggers = FULL.triggers.filter { it.kind in setOf("event", "time") })
		val otherSensor = FULL.copy(numbers = FULL.numbers.map { it.copy(device = "aa:00") })

		assertEquals(freshTrigger(TriggerChoice.CROSSING, FULL, null, ZONE), watched.trigger)
		assertEquals(SENSOR to "temperature", (watched.trigger as TriggerDraft.Crossing).let { it.device to it.measure })
		assertEquals(watched.trigger, openedDraft(AutomationSlot.New(watch = SENSOR), null, FULL_HERE, zone = ZONE)?.trigger)
		assertNull(newAutomationDraft(EditContext(noCrossing, emptyList()), ZONE, watch = SENSOR))
		assertNull(newAutomationDraft(EditContext(otherSensor, emptyList()), ZONE, watch = SENSOR))
		assertEquals(listOf(true, false, false), listOf(FULL, noCrossing, otherSensor).map { offersWatch(SENSOR, known(it)) })
		assertEquals(false, offersWatch(SENSOR, AutomationContext(Served.Unknown(ListEmpty.Reading), HomeSources.Known(emptyList()))))
	}

	@Test
	fun aGatewaysOfferIsKnownOnlyFromAListingThatArrivedAndAnOpenEditKeepsItsOwnThroughARestart() {
		val github = listOf(source("github"))
		fun registry(list: GatewayList<AutomationRow>, serves: AutomationServes?, word: AssistantRead) = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(
				GatewayEntry(
					"sakura",
					connected = true,
					incarnation = 1L,
					lastRegisteredAt = 1L,
					automations = list,
					automationServes = serves,
					assistant = word,
				),
			),
		)
		val answered = AssistantRead.Answered(assistantState(sources = github))
		val listed = GatewayList.Listed(emptyList<AutomationRow>())
		val context = { list: GatewayList<AutomationRow>, serves: AutomationServes?, word: AssistantRead, home: AssistantHome ->
			automationContext(registry(list, serves, word), home, "sakura")
		}

		val atHome = context(listed, SANDBOX_SERVES, answered, placed("sakura"))
		assertEquals(AutomationContext(Served.Known(offerOf(SANDBOX_SERVES, away = false)), HomeSources.Known(github)), atHome)
		assertEquals(Served.Unknown(ListEmpty.Reading), context(listed, null, answered, placed("sakura")).served)
		assertEquals(Served.Known(offerOf(SANDBOX_SERVES, away = true)), context(listed, SANDBOX_SERVES, answered, placed("mikan")).served)
		assertEquals(HomeSources.Known(emptyList()), context(listed, SANDBOX_SERVES, answered, placed("mikan")).sources)
		assertEquals(
			listOf(Served.Unknown(ListEmpty.Reading), Served.Unknown(ListEmpty.Unreachable), Served.Unknown(ListEmpty.NotServed(listOf("sakura")))),
			listOf(GatewayList.Unread, GatewayList.Unreachable, GatewayList.NotServed).map { context(it, SANDBOX_SERVES, answered, placed("sakura")).served },
		)
		assertEquals(Served.Unknown(ListEmpty.Reading), context(listed, SANDBOX_SERVES, answered, AssistantHome.Unread).served)
		assertEquals(
			listOf(HomeSources.Reading, HomeSources.Refused),
			listOf(AssistantRead.Reading, AssistantRead.Refused).map { context(listed, SANDBOX_SERVES, it, placed("sakura")).sources },
		)
		// Restart: the edit keeps its own.
		val minted = atHome.minted()!!
		val restarted = context(GatewayList.Unread, null, AssistantRead.Reading, placed("sakura"))
		assertEquals(null, restarted.minted())
		assertEquals(minted, restarted.over(minted))
		val fewer = SANDBOX_SERVES.copy(switches = emptyList())
		val reread = context(listed, fewer, answered, placed("sakura"))
		assertEquals(EditContext(offerOf(fewer, away = false), github), reread.over(minted))
	}

	@Test
	fun anEditorWaitsOnItsGatewaysListAndANewOneAtTheHomeOnItsWordAndSaysWhatItWaitsOn() {
		fun registry(list: GatewayList<AutomationRow>, word: AssistantRead?) = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(
				GatewayEntry(
					"sakura",
					connected = true,
					incarnation = 1L,
					lastRegisteredAt = 1L,
					automations = list,
					automationServes = SANDBOX_SERVES,
					assistant = word ?: AssistantRead.Reading,
				),
			),
		)
		val listed = GatewayList.Listed(emptyList<AutomationRow>())
		val standing = { list: GatewayList<AutomationRow>, word: AssistantRead?, home: String? ->
			automationStanding(automationContext(registry(list, word), placed(home), "sakura"), held = null)
		}

		assertEquals(EditStanding.READING, standing(GatewayList.Unread, AssistantRead.Refused, "sakura"))
		assertEquals(EditStanding.UNREACHABLE, standing(GatewayList.Unreachable, AssistantRead.Refused, "sakura"))
		assertEquals(EditStanding.NOT_SERVED, standing(GatewayList.NotServed, AssistantRead.Refused, "sakura"))
		assertEquals(EditStanding.READING, standing(listed, null, "sakura"))
		assertEquals(EditStanding.READY, standing(listed, AssistantRead.Refused, "sakura"))
		assertEquals(EditStanding.READY, standing(listed, null, "mikan"))
		val atHome = automationContext(registry(listed, null), placed("sakura"), "sakura")
		assertEquals(EditStanding.GONE, automationStanding(atHome, held = Lookup.Gone))
		assertEquals(EditStanding.READY, automationStanding(atHome, held = Lookup.Found(row("a", event()))))
		// Unread home waits a held row.
		val unplaced = automationContext(registry(listed, null), AssistantHome.Unread, "sakura")
		assertEquals(EditStanding.READING, automationStanding(unplaced, held = Lookup.Found(row("a", event()))))
		val said = { slot: AutomationSlot, standing: EditStanding -> unopenedLine(slot, standing) }
		assertEquals(listOf(null, null), listOf(AutomationSlot.New(), AutomationSlot.Held("a")).map { said(it, EditStanding.READING) })
		assertEquals(waitingLine(EditStanding.UNREACHABLE), said(AutomationSlot.New(), EditStanding.UNREACHABLE))
		assertEquals(false, said(AutomationSlot.New(), EditStanding.READY) == said(AutomationSlot.Held("a"), EditStanding.READY))
	}

	@Test
	fun anActionBuildsItsWireFormAndSaysWhyItCannot() {
		val door = iftttDraft("door", "open")
		val told = toldDraft("quietly", "It is {value}")
		val issues = { action: ActionDraft -> listOf(actionIssue(action, FULL) != null, actionHint(action, FULL) != null) }
		val built = { action: ActionDraft -> actionOf(action, FULL) }

		assertEquals(AutomationAction.TellAssistant("now"), built(toldDraft("now", " ")))
		assertEquals(AutomationAction.TellAssistant("quietly", "It is {value}"), built(told))
		assertEquals(AutomationAction.IftttTrigger("door", value1 = "open"), built(door))
		assertEquals(listOf(told, door, ActionDraft.Kept(future)), listOf(built(told)!!, built(door)!!, future).map { actionDraftOf(it, FULL) })
		assertEquals(future, built(ActionDraft.Kept(future)))
		assertEquals(listOf(true, false), issues(withValue(door, "event", "")))
		assertEquals(listOf(true, true), issues(withValue(door, "event", "front door")))
		assertEquals(listOf(true, true), issues(plugDraft("gone", "on")))
		assertEquals(listOf(false, false), issues(plugDraft(PLUG, "toggle")))
		assertEquals(listOf(true, true), issues(withValue(told, "message", "x".repeat(1_001))))
		assertEquals(listOf(true, true), issues(withValue(told, "when", "later")))
		val toggle = AutomationAction.DeviceSet(PLUG, "toggle")
		assertEquals("Switch a plug: Desk lamp, Toggle", doesLine(actionDraftOf(toggle, FULL), kindOf(toggle), FULL))
		assertEquals(iftttDraft("door", "open", "now"), withValue(door, "value2", "now"))
		assertEquals("Each time it runs it will send to IFTTT, without asking you.", confirmBody(listOf("Send to IFTTT")))
	}

	@Test
	fun eachServedActionIsDrawnOnlyWhenEveryParameterIsAndReadsBackAsItWasStored() {
		val body = javaClass.classLoader!!.getResourceAsStream("protocol/automation-list-result-serves.json")!!.bufferedReader().use { it.readText() }
		val served = wireJson.decodeFromString<ConsoleAutomationListResult>(body).serves
		val offer = offerOf(served, away = false)
		val called = AutomationAction.RunFunction(
			"warm-up",
			values = buildJsonObject { put("room", "aa:bb:cc:dd:ee:01") },
		)
		val stored = listOf(
			AutomationAction.TellAssistant("quietly", "It is {value}"),
			AutomationAction.DeviceSet("aa:bb:cc:dd:ee:ff", "toggle"),
			AutomationAction.IftttTrigger("door_open", value2 = "two"),
			called,
		)
		val drafts = stored.map { actionDraftOf(it, offer) }

		assertEquals(listOf(true, true, true, false), offer.actions.map { it.drawable })
		assertEquals(listOf(true, true, true, false), drafts.map { it is ActionDraft.Filled })
		assertEquals(ActionDraft.Kept(called), drafts.last())
		assertEquals("Run a function", doesLine(drafts.last(), kindOf(called), offer))
		assertEquals(listOf("tell_assistant", "device_set", "ifttt_trigger"), addableActions(offer, emptyList()).map { it.kind })
		assertEquals(stored, drafts.map { actionOf(it, offer) })
		assertEquals(SANDBOX_SERVES.actions, served.actions)
		assertEquals(SANDBOX_SERVES.triggers, served.triggers)
	}

	@Test
	fun anActionTheEditorCannotDrawWholeIsKeptAsSentAndSavedAsItWas() {
		val messaged = AutomationAction.TellAssistant("now", "It is {value}")
		val lamp = AutomationAction.DeviceSet(PLUG, "on")
		val dialled = FULL.copy(
			actions = FULL.actions.map { row -> if (row.kind == "device_set") row.copy(params = row.params + ParamOffer("level", "Level", "dial")) else row },
		)
		val retired = FULL.copy(actions = FULL.actions.filter { it.kind != "device_set" })
		val kept = { action: AutomationAction, offer: AutomationOffer -> actionDraftOf(action, offer) is ActionDraft.Kept }

		assertEquals(listOf(false, true, true, true), listOf(kept(lamp, FULL), kept(lamp, dialled), kept(lamp, retired), kept(messaged, TELL_ONLY)))
		assertEquals(messaged, actionOf(actionDraftOf(messaged, TELL_ONLY), TELL_ONLY))
		assertEquals(listOf("tell_assistant", "ifttt_trigger"), addableActions(dialled, emptyList()).map { it.kind })
		val voiced = FULL.copy(
			actions = FULL.actions.map { row -> if (row.kind == "tell_assistant") row.copy(params = row.params + ParamOffer("voice", "Voice", "word")) else row },
		)
		val chime = ActionOffer("chime", "Ring a chime", danger = false, params = listOf(ParamOffer("tone", "Tone", "word")))
		val ringing = FULL.copy(actions = FULL.actions + chime)
		val sent = { action: AutomationAction? -> wireJson.encodeToJsonElement(AutomationAction.serializer(), action!!).toString() }
		assertEquals(
			"""{"kind":"tell_assistant","when":"now","voice":"calm"}""",
			sent(actionOf(withValue(toldDraft("now", ""), "voice", "calm"), voiced)),
		)
		assertEquals(
			"""{"kind":"chime","tone":"low"}""",
			sent(actionOf(withValue(freshAction("chime", ringing)!!, "tone", "low"), ringing)),
		)
		assertNotNull(actionIssue(plugDraft(PLUG, "on"), retired))
		assertNull(actionOf(plugDraft(PLUG, "on"), retired))
		// Unnamed message blocks save.
		assertNotNull(actionIssue(toldDraft("now", "Hi"), TELL_ONLY))
		assertNull(actionOf(toldDraft("now", "Hi"), TELL_ONLY))
		assertEquals(AutomationAction.TellAssistant("now"), actionOf(toldDraft("now", " "), TELL_ONLY))
		assertEquals(lamp, automationDraftOf(row("a", event().copy(actions = listOf(lamp))), EditContext(retired, emptyList()))!!.toAutomation(retired)!!.let(::written).single())
	}

	@Test
	fun aValueItsRowNoLongerNamesIsDrawnStrayAndClearedInPlace() {
		val told = toldDraft("now", "Hi")
		val opened = eventDraft()
		val draft = opened.withAction(opened.steps.single().key) { told }
		val cleared = draft.withAction(draft.steps.single().key) { withoutValue(it, "message") }
		val retired = FULL.copy(actions = FULL.actions.filter { it.kind != "tell_assistant" })
		val key = draft.steps.single().key

		assertEquals(listOf("when" to true, "message" to false), actionFields(told, TELL_ONLY).map { it.name to (it.param != null) })
		assertEquals(null, draft.toAutomation(TELL_ONLY))
		assertEquals(null, actionIssue((cleared.steps.single() as StepDraft.Do).action, TELL_ONLY))
		assertEquals(AutomationAction.TellAssistant("now"), cleared.toAutomation(TELL_ONLY)?.let(::written)?.single())
		assertEquals(true, actionFields(told, FULL).all { it.param != null })
		assertEquals(told, withoutValue(told, "voice"))
		assertEquals(listOf(false, true, true), listOf(canRemove(draft, key, FULL), canRemove(draft, key, retired), canRemove(draft.plusAction(told), key, FULL)))
	}

	@Test
	fun aTextWithAHoleShowsWhatTheGatewayMadeOfItAndAPlainOneAsksNothing() {
		val answered = { filled: String?, hole: AutomationPreviewHole? ->
			PreviewRead(ConsoleAutomationPreviewResult(0L, 0L, emptyList(), filled = filled, hole = hole))
		}
		val text = "It is {valu} out"

		assertEquals(TextPreview.Plain, textPreviewOf("It is cold", asked = true, PreviewRead()))
		assertEquals(TextPreview.Plain, textPreviewOf("a \\{brace\\}", asked = true, PreviewRead()))
		assertEquals(TextPreview.Plain, textPreviewOf(text, asked = false, PreviewRead()))
		assertEquals(TextPreview.Asking, textPreviewOf(text, asked = true, PreviewRead()))
		assertEquals(TextPreview.Unread, textPreviewOf(text, asked = true, PreviewRead(failed = true)))
		assertEquals(TextPreview.Filled("It is 1.8 °C out"), textPreviewOf(text, asked = true, answered("It is 1.8 °C out", null)))
		assertEquals(
			TextPreview.Refused("no name valu here", 6, 12),
			textPreviewOf(text, asked = true, answered(null, AutomationPreviewHole(6L, 12L, "no name valu here"))),
		)
		assertEquals("{valu}: no name valu here", holeLine(text, "no name valu here", 6, 12))
		assertEquals("Missing }", holeLine(text, "missing }", 40, 50))
		val refused = AutomationSaid.Hole("key-1", "value2", 0, 4, "no", "{x} here")
		assertEquals(
			listOf(refused, null, null, null),
			listOf(Triple("key-1", "value2", "{x} here"), Triple("key-0", "value2", "{x} here"), Triple("key-1", "value1", "{x} here"), Triple("key-1", "value2", "{y} here"))
				.map { (at, param, text) -> refusedHole(refused, at, param, text) },
		)
		val kept = eventDraft().copy(steps = listOf(StepDraft.Do(EVENT_ACTION_KEY, ActionDraft.Kept(future))))
		val messaged = eventDraft().copy(steps = listOf(StepDraft.Do(EVENT_ACTION_KEY, toldDraft("now", "{x} here"))))
		val onKept = AutomationSaid.Hole(EVENT_ACTION_KEY, "message", 0, 3, "no name x", "")
		val onField = AutomationSaid.Hole(EVENT_ACTION_KEY, "message", 0, 3, "no name x", "{x} here")
		val shown = { said: AutomationSaid?, draft: AutomationDraft, offer: AutomationOffer -> generalLine(said, draft, offer) != null }
		assertEquals(
			listOf(true, false, true, true, false),
			listOf(
				shown(onKept, kept, FULL),
				shown(onField, messaged, FULL),
				shown(onField, messaged, TELL_ONLY),
				shown(AutomationSaid.Line("no"), messaged, FULL),
				shown(null, messaged, FULL),
			),
		)
	}

	@Test
	fun aPreviewAsksOnlyAboutATriggerThatCouldBeSavedHere() {
		val sources = listOf(source("github"))
		val timed = eventDraft().copy(trigger = TriggerDraft.Time("18:00", setOf(1), ZONE))

		assertEquals(event(reason("mention")).trigger, askedTrigger(eventDraft(reason("mention")), fields, sources, FULL))
		assertNull(askedTrigger(eventDraft(reason()), fields, sources, FULL))
		assertNull(askedTrigger(eventDraft(reason("mention", test = "contains")), fields, sources, FULL))
		assertEquals(event(reason("retired")).trigger, askedTrigger(eventDraft(reason("retired")), fields, sources, FULL))
		assertNull(askedTrigger(eventDraft(), fields, emptyList(), FULL))
		assertNotNull(askedTrigger(timed, fields, emptyList(), FULL))
		assertNull(askedTrigger(timed, fields, emptyList(), TELL_ONLY))
	}
}
