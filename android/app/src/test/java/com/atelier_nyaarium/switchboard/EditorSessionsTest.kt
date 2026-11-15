package com.atelier_nyaarium.switchboard

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

	private fun EditorSessions<EditKey, String, String>.showing(shown: Long?) = editorShowing(shown, held.value[key])

	@Test
	fun aLateAnswerNeverLandsOnADraftOpenedAfterItWasSent() = runBlocking {
		val edits = sessions()
		val first = edits.open(key, "first")
		val late = CompletableDeferred<EditOutcome<String, String>>()
		val sent = async { edits.send(key, first) { late.await() } }
		yield()

		edits.edit(key, first) { "typed while sending" }
		assertEquals("first", edits.held.value.getValue(key).draft)
		edits.discard(key, first)
		val second = edits.open(key, "reopened")
		late.complete(EditOutcome.Done)
		sent.await()

		assertEquals("reopened", edits.held.value.getValue(key).draft)
		assertEquals(EditorShowing.DRAWN, edits.showing(second))
		assertEquals(EditorShowing.CLOSING, edits.showing(first))
	}

	@Test
	fun backLeavesAnUnchangedDraftAtOnceAndAsksForAChangedOne() {
		val edits = sessions()
		edits.open(key, "opened")

		assertTrue(edits.askLeave(key))
		assertNull(edits.held.value[key])
		assertTrue(edits.askLeave(key))

		val opening = edits.open(key, "opened")
		edits.edit(key, opening) { "changed" }
		assertFalse(edits.askLeave(key))
		assertTrue(leaveShown(edits.leaving.value, key, edits.held.value[key]))
		edits.stay()
		assertNull(edits.leaving.value)
		assertEquals("changed", edits.held.value.getValue(key).draft)
		edits.askLeave(key)
		edits.discard(key, opening)
		assertNull(edits.leaving.value)
		assertEquals(EditorShowing.CLOSING, edits.showing(opening))
	}

	@Test
	fun backDuringASaveLeavesAtOnceAndAnAnswerThatLandsClosesOnlyItsOwnPage() = runBlocking {
		val edits = sessions()
		val first = edits.open(key, "opened")
		edits.edit(key, first) { "changed" }
		assertFalse(edits.askLeave(key))
		val asked = edits.leaving.value
		val entered = CompletableDeferred<Unit>()
		val gate = CompletableDeferred<Unit>()

		val sent = async {
			edits.send(key, first) {
				entered.complete(Unit)
				gate.await()
				EditOutcome.Done
			}
		}
		entered.await()
		val left = edits.askLeave(key)
		edits.park(key, first)
		val kept = edits.showing(first)
		val again = edits.send(key, first) { EditOutcome.Done }
		gate.complete(Unit)
		sent.await()
		val second = edits.open(key, "opened")

		assertEquals(true to EditorShowing.DRAWN, left to kept)
		assertNull(again)
		assertEquals(EditorShowing.CLOSING, edits.showing(first))
		assertFalse(leaveShown(asked, key, edits.held.value[key]))
		assertEquals(EditorShowing.DRAWN, edits.showing(second))
		assertEquals(emptyList<String>(), told)
	}

	@Test
	fun aSaveThatFailsAfterItsPageLeftTellsTheOwnerAndOneStillWatchedDoesNot() = runBlocking {
		val edits = sessions()
		val opening = edits.open(key, "opened")
		edits.edit(key, opening) { "changed" }

		edits.send(key, opening) { EditOutcome.Stays("refused while watched") }
		assertEquals(emptyList<String>(), told)

		val gate = CompletableDeferred<Unit>()
		val sent = async {
			edits.send(key, opening) {
				gate.await()
				EditOutcome.Stays("this Gateway could not be reached")
			}
		}
		yield()
		edits.park(key, opening)
		gate.complete(Unit)
		sent.await()

		assertEquals(listOf("this Gateway could not be reached"), told)
		// Reopened page shows it.
		assertEquals(opening, edits.open(key, "a later page"))
		assertEquals("this Gateway could not be reached", edits.held.value.getValue(key).said)
		edits.send(key, opening) { EditOutcome.Stays("refused again") }
		assertEquals(1, told.size)
	}

	@Test
	fun anEditADiscardAParkAndASendFromAnotherOpeningTouchNothing() = runBlocking {
		val edits = sessions()
		val stale = edits.open(key, "first")
		edits.discard(key, stale)
		val opening = edits.open(key, "second")

		edits.edit(key, stale) { "from the page that left" }
		edits.discard(key, stale)
		edits.park(key, stale)
		val sent = edits.send(key, stale) { EditOutcome.Done }

		assertNull(sent)
		assertEquals(EditSession<String, String>("second", "second", opening), edits.held.value[key])
		assertEquals(opening, edits.open(key, "a third page of the same record"))
	}

	@Test
	fun aSendThatStaysSaysWhyAndADraftItAnswersReplacesTheHeldOne() = runBlocking {
		val edits = sessions()
		val opening = edits.open(key, "opened")
		edits.edit(key, opening) { "changed" }

		edits.send(key, opening) { EditOutcome.Stays("refused") }
		assertEquals(EditSession("changed", "opened", opening, said = "refused"), edits.held.value[key])
		// No stale refusal showing.
		val gate = CompletableDeferred<Unit>()
		val resent = async {
			edits.send(key, opening) {
				gate.await()
				EditOutcome.Stays("refused again")
			}
		}
		yield()
		assertEquals(EditSession<String, String>("changed", "opened", opening, busy = true), edits.held.value[key])
		gate.complete(Unit)
		resent.await()

		edits.send(key, opening) { EditOutcome.Stays("offered", draft = "theirs") }
		assertEquals(EditSession("theirs", "opened", opening, said = "offered"), edits.held.value[key])
		assertFalse(edits.askLeave(key))

		edits.send(key, opening) { EditOutcome.Stays("held", draft = "held row", reopened = true) }
		assertTrue(edits.askLeave(key))
	}

	@Test
	fun aSendThatThrowsFreesTheDraftAndRecordsAreHeldPerGateway() = runBlocking {
		val edits = sessions()
		val other = EditKey("mikan", "apt")
		val opening = edits.open(key, "here")
		edits.open(other, "there")

		val thrown = try {
			edits.send(key, opening) { error("down") }
			null
		} catch (down: IllegalStateException) {
			down.message
		}

		assertEquals("down", thrown)
		assertEquals(EditSession<String, String>("here", "here", opening), edits.held.value[key])
		assertEquals("there", edits.held.value.getValue(other).draft)
		edits.clear()
		assertTrue(edits.held.value.isEmpty())
	}

	@Test
	fun aPageThatLeavesDropsAnUntouchedEditAndKeepsATouchedOneUnasked() {
		val edits = sessions()
		val touched = edits.open(key, "opened")
		edits.edit(key, touched) { "changed" }
		assertFalse(edits.askLeave(key))

		edits.park(key, touched)
		assertNull(edits.leaving.value)
		assertEquals(touched, edits.open(key, "a later page"))
		assertEquals("changed", edits.held.value.getValue(key).draft)

		edits.discard(key, touched)
		val untouched = edits.open(key, "opened")
		edits.park(key, untouched)
		assertEquals(EditorShowing.CLOSING, edits.showing(untouched))
	}

	@Test
	fun backLeavesAnEditNoPageDrawsAndAnUntouchedOneThatSettlesUnwatchedIsDropped() = runBlocking {
		val edits = sessions()
		val touched = edits.open(key, "opened")
		edits.edit(key, touched) { "changed" }
		edits.park(key, touched)

		assertTrue(edits.askLeave(key))
		assertNull(edits.leaving.value)
		assertEquals("changed", edits.held.value.getValue(key).draft)

		edits.discard(key, touched)
		val untouched = edits.open(key, "opened")
		val gate = CompletableDeferred<Unit>()
		val deleting = async {
			edits.send(key, untouched) {
				gate.await()
				EditOutcome.Stays("this Gateway still runs it")
			}
		}
		yield()
		edits.park(key, untouched)
		gate.complete(Unit)
		deleting.await()

		assertEquals(listOf("this Gateway still runs it"), told)
		assertNull(edits.held.value[key])
		assertEquals(setOf("held"), setOfNotNull(hiddenEditor("held", setOf("held")), hiddenEditor("ended", setOf("held")), hiddenEditor(null, setOf("held"))))
	}

	@Test
	fun whatIsTypedReachesItsSessionAtOnceAndAHeldRecordWaitsForItsList() {
		val edits = sessions()
		val opening = edits.open(key, "opened")
		var draft by MirroredDraft("opened") { next -> edits.edit(key, opening) { next } }

		draft = "typed"

		assertEquals("typed", draft)
		assertEquals("typed", edits.held.value.getValue(key).draft)
		assertFalse(edits.askLeave(key))
		assertEquals(EditStanding.READY, editStanding(id = null, held = null, listed = false))
		assertEquals(EditStanding.READY, editStanding(id = "apt", held = "record", listed = false))
		assertEquals(EditStanding.WAITING, editStanding(id = "apt", held = null, listed = false))
		assertEquals(EditStanding.GONE, editStanding(id = "apt", held = null, listed = true))
		assertEquals("Apt: revision 5 is stored", leftLine("Apt", "Policy", "revision 5 is stored"))
		assertEquals("Policy: unreachable", leftLine(" ", "Policy", "unreachable"))
	}

	@Test
	fun aPageDrawsOnlyItsOwnOpening() {
		val edits = sessions()

		assertEquals(EditorShowing.OPENING, edits.showing(null))
		val opening = edits.open(key, "opened")
		assertEquals(EditorShowing.DRAWN, edits.showing(opening))
		assertEquals(EditorShowing.CLOSING, edits.showing(opening + 1))
	}
}
