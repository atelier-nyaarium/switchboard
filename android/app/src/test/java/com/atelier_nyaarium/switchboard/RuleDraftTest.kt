package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleDraft
import com.atelier_nyaarium.switchboard.assistant.RuleEdit
import com.atelier_nyaarium.switchboard.assistant.RuleEditing
import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.assistant.editorLanded
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun rule(id: String, value: String, action: String = "inbox", revision: Long = 1L) =
	AssistantRule(id, listOf(AssistantRuleCondition("reason", "is", value)), action = action, revision = revision)

private val held = AssistantWatcherRules(
	rules = listOf(rule("reviews", "review_requested", "wake"), rule("subscribed", "subscribed", "inbox")),
	otherwise = AssistantRuleOtherwise(action = "inbox", revision = 0L),
	revision = 4L,
)

private val watcherRules = WatcherRules(fields = listOf("reason", "repository"), held = held)

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

		assertEquals(RuleEditing(edit = true, save = true, delete = true), ruleEditing(held, valid, busy = false, gone = false))
		assertEquals(RuleEditing(edit = true, save = false, delete = true), ruleEditing(held, invalid, busy = false, gone = false))
		assertEquals(RuleEditing(edit = false, save = false, delete = false), ruleEditing(held, valid, busy = true, gone = false))
		assertEquals(RuleEditing(edit = false, save = false, delete = false), ruleEditing(held, valid, busy = false, gone = true))
		assertEquals(RuleEditing(edit = true, save = true, delete = false), ruleEditing(RuleSlot.New, valid, busy = false, gone = false))
		assertEquals(RuleEditing(edit = true, save = true, delete = false), ruleEditing(RuleSlot.Otherwise, otherwise, busy = false, gone = false))
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
