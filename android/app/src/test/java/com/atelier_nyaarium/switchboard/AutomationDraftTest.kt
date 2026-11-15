package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.ActionDraft
import com.atelier_nyaarium.switchboard.assistant.ActionOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationEditing
import com.atelier_nyaarium.switchboard.assistant.AutomationOffer
import com.atelier_nyaarium.switchboard.assistant.AutomationOutcome
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.IntervalUnit
import com.atelier_nyaarium.switchboard.assistant.NumberOffer
import com.atelier_nyaarium.switchboard.assistant.PreviewRead
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.SwitchOffer
import com.atelier_nyaarium.switchboard.assistant.TextPreview
import com.atelier_nyaarium.switchboard.assistant.TriggerChoice
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.actionDraftOf
import com.atelier_nyaarium.switchboard.assistant.actionHint
import com.atelier_nyaarium.switchboard.assistant.actionIssue
import com.atelier_nyaarium.switchboard.assistant.actionLine
import com.atelier_nyaarium.switchboard.assistant.actionOf
import com.atelier_nyaarium.switchboard.assistant.addableActions
import com.atelier_nyaarium.switchboard.assistant.askedTrigger
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.automationEditing
import com.atelier_nyaarium.switchboard.assistant.automationGroups
import com.atelier_nyaarium.switchboard.assistant.automationStanding
import com.atelier_nyaarium.switchboard.assistant.automationsEmpty
import com.atelier_nyaarium.switchboard.assistant.confirmBody
import com.atelier_nyaarium.switchboard.assistant.doesText
import com.atelier_nyaarium.switchboard.assistant.editable
import com.atelier_nyaarium.switchboard.assistant.fittingAutomation
import com.atelier_nyaarium.switchboard.assistant.freshTrigger
import com.atelier_nyaarium.switchboard.assistant.holeLine
import com.atelier_nyaarium.switchboard.assistant.newAutomationDraft
import com.atelier_nyaarium.switchboard.assistant.newAutomationGateways
import com.atelier_nyaarium.switchboard.assistant.numberSuffix
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.offersChoice
import com.atelier_nyaarium.switchboard.assistant.openedDraft
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.assistant.previewHead
import com.atelier_nyaarium.switchboard.assistant.producesText
import com.atelier_nyaarium.switchboard.assistant.ranText
import com.atelier_nyaarium.switchboard.assistant.refusedHole
import com.atelier_nyaarium.switchboard.assistant.sourceChoices
import com.atelier_nyaarium.switchboard.assistant.testsOf
import com.atelier_nyaarium.switchboard.assistant.textPreviewOf
import com.atelier_nyaarium.switchboard.assistant.triggerDraftOf
import com.atelier_nyaarium.switchboard.assistant.triggerHint
import com.atelier_nyaarium.switchboard.assistant.triggerIssue
import com.atelier_nyaarium.switchboard.assistant.triggerOf
import com.atelier_nyaarium.switchboard.assistant.usesOf
import com.atelier_nyaarium.switchboard.assistant.usesText
import com.atelier_nyaarium.switchboard.assistant.withHole
import com.atelier_nyaarium.switchboard.assistant.withText
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewHole
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantStateResult
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

private val FULL = AutomationOffer(
	triggers = setOf("event", "crossing", "time", "interval"),
	actions = listOf(
		ActionOffer("tell_assistant", "Tell the assistant", false),
		ActionOffer("device_set", "Switch a plug", false),
		ActionOffer("ifttt_trigger", "Send to IFTTT", true),
	),
	numbers = listOf(
		NumberOffer(SENSOR, "temperature", "Outside temperature", "C", 1),
		NumberOffer(SENSOR, "humidity", "Outside humidity", "%", 0),
	),
	switches = listOf(SwitchOffer(PLUG, "Desk lamp")),
)

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

private fun eventDraft(vararg conditions: AutomationCondition) =
	AutomationDraft("a", TriggerDraft.Event("github", conditions.toList()), listOf(ActionDraft.Tell("now", "")), true, 0L)

private val quietly: (ActionDraft) -> ActionDraft = { ActionDraft.Tell("quietly", "") }

