package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleDraft
import com.atelier_nyaarium.switchboard.assistant.RuleEdit
import com.atelier_nyaarium.switchboard.assistant.RuleEditing
import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.assistant.editorLanded
import com.atelier_nyaarium.switchboard.assistant.fittingRule
import com.atelier_nyaarium.switchboard.assistant.goneFrom
import com.atelier_nyaarium.switchboard.assistant.ruleEditing
import com.atelier_nyaarium.switchboard.assistant.SaveOutcome
import com.atelier_nyaarium.switchboard.assistant.WatcherRules
import com.atelier_nyaarium.switchboard.assistant.outcomeOf
import com.atelier_nyaarium.switchboard.assistant.raisedBefore
import com.atelier_nyaarium.switchboard.assistant.rulesOf
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import com.atelier_nyaarium.switchboard.assistant.testsOf
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.AssistantFieldSpec
import com.atelier_nyaarium.switchboard.proto.AssistantRuleInvalid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

private fun rule(id: String, value: String, action: String = "inbox", revision: Long = 1L) =
	AssistantRule(id, listOf(AssistantRuleCondition("reason", "is", value)), action = action, revision = revision)

private val held = AssistantWatcherRules(
	rules = listOf(rule("reviews", "review_requested", "wake"), rule("subscribed", "subscribed", "inbox")),
	otherwise = AssistantRuleOtherwise(action = "inbox", revision = 0L),
	revision = 4L,
)

private val watcherRules = WatcherRules(
	specs = listOf(AssistantFieldSpec.Text("reason", "Reason"), AssistantFieldSpec.Text("repository", "Repository")),
	held = held,
)

private val choiceRules = WatcherRules(
	specs = listOf(
		AssistantFieldSpec.Enumeration(
			"reason",
			"Reason",
			listOf(AssistantFieldOption("review_requested", "Review requested"), AssistantFieldOption("mention", "Mention")),
		),
		AssistantFieldSpec.Text("repository", "Repository"),
	),
	held = held,
)

class RuleDraftTest {
	@Test
	fun anEditorClosesOnlyWhenTheOpeningItShowedLanded() {
		assertEquals(false, editorLanded(shown = null, landed = 3L))
		assertEquals(false, editorLanded(shown = 4L, landed = 3L))
		assertEquals(false, editorLanded(shown = 4L, landed = null))
		assertEquals(true, editorLanded(shown = 3L, landed = 3L))
	}

	@Test
	fun theEditorAllowsEditingSavingAndDeletingOnlyWhenItCan() {
		val valid = RuleDraft.draftOf(rule("reviews", "review_requested"))
		val invalid = valid.changed(0) { it.copy(value = " ") }
		val held = RuleSlot.Held("reviews")
		val otherwise = RuleDraft.of(RuleSlot.Otherwise, watcherRules)!!

		val can = { slot: RuleSlot, draft: RuleDraft, busy: Boolean, gone: Boolean -> ruleEditing(slot, draft, busy, gone, watcherRules) }

		assertEquals(RuleEditing(edit = true, save = true, delete = true), can(held, valid, false, false))
		assertEquals(RuleEditing(edit = true, save = false, delete = true), can(held, invalid, false, false))
		assertEquals(RuleEditing(edit = false, save = false, delete = false), can(held, valid, true, false))
		assertEquals(RuleEditing(edit = false, save = false, delete = false), can(held, valid, false, true))
		assertEquals(RuleEditing(edit = true, save = true, delete = false), can(RuleSlot.New, valid, false, false))
		assertEquals(RuleEditing(edit = true, save = true, delete = false), can(RuleSlot.Otherwise, otherwise, false, false))
	}

	@Test
	fun rowsReadInLabelsAndEachKindOffersItsOwnTestsAndMenu() {
		assertEquals("Reason is Review requested", choiceRules.summary(rule("reviews", "review_requested")))
		assertEquals("Reason is not someone_else", choiceRules.summary(rule("x", "someone_else").let { r ->
			r.copy(conditions = r.conditions.map { it.copy(test = "is_not") })
		}))
		assertEquals(listOf("is", "is_not"), testsOf(choiceRules.specOf("reason")))
		assertEquals(listOf("is", "is_not", "contains"), testsOf(choiceRules.specOf("repository")))
		assertEquals(listOf("review_requested", "mention"), choiceRules.choicesFor("reason", ""))
		assertNull(choiceRules.choicesFor("repository", "atelier"))
	}

	@Test
	fun aKindChangeClearsTheValueAndKeepsOnlyATestTheNewKindTakes() {
		val onText = RuleDraft("r", listOf(AssistantRuleCondition("repository", "contains", "atelier")), "inbox", 0L)
		val onChoice = RuleDraft("r", listOf(AssistantRuleCondition("reason", "is_not", "mention")), "inbox", 0L)

		assertEquals(AssistantRuleCondition("reason", "is", ""), onText.withField(0, "reason", choiceRules).conditions.single())
		assertEquals(AssistantRuleCondition("repository", "is_not", ""), onChoice.withField(0, "repository", choiceRules).conditions.single())
		assertEquals(AssistantRuleCondition("reason", "is", ""), RuleDraft.of(RuleSlot.New, choiceRules)!!.conditions.single())
		assertEquals(
			AssistantRuleCondition("reason", "contains", "atelier"),
			onText.withField(0, "reason", watcherRules).conditions.single(),
		)
		val stale = RuleDraft("r", listOf(AssistantRuleCondition("reason", "is", "retired")), "inbox", 0L)
		assertEquals(stale, stale.withField(0, "reason", choiceRules))
	}

