package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.RuleDraft
import com.atelier_nyaarium.switchboard.assistant.RuleSlot
import com.atelier_nyaarium.switchboard.assistant.WatcherRules
import com.atelier_nyaarium.switchboard.assistant.deleted
import com.atelier_nyaarium.switchboard.assistant.pingAfter
import com.atelier_nyaarium.switchboard.assistant.AfterRefusal
import com.atelier_nyaarium.switchboard.assistant.afterRefusal
import com.atelier_nyaarium.switchboard.assistant.raised
import com.atelier_nyaarium.switchboard.assistant.rulesOf
import com.atelier_nyaarium.switchboard.assistant.saved
import com.atelier_nyaarium.switchboard.proto.AssistantRule
import com.atelier_nyaarium.switchboard.proto.AssistantRuleCondition
import com.atelier_nyaarium.switchboard.proto.AssistantRuleOtherwise
import com.atelier_nyaarium.switchboard.proto.AssistantWatcher
import com.atelier_nyaarium.switchboard.proto.AssistantWatcherRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun rule(value: String, action: String = "inbox") =
	AssistantRule(listOf(AssistantRuleCondition("reason", "is", value)), action = action)

private val held = AssistantWatcherRules(
	rules = listOf(rule("review_requested", "wake"), rule("subscribed", "drop")),
	otherwise = AssistantRuleOtherwise(action = "inbox"),
	revision = 4L,
)

private val watcherRules = WatcherRules(fields = listOf("reason", "repository"), pingDefault = false, held = held)

class RuleDraftTest {
	@Test
	fun aNewRuleIsAppendedAtTheRevisionItWasOpenedOver() {
		val draft = RuleDraft.of(RuleSlot.New, watcherRules).changed(0) { it.copy(value = "  mention ") }

		val put = saved(held, RuleSlot.New, draft)!!

		assertEquals(listOf("review_requested", "subscribed", "mention"), put.rules.map { it.conditions.single().value })
		assertEquals(4L, put.base)
	}

	@Test
	fun aRuleWithAnEmptyValueCannotBeSaved() {
		val draft = RuleDraft.of(RuleSlot.New, watcherRules).withCondition(watcherRules.fields)

		assertNull(saved(held, RuleSlot.New, draft.changed(0) { it.copy(value = "x") }))
	}

	@Test
	fun editingTheCatchAllKeepsTheRules() {
		val draft = RuleDraft.of(RuleSlot.Otherwise, watcherRules).copy(action = "drop")

		val put = saved(held, RuleSlot.Otherwise, draft)!!

		assertEquals(held.rules, put.rules)
		assertEquals("drop", put.otherwise.action)
	}

	@Test
	fun deleteAndRaiseSendTheWholeList() {
		assertEquals(listOf("subscribed"), deleted(held, 0).rules.map { it.conditions.single().value })
		assertEquals(listOf("subscribed", "review_requested"), raised(held, 1)!!.rules.map { it.conditions.single().value })
		assertNull(raised(held, 0))
	}

	@Test
	fun theLastConditionStays() {
		val draft = RuleDraft.of(RuleSlot.At(0), watcherRules).withoutCondition(0)

		assertEquals(held.rules, saved(held, RuleSlot.At(0), draft)!!.rules)
	}

	@Test
	fun aPingAtTheDefaultFollowsTheDefault() {
		assertNull(pingAfter(on = false, pingDefault = false))
		assertEquals(true, pingAfter(on = true, pingDefault = false))
		assertNull(pingAfter(on = true, pingDefault = true))
		assertEquals(false, pingAfter(on = false, pingDefault = true))
	}

	@Test
	fun aDropNeverPingsNorKeepsAnOverride() {
		val draft = RuleDraft.of(RuleSlot.At(0), watcherRules).copy(ping = true)

		assertEquals(false, draft.copy(action = "drop").pings(pingDefault = true))
		assertNull(draft.copy(action = "drop").toRule()!!.ping)
		assertEquals(true, draft.toRule()!!.ping)
	}

	@Test
	fun aRefusedSaveGoesAgainOnlyOverARowThatStillStands() {
		val edit = RuleDraft.of(RuleSlot.At(0), watcherRules).copy(action = "drop")
		val elsewhere = watcherRules.copy(held = held.copy(rules = held.rules + rule("mention"), revision = 5L))
		val changed = watcherRules.copy(held = held.copy(rules = listOf(rule("other")) + held.rules.drop(1), revision = 5L))
		val otherCatchAll = watcherRules.copy(held = held.copy(otherwise = AssistantRuleOtherwise(action = "wake"), revision = 5L))
		val catchAll = RuleDraft.of(RuleSlot.Otherwise, watcherRules).copy(action = "drop")

		assertEquals(AfterRefusal.Over(elsewhere), afterRefusal(watcherRules, elsewhere, RuleSlot.At(0), edit))
		assertEquals(AfterRefusal.Stuck, afterRefusal(watcherRules, changed, RuleSlot.At(0), edit))
		assertEquals(AfterRefusal.Stuck, afterRefusal(watcherRules, otherCatchAll, RuleSlot.Otherwise, catchAll))
		assertEquals(AfterRefusal.Stuck, afterRefusal(watcherRules, watcherRules, RuleSlot.New, edit))
	}

	@Test
	fun aRefusedSaveThatAlreadyStandsReadsAsLanded() {
		val added = RuleDraft.of(RuleSlot.New, watcherRules).changed(0) { it.copy(value = "mention") }
		val withIt = watcherRules.copy(held = held.copy(rules = held.rules + added.toRule()!! + rule("later"), revision = 6L))

		assertEquals(AfterRefusal.Landed, afterRefusal(watcherRules, withIt, RuleSlot.New, added))
	}

	@Test
	fun aGatewayOlderThanRulesOffersNone() {
		val bare = AssistantWatcher(id = "github", label = "GitHub", grants = emptyList(), unread = 0L, evicted = 0L)

		assertNull(rulesOf(bare))
	}
}