private fun row(
	id: String,
	automation: Automation,
	revision: Long = 1L,
	device: String? = null,
	lastRanAt: Long? = null,
	nextRunAt: Long? = null,
) = AutomationRow(id, revision, automation, sentence = id, lastRanAt = lastRanAt, nextRunAt = nextRunAt, device = device)

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
		val onText = eventDraft(AutomationCondition("repository", "contains", "atelier"))
		val onChoice = eventDraft(reason("mention", "is_not"))

		assertEquals(reason(""), onText.withField(0, "reason", fields).conditions.single())
		assertEquals(AutomationCondition("repository", "is_not", ""), onChoice.withField(0, "repository", fields).conditions.single())
		assertEquals(listOf("is", "is_not"), testsOf(fields.specOf("reason")))
		assertEquals(listOf("subscribed", "review_requested", "mention"), fields.choicesFor("reason", "subscribed"))
		assertEquals(emptyList<AutomationCondition>(), onText.withSource("other").conditions)
	}

	@Test
	fun anEditKeepsWhatTheEditorDoesNotShow() {
		val held = event(reason("mention")).copy(label = "Kept", actions = listOf(future, AutomationAction.TellAssistant("now")))
		val draft = automationDraftOf(row("a", held, revision = 3L))!!.withAction(1, quietly)

		val saved = draft.toAutomation()!!

		assertEquals("Kept", saved.label)
		assertEquals(listOf(future, AutomationAction.TellAssistant("quietly")), saved.actions)
		assertEquals(3L, draft.revision)
	}

	@Test
	fun aRowIsEditableOnlyWhereItsGatewayHoldsItsTriggerAndTheEditorCanDrawItWhole() {
		val watched = event().copy(trigger = crossing)

		assertEquals(true, editable(row("a", event())))
		assertEquals(false, editable(row("a", event(), device = SENSOR)))
		assertEquals(false, editable(row("a", alert)))
		assertEquals(false, editable(row("a", event().copy(actions = listOf(future)))))
		assertEquals(false, editable(row("a", event().copy(trigger = AutomationTrigger.Unknown("moon", buildJsonObject {})))))
		assertEquals(listOf(false, true), listOf(AutomationOffer(), FULL).map { editable(row("a", watched), it) })
		assertNull(openedDraft(AutomationSlot.Held("a"), row("a", alert), listOf(source("github"))))
		assertNotNull(openedDraft(AutomationSlot.Held("a"), row("a", event()), listOf(source("github"))))
	}

	@Test
	fun theEditorAllowsEditingSavingAndDeletingOnlyWhenItCan() {
		val valid = automationDraftOf(row("a", event(reason("mention"))))!!
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
	fun aRefusedSaveOffersWhatIsHeldAsksForAGoAheadOrMarksTheHoleItFailedOn() {
		val draft = automationDraftOf(row("a", event(reason("mention")), revision = 2L))!!.withAction(0, quietly)
		val newer = row("a", event(reason("review_requested")), revision = 5L)
		val refused = AutomationSaved.Refused("revision 5 is stored", newer)
		val span = AutomationHoleSpan(0L, "message", 3L, 6L)

		val save = outcomeOf(refused, draft) as AutomationOutcome.Offer
		val delete = outcomeOf(refused, draft, deleting = true) as AutomationOutcome.Offer
		val asks = outcomeOf(AutomationSaved.Refused("confirm", confirm = listOf("Send to IFTTT")), draft)
		val hole = outcomeOf(AutomationSaved.Refused("no name x here", hole = span), draft)

		assertEquals(5L, save.draft.revision)
		assertEquals(listOf(reason("mention")), save.draft.conditions)
		assertEquals(automationDraftOf(newer), delete.draft)
		assertEquals(AutomationOutcome.Done, outcomeOf(AutomationSaved.Stored(newer), draft))
		assertEquals(AutomationOutcome.Said("no"), outcomeOf(AutomationSaved.Refused("no"), draft))
		assertEquals(
			AutomationOutcome.Said("same"),
			outcomeOf(AutomationSaved.Refused("same", row("a", event(), revision = 2L)), draft),
		)
		assertEquals(AutomationOutcome.Said(AutomationSaid.Confirm(listOf("Send to IFTTT"))), asks)
		assertEquals(AutomationOutcome.Said(AutomationSaid.Hole(0, "message", 3, 6, "no name x here")), hole)
	}

	@Test
	fun aDraftAsksBeforeLeavingOnlyOnceItDiffersFromWhatOpened() {
		val opened = automationDraftOf(row("a", event(reason("mention"))))!!

		assertEquals(false, opened.changedFrom(opened))
		assertEquals(true, opened.withAction(0, quietly).changedFrom(opened))
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

		assertEquals("Tell the assistant now", doesText(event()))
		assertEquals("switch_plug · Tell the assistant quietly", doesText(event().copy(actions = listOf(future, AutomationAction.TellAssistant("quietly")))))
		assertEquals("Switch Desk lamp on · Send door to IFTTT", doesText(lamp, FULL))
		assertEquals("Switch a plug on · Send door to IFTTT", doesText(lamp))
		assertEquals(
			listOf("Never ran", "Ran 9 ago", "Never ran", "Next at 20"),
			rows.map { ranText(it, { at -> "$at ago" }, { at -> "at $at" }) },
		)
		assertEquals(3, usesOf("github", rows))
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
		val serving = AssistantWord.Answered(ConsoleAssistantStateResult(workdir = "~/notes", sources = emptyList()))

		assertEquals(ListEmpty.NoRoster, automationsEmpty(GatewayRegistry(), "sakura"))
		assertEquals(ListEmpty.Reading, automationsEmpty(registry("sakura" to GatewayList.Unread), "sakura"))
		assertEquals(ListEmpty.Unreachable, automationsEmpty(registry("sakura" to GatewayList.Unreachable), "sakura"))
		assertEquals(ListEmpty.NotServed(listOf("sakura")), automationsEmpty(registry("sakura" to GatewayList.NotServed), "sakura"))
		// Sources answered wins over refusal.
		val refusedOnce = registry("sakura" to GatewayList.NotServed).withEntry("sakura") { it.copy(assistant = serving) }
		assertEquals(ListEmpty.Unreachable, automationsEmpty(refusedOnce, "sakura"))
		assertEquals(ListEmpty.None, automationsEmpty(registry("sakura" to listed, "older" to GatewayList.NotServed), "sakura"))
		assertEquals(ListEmpty.None, automationsEmpty(registry("sakura" to listed), null))
		val cached = registry("sakura" to GatewayList.Unread).copy(provenance = RegistryProvenance.Cached)
		assertEquals(ListEmpty.Reading, automationsEmpty(cached, "sakura"))
	}
}