	@Test
	fun aValueTheMenuNoLongerListsShowsInvalidAndBlocksSaveUntilRepicked() {
		val stale = RuleDraft.draftOf(rule("subscribed", "subscribed"))
		val repicked = stale.changed(0) { it.copy(value = "mention") }
		val slot = RuleSlot.Held("subscribed")

		assertEquals(listOf("subscribed", "review_requested", "mention"), choiceRules.choicesFor("reason", "subscribed"))
		assertEquals(false, choiceRules.offers("reason", "subscribed"))
		assertNotNull(choiceRules.issueOf(stale.conditions.single()))
		assertEquals(RuleEditing(edit = true, save = false, delete = true), ruleEditing(slot, stale, false, false, choiceRules))
		assertEquals(RuleEditing(edit = true, save = true, delete = true), ruleEditing(slot, repicked, false, false, choiceRules))
	}

	@Test
	fun aTextValuePastTheLimitSaysSoAndNeitherSavesNorPreviews() {
		val long = RuleDraft("r", listOf(AssistantRuleCondition("repository", "contains", "x".repeat(201))), "inbox", 0L)

		assertNotNull(choiceRules.issueOf(long.conditions.single()))
		assertNull(fittingRule(long, choiceRules))
		assertEquals(false, ruleEditing(RuleSlot.New, long, false, false, choiceRules).save)
	}

	@Test
	fun anOlderGatewayIsTypedFromItsFieldsAndAnInvalidRowCarriesTheGatewaysReason() {
		val older = AssistantWatcher(id = "github", label = "GitHub", grants = emptyList(), unread = 0L, fields = listOf("reason"), rules = held)
		val newer = older.copy(fieldSpecs = choiceRules.specs, invalid = listOf(AssistantRuleInvalid("subscribed", "no longer a choice")))

		assertEquals(listOf<AssistantFieldSpec>(AssistantFieldSpec.Text("reason", "Reason")), rulesOf(older)!!.specs)
		assertEquals(mapOf("subscribed" to "no longer a choice"), rulesOf(newer)!!.invalid)
	}

	@Test
	fun aNewRuleIsSavedUnderItsOwnIdAtRevisionZero() {
		val first = RuleDraft.of(RuleSlot.New, watcherRules)!!.changed(0) { it.copy(value = "  mention ") }
		val second = RuleDraft.of(RuleSlot.New, watcherRules)!!

		val saved = first.toRule()!!

		assertEquals(0L, saved.revision)
		assertEquals("mention", saved.conditions.single().value)
		assertNotEquals(first.id, second.id)
		assertNull(second.toRule())
	}

	@Test
	fun aStaleSaveOffersToGoOverWhatIsHeldOnlyWhileTheRuleStillStands() {
		val edit = RuleDraft.of(RuleSlot.Held("reviews"), watcherRules)!!.copy(action = "inbox")
		val movedOn = held.copy(rules = listOf(rule("reviews", "review_requested", "wake", revision = 3L)), revision = 6L)
		val deleted = held.copy(rules = emptyList(), revision = 6L)

		val offer = outcomeOf(RuleSaved.Refused("revision 3 is stored", movedOn), edit, RuleSlot.Held("reviews"))

		assertEquals(edit.copy(revision = 3L), (offer as SaveOutcome.Offer).draft)
		assertEquals(
			SaveOutcome.Said("this rule was deleted"),
			outcomeOf(RuleSaved.Refused("this rule was deleted", deleted), edit, RuleSlot.Held("reviews")),
		)
		assertEquals(SaveOutcome.Done, outcomeOf(RuleSaved.Stored(held), edit, RuleSlot.Held("reviews")))
	}

	@Test
	fun aRefusedDeleteShowsTheHeldRuleRatherThanArmingTheOldCopy() {
		val opened = RuleDraft.of(RuleSlot.Held("reviews"), watcherRules)!!
		val theirs = rule("reviews", "mention", "inbox", revision = 2L)
		val movedOn = held.copy(rules = listOf(theirs), revision = 5L)

		val outcome = outcomeOf(RuleSaved.Refused("stale", movedOn), opened, RuleSlot.Held("reviews"), RuleEdit.DELETE)

		assertEquals(theirs, ((outcome as SaveOutcome.Offer).draft).toRule())
	}

	@Test
	fun theEditorKnowsWhenItsRuleWasDeletedElsewhere() {
		val without = watcherRules.copy(held = held.copy(rules = held.rules.drop(1), revision = 5L))

		assertEquals(true, goneFrom(without, RuleSlot.Held("reviews")))
		assertEquals(false, goneFrom(without, RuleSlot.New))
	}

	@Test
	fun theCatchAllGoesOverOnlyItsOwnRevision() {
		val draft = RuleDraft.of(RuleSlot.Otherwise, watcherRules)!!.copy(action = "wake")
		val newer = held.copy(otherwise = AssistantRuleOtherwise(action = "inbox", revision = 2L))

		val offer = outcomeOf(RuleSaved.Refused("stale", newer), draft, RuleSlot.Otherwise)

		assertEquals(draft.copy(revision = 2L), (offer as SaveOutcome.Offer).draft)
	}

	@Test
	fun aRaisedRuleGoesBeforeTheOneAboveIt() {
		assertEquals("reviews", raisedBefore(held, "subscribed"))
		assertNull(raisedBefore(held, "reviews"))
	}

	@Test
	fun theLastConditionStays() {
		val draft = RuleDraft.of(RuleSlot.Held("reviews"), watcherRules)!!

		assertEquals(held.rules[0], draft.withoutCondition(0).toRule())
	}

	@Test
	fun aGatewayOlderThanRulesOffersNone() {
		val bare = AssistantWatcher(id = "github", label = "GitHub", grants = emptyList(), unread = 0L)

		assertNull(rulesOf(bare))
	}
}
