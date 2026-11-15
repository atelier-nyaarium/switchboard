package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorSessionsTest {
	private val key = EditKey("sakura", "apt")

	private val told = mutableListOf<String>()

	private fun sessions() = EditorSessions<EditKey, String, String>(unattended = { left -> told += left.said.orEmpty() })

	private val EditorSessions<EditKey, String, String>.now get() = state.value

	private fun EditorSessions<EditKey, String, String>.typed(draft: String = "changed"): Long {
		show(key)
		val opening = open(key, "opened")!!
		edit(key, opening) { draft }
		return opening
	}

	@Test
	fun onlyTheShownKeyIsOpenedAndAHeldEditKeepsItsOpening() {
		val edits = sessions()
		assertNull(edits.open(key, "never shown"))

		edits.show(key)
		val opening = edits.open(key, "opened")

		assertEquals(EditSession<String, String>("opened", "opened", opening!!), edits.now.held[key])
		assertEquals(opening, edits.open(key, "a later page of the same record"))
		assertEquals("opened", edits.now.held.getValue(key).draft)
	}

	@Test
	fun backLeavesAnUnchangedDraftAtOnceAndAsksForAChangedOne() {
		val edits = sessions()
		edits.show(key)
		edits.open(key, "opened")

		assertTrue(edits.askLeave())
		assertEquals(EditState<EditKey, String, String>(), edits.now)
		assertTrue(edits.askLeave())

		val opening = edits.typed()
		assertFalse(edits.askLeave())
		assertTrue(edits.now.asks(key))
		edits.stay()
		assertFalse(edits.now.asks(key))
		assertEquals(key, edits.now.shown)

		edits.askLeave()
		edits.discard(key, opening)
		assertEquals(EditState<EditKey, String, String>(), edits.now)
	}

	@Test
	fun backDuringASaveHidesTheEditorAndTheSaveThatLandsEndsTheEdit() = runBlocking {
		val edits = sessions()
		val opening = edits.typed()
		val gate = CompletableDeferred<Unit>()
		val sent = async {
			edits.send(key, opening) {
				gate.await()
				EditOutcome.Done
			}
		}
		yield()

		assertTrue(edits.askLeave())
		assertNull(edits.now.shown)
		assertTrue(edits.now.held.getValue(key).busy)
		assertNull(edits.send(key, opening) { EditOutcome.Done })
		gate.complete(Unit)
		sent.await()

		assertEquals(EditState<EditKey, String, String>(), edits.now)
		assertEquals(emptyList<String>(), told)
	}

	@Test
	fun aSaveThatLandsClosesItsShownEditorInOneStep() = runBlocking {
		val edits = sessions()
		val opening = edits.typed()
		edits.askLeave()

		assertEquals(EditOutcome.Done, edits.send(key, opening) { EditOutcome.Done })

		assertEquals(EditState<EditKey, String, String>(), edits.now)
		assertNull(edits.open(key, "blank"))
	}

	@Test
	fun aRefusalIsShownOnItsEditorAndToldOnlyWhenNoEditorShowsIt() = runBlocking {
		val edits = sessions()
		val opening = edits.typed()

		edits.send(key, opening) { EditOutcome.Stays("refused while shown") }
		assertEquals("refused while shown", edits.now.held.getValue(key).said)
		assertEquals(emptyList<String>(), told)

		val gate = CompletableDeferred<Unit>()
		val sent = async {
			edits.send(key, opening) {
				gate.await()
				EditOutcome.Stays("this Gateway could not be reached")
			}
		}
		yield()
		assertNull(edits.now.held.getValue(key).said)
		edits.hide()
		gate.complete(Unit)
		sent.await()

		assertEquals(listOf("this Gateway could not be reached"), told)
		edits.show(key)
		assertEquals(opening, edits.open(key, "a later page"))
		assertEquals("this Gateway could not be reached", edits.now.held.getValue(key).said)
	}

	@Test
	fun anUntouchedEditRefusedWithNoEditorIsToldAndDropped() = runBlocking {
		val edits = sessions()
		edits.show(key)
		val opening = edits.open(key, "opened")!!
		val gate = CompletableDeferred<Unit>()
		val deleting = async {
			edits.send(key, opening) {
				gate.await()
				EditOutcome.Stays("this Gateway still runs it")
			}
		}
		yield()
		assertTrue(edits.askLeave())
		gate.complete(Unit)
		deleting.await()

		assertEquals(listOf("this Gateway still runs it"), told)
		assertEquals(EditState<EditKey, String, String>(), edits.now)
	}

	@Test
	fun aRefusalOnAnUntouchedDraftStaysWhileItsEditorIsShown() = runBlocking {
		val edits = sessions()
		edits.show(key)
		val opening = edits.open(key, "opened")!!

		edits.send(key, opening) { EditOutcome.Stays("this Gateway still holds it") }

		// Disposal keeps the edit.
		assertEquals(EditSession("opened", "opened", opening, said = "this Gateway still holds it"), edits.now.held[key])
		assertEquals(key, edits.now.shown)
		assertEquals(emptyList<String>(), told)
	}

	@Test
	fun anArrivalHidesAnUntouchedEditForGoodAndKeepsATouchedOne() {
		val edits = sessions()
		edits.show(key)
		edits.open(key, "opened")
		edits.hide()
		assertEquals(EditState<EditKey, String, String>(), edits.now)

		val opening = edits.typed()
		edits.askLeave()
		edits.hide()

		assertNull(edits.now.shown)
		assertFalse(edits.now.asks(key))
		assertEquals("changed", edits.now.held.getValue(key).draft)
		edits.show(key)
		assertEquals(opening, edits.open(key, "reopened"))
	}

	@Test
	fun showingAnotherRecordHidesTheOneShownBefore() {
		val edits = sessions()
		val other = EditKey("mikan", "apt")
		edits.typed()

		edits.show(other)
		edits.open(other, "there")

		assertEquals(other, edits.now.shown)
		assertEquals(setOf(key, other), edits.now.held.keys)
		assertTrue(edits.askLeave())
		assertEquals(setOf(key), edits.now.held.keys)
	}

	@Test
	fun aLateAnswerNeverLandsOnADraftOpenedAfterItWasSent() = runBlocking {
		val edits = sessions()
		val first = edits.typed("first")
		val late = CompletableDeferred<EditOutcome<String, String>>()
		val sent = async { edits.send(key, first) { late.await() } }
		yield()

		edits.edit(key, first) { "typed while sending" }
		assertEquals("first", edits.now.held.getValue(key).draft)
		edits.discard(key, first)
		edits.show(key)
		val second = edits.open(key, "reopened")!!
		edits.edit(key, first) { "from the page that left" }
		edits.discard(key, first)
		late.complete(EditOutcome.Done)
		sent.await()

		assertEquals(EditSession<String, String>("reopened", "reopened", second), edits.now.held[key])
		assertEquals(key, edits.now.shown)
	}

	@Test
	fun aSendThatStaysCanReplaceTheDraftAndASendThatThrowsFreesIt() = runBlocking {
		val edits = sessions()
		val opening = edits.typed()

		edits.send(key, opening) { EditOutcome.Stays("offered", draft = "theirs") }
		assertEquals(EditSession("theirs", "opened", opening, said = "offered"), edits.now.held[key])
		assertFalse(edits.askLeave())

		edits.send(key, opening) { EditOutcome.Stays("held", draft = "held row", reopened = true) }
		val thrown = try {
			edits.send(key, opening) { error("down") }
			null
		} catch (down: IllegalStateException) {
			down.message
		}

		assertEquals("down", thrown)
		assertEquals(EditSession("held row", "held row", opening, said = "held"), edits.now.held[key])
		assertTrue(edits.askLeave())
	}

	@Test
	fun aReprovisionEndsEveryEditAndALateAnswerFindsNothing() = runBlocking {
		val edits = sessions()
		val opening = edits.typed()
		val gate = CompletableDeferred<Unit>()
		val sent = async {
			edits.send(key, opening) {
				gate.await()
				EditOutcome.Stays("refused for the previous owner")
			}
		}
		yield()

		edits.clear()
		gate.complete(Unit)
		sent.await()

		assertEquals(EditState<EditKey, String, String>(), edits.now)
		assertEquals(emptyList<String>(), told)
	}

	@Test
	fun oneEditorIsShownAtATimeAcrossKindsAndBackAsksTheShownOne() {
		val runbooks = sessions()
		val routines = sessions()
		val policies = sessions()
		val automations = EditorSessions<AutomationDraftKey, String, String>()
		val editors = Editors(runbooks, routines, policies, automations)
		val automation = AutomationDraftKey("sakura", AutomationSlot.New())
		fun shown() = shownEditorOf(runbooks.now.shown, routines.now.shown, policies.now.shown, automations.state.value.shown)

		editors.show(ShownEditor.Runbook(key))
		runbooks.edit(key, runbooks.open(key, "opened")!!) { "changed" }
		editors.show(ShownEditor.Automation(automation))

		assertEquals(ShownEditor.Automation(automation), shown())
		assertEquals("changed", runbooks.now.held.getValue(key).draft)
		assertTrue(editors.askLeave())
		assertNull(shown())

		editors.show(ShownEditor.Runbook(key))
		assertFalse(editors.askLeave())
		assertEquals(ShownEditor.Runbook(key), shown())
		editors.hideAll()
		assertNull(shown())
	}

	@Test
	fun aRowTappedTwiceKeepsItsFreshEdit() {
		val runbooks = sessions()
		val editors = Editors(runbooks, sessions(), sessions(), EditorSessions<AutomationDraftKey, String, String>())
		editors.show(ShownEditor.Runbook(key))
		val opening = runbooks.open(key, "opened")

		editors.show(ShownEditor.Runbook(key))

		assertEquals(key, runbooks.now.shown)
		assertEquals(opening, runbooks.now.held[key]?.opening)
	}

	@Test
	fun anArrivalOverARefusalNobodySawTellsIt() = runBlocking {
		val edits = sessions()
		val opening = edits.typed()
		edits.send(key, opening) { EditOutcome.Stays("refused in the background") }
		assertEquals(emptyList<String>(), told)

		edits.hide()

		assertEquals(listOf("refused in the background"), told)
		assertEquals("changed", edits.now.held.getValue(key).draft)
		// Told once per refusal.
		edits.show(key)
		edits.hide()
		assertEquals(1, told.size)
		edits.show(key)
		edits.send(key, opening) { EditOutcome.Stays("refused again") }
		edits.hide()
		assertEquals(listOf("refused in the background", "refused again"), told)
	}

	@Test
	fun aPolicyEditorNeedsTheVaultAndAnEventAutomationsEditorItsHome() {
		val policy = ShownEditor.Policy(key)
		val automation = ShownEditor.Automation(AutomationDraftKey("sakura", AutomationSlot.New()))
		val left: (String) -> Boolean = { it == "sakura" }
		val stands = { editor: ShownEditor?, vaultOn: Boolean, moves: Boolean, gone: (String) -> Boolean ->
			editorStands(editor, vaultOn, { moves }, gone)
		}

		assertTrue(stands(policy, true, true, left))
		assertFalse(stands(policy, false, true, left))
		assertFalse(stands(automation, true, true, left))
		assertTrue(stands(automation, true, false, left))
		assertTrue(stands(automation, false, true) { false })
		assertTrue(stands(ShownEditor.Runbook(key), false, true, left))
		assertTrue(stands(null, false, true, left))
	}

	@Test
	fun whatIsTypedReachesItsSessionAtOnceAndAHeldRecordWaitsForItsList() {
		val edits = sessions()
		edits.show(key)
		val opening = edits.open(key, "opened")!!
		var draft by MirroredDraft("opened") { next -> edits.edit(key, opening) { next } }

		draft = "typed"

		assertEquals("typed", draft)
		assertEquals("typed", edits.now.held.getValue(key).draft)
		assertFalse(edits.askLeave())
		assertEquals(EditStanding.READY, editStanding(held = null))
		assertEquals(EditStanding.READY, editStanding(Lookup.Found("record")))
		assertEquals(EditStanding.GONE, editStanding(Lookup.Gone))
		// Only pending reads spin.
		val waiting = listOf(Lookup.Reading, Lookup.Unreachable, Lookup.NotServed).map(::editStanding)
		assertEquals(listOf(EditStanding.READING, EditStanding.UNREACHABLE, EditStanding.NOT_SERVED), waiting)
		assertEquals(listOf(true, false, false), waiting.map { waitingLine(it) == null })
		assertEquals(false, waitingLine(EditStanding.GONE) == null)
		// Only a new or found record opens.
		val opens = { held: Lookup<String>? -> openingDraft(held, { "fresh" }) { "on $it" } }
		assertEquals(listOf("fresh", "on record"), listOf(null, Lookup.Found("record")).map(opens))
		assertEquals(listOf(null, null, null, null), listOf(Lookup.Gone, Lookup.Reading, Lookup.Unreachable, Lookup.NotServed).map(opens))
		assertEquals("Apt: revision 5 is stored", leftLine("Apt", "Policy", "revision 5 is stored"))
		assertEquals("Policy: unreachable", leftLine(" ", "Policy", "unreachable"))
	}
}