class AutomationPartsTest {
	@Test
	fun aCrossingIsTypedInTheOwnersUnitAndSavedInTheStoredOne() {
		val typed = TriggerDraft.Crossing(SENSOR, "temperature", "below", "35.6", "0.9", "10")
		val humid = TriggerDraft.Crossing(SENSOR, "humidity", "above", "70", "2", "0")

		assertEquals(crossing, triggerOf(typed, FULL, "F"))
		assertEquals(typed, triggerDraftOf(crossing, FULL, "F"))
		assertEquals(typed.copy(threshold = "2.0", deadZone = "0.5"), triggerDraftOf(crossing, FULL, null))
		assertEquals(AutomationTrigger.Crossing(SENSOR, "humidity", "above", 70.0, 2.0, 0L), triggerOf(humid, FULL, "F"))
		assertEquals(listOf("°F", "°C", "%"), listOf(
			numberSuffix(FULL.number(SENSOR, "temperature"), "F"),
			numberSuffix(FULL.number(SENSOR, "temperature"), null),
			numberSuffix(FULL.number(SENSOR, "humidity"), "F"),
		).map(String::trim))
	}

	@Test
	fun aTriggerThatCannotBeSavedSaysWhyOnceItsFieldIsTyped() {
		val blank = TriggerDraft.Crossing(SENSOR, "temperature", "below", "", "0.5", "10")
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
		assertEquals(listOf(TriggerChoice.EVENT), offered(AutomationOffer(), true))
		assertEquals(listOf("tell_assistant", "device_set", "ifttt_trigger"), kinds(FULL))
		assertEquals(listOf("device_set"), kinds(away))
		assertEquals(listOf("tell_assistant", "ifttt_trigger"), kinds(FULL.copy(switches = emptyList())))
		assertEquals(emptyList<ActionOffer>(), addableActions(FULL, List(8) { ActionDraft.Tell("now", "") }))
		assertEquals(offerOf(null), AutomationOffer())
	}

	@Test
	fun aNewAutomationStartsOnlyWhereATriggerAndAnActionAreBothOnOffer() {
		fun entry(id: String, serves: Boolean, placed: Boolean) = GatewayEntry(
			id,
			connected = true,
			incarnation = 1L,
			lastRegisteredAt = 1L,
			automationServes = SANDBOX_SERVES.takeIf { serves },
			assistant = AssistantWord.Answered(ConsoleAssistantStateResult(workdir = "~/notes", sources = listOf(source("github")))).takeIf { placed },
		)
		val registry = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(entry("sakura", serves = true, placed = true), entry("mikan", serves = true, placed = false), entry("older", serves = false, placed = false)),
		)
		val all = listOf("sakura", "mikan", "older")
		val there = newAutomationDraft(emptyList(), offerOf(SANDBOX_SERVES, away = true), ZONE)!!

		assertEquals(listOf("sakura", "mikan"), newAutomationGateways(registry, all, home = "sakura"))
		assertEquals(listOf("mikan"), newAutomationGateways(registry, listOf("mikan", "older"), home = "sakura"))
		assertEquals(listOf("sakura", "mikan"), newAutomationGateways(registry, all, home = null))
		assertEquals("crossing" to listOf("device_set"), there.trigger.kind to there.actions.map { it.kind })
		assertNull(newAutomationDraft(emptyList(), AutomationOffer(away = true), ZONE))
	}

	@Test
	fun aNewAutomationsEditorWaitsUntilItsGatewayAndAtTheHomeTheAssistantHaveAnswered() {
		fun registry(list: GatewayList<AutomationRow>, word: AssistantWord?) = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = listOf(GatewayEntry("sakura", connected = true, incarnation = 1L, lastRegisteredAt = 1L, automations = list, assistant = word)),
		)
		val listed = GatewayList.Listed(emptyList<AutomationRow>())
		val standing = { list: GatewayList<AutomationRow>, word: AssistantWord?, home: String? ->
			automationStanding(registry(list, word), "sakura", home, held = null)
		}

		assertEquals(EditStanding.READING, standing(GatewayList.Unread, AssistantWord.Refused, "sakura"))
		assertEquals(EditStanding.UNREACHABLE, standing(GatewayList.Unreachable, AssistantWord.Refused, "sakura"))
		assertEquals(EditStanding.NOT_SERVED, standing(GatewayList.NotServed, AssistantWord.Refused, "sakura"))
		assertEquals(EditStanding.READING, standing(listed, null, "sakura"))
		assertEquals(EditStanding.READY, standing(listed, AssistantWord.Refused, "sakura"))
		assertEquals(EditStanding.READY, standing(listed, null, "mikan"))
		assertEquals(EditStanding.GONE, automationStanding(registry(listed, null), "sakura", "sakura", held = Lookup.Gone))
	}

	@Test
	fun anActionBuildsItsWireFormAndSaysWhyItCannot() {
		val door = ActionDraft.Ifttt("door", "open", "", "")
		val told = ActionDraft.Tell("quietly", "It is {value}")
		val issues = { action: ActionDraft -> listOf(actionIssue(action, FULL) != null, actionHint(action, FULL) != null) }

		assertEquals(AutomationAction.TellAssistant("now"), actionOf(ActionDraft.Tell("now", " ")))
		assertEquals(AutomationAction.TellAssistant("quietly", "It is {value}"), actionOf(told))
		assertEquals(AutomationAction.IftttTrigger("door", value1 = "open"), actionOf(door))
		assertEquals(listOf(told, door, ActionDraft.Kept(future)), listOf(actionOf(told), actionOf(door), future).map(::actionDraftOf))
		assertEquals(future, actionOf(ActionDraft.Kept(future)))
		assertEquals(listOf(true, false), issues(door.copy(event = "")))
		assertEquals(listOf(true, true), issues(door.copy(event = "front door")))
		assertEquals(listOf(true, true), issues(ActionDraft.DeviceSet("gone", "on")))
		assertEquals(listOf(false, false), issues(ActionDraft.DeviceSet(PLUG, "toggle")))
		assertEquals(listOf(true, true), issues(told.copy(message = "x".repeat(1_001))))
		assertEquals("Toggle Desk lamp", actionLine(AutomationAction.DeviceSet(PLUG, "toggle"), FULL))
		assertEquals(door.copy(value2 = "now"), withText(door, "value2", "now"))
		assertEquals(told.copy(message = "Hi"), withText(told, "message", "Hi"))
		assertEquals("Each time it runs it will send to IFTTT, without asking you.", confirmBody(listOf("Send to IFTTT")))
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
		assertEquals("missing }", holeLine(text, "missing }", 40, 50))
		assertEquals(listOf("{value}", "It is {value}", "It is {value}"), listOf("", "It is", "It is ").map { withHole(it, "value") })
		val refused = AutomationSaid.Hole(1, "value2", 0, 4, "no")
		assertEquals(listOf(refused, null, null), listOf(1 to "value2", 0 to "value2", 1 to "value1").map { (at, param) -> refusedHole(refused, at, param) })
	}

	@Test
	fun aPreviewAsksOnlyAboutATriggerThatCouldBeSavedHere() {
		val sources = listOf(source("github"))
		val timed = eventDraft().copy(trigger = TriggerDraft.Time("18:00", setOf(1), ZONE))

		assertEquals(event(reason("mention")).trigger, askedTrigger(eventDraft(reason("mention")), fields, sources, FULL, null))
		assertNull(askedTrigger(eventDraft(reason("")), fields, sources, FULL, null))
		assertNull(askedTrigger(eventDraft(reason("retired")), fields, sources, FULL, null))
		assertNull(askedTrigger(eventDraft(), fields, emptyList(), FULL, null))
		assertNotNull(askedTrigger(timed, fields, emptyList(), FULL, null))
		assertNull(askedTrigger(timed, fields, emptyList(), AutomationOffer(), null))
	}
}
