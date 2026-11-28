package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.BranchLabel
import com.atelier_nyaarium.switchboard.assistant.CardRow
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.Side
import com.atelier_nyaarium.switchboard.assistant.Slot
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.cardHint
import com.atelier_nyaarium.switchboard.assistant.cardLabel
import com.atelier_nyaarium.switchboard.assistant.cardsDraw
import com.atelier_nyaarium.switchboard.assistant.freshStatement
import com.atelier_nyaarium.switchboard.assistant.moveChoices
import com.atelier_nyaarium.switchboard.assistant.movedStep
import com.atelier_nyaarium.switchboard.assistant.pathsOf
import com.atelier_nyaarium.switchboard.assistant.replacedStep
import com.atelier_nyaarium.switchboard.assistant.statementsOffered
import com.atelier_nyaarium.switchboard.assistant.stepOfDraft
import com.atelier_nyaarium.switchboard.assistant.treeOf
import com.atelier_nyaarium.switchboard.assistant.variablesHere
import com.atelier_nyaarium.switchboard.assistant.variablesOf
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StatementCardsTest {
	private fun read(json: String) = treeOf(wireJson.decodeFromString(FunctionStep.serializer(), json), FN_OFFER)

	private fun written(step: StepDraft): String? =
		stepOfDraft(step, FN_OFFER, calleeParams = listed(FN_OFFER))?.let { wireJson.encodeToString(FunctionStep.serializer(), it) }

	/** Gateway-written bodies. */
	private val stored = listOf(
		"""{"kind":"variable","name":"total","value":{"kind":"expression","text":"reading + 1"}}""",
		"""{"kind":"variable","name":"greeting","value":{"kind":"literal","value":"hi \"there\""}}""",
		"""{"kind":"variable","name":"count","value":{"kind":"literal","value":5}}""",
		"""{"kind":"parallel","steps":[{"kind":"return"},{"kind":"comment","text":"b"}]}""",
		"""{"kind":"start","as":"job","steps":[{"kind":"comment","text":"work"}]}""",
		"""{"kind":"start","steps":[]}""",
		"""{"kind":"await","task":"job","as":"result"}""",
		"""{"kind":"await","task":"all(a, b)"}""",
		"""{"kind":"throw","text":"no lamp {reading}"}""",
		"""{"kind":"throw"}""",
	)

	@Test
	fun eachNewCardOpensAsItsOwnCardAndWritesBackByteForByte() {
		val cards = stored.map(::read)

		assertEquals(stored, cards.map(::written))
		assertEquals(
			listOf("Variable", "Variable", "Variable", "Parallel", "Start task", "Start task", "Await task", "Await task", "Throw", "Throw"),
			cards.map { cardLabel(it, FN_OFFER) },
		)
		assertEquals("\"hi \\\"there\\\"\"", (cards[1] as StepDraft.Variable).value)
		assertEquals(listOf("job", ""), listOf(cards[4], cards[5]).map { (it as StepDraft.Start).name })
	}

	@Test
	fun aVariableWritesItsLiteralWhileItStillShowsAndAnEditAsAnExpression() {
		val literal = read(stored[1]) as StepDraft.Variable
		val edited = literal.copy(value = "\"hi\" + \"!\"")
		val restored = edited.copy(value = literal.value)

		assertEquals(
			"""{"kind":"variable","name":"greeting","value":{"kind":"expression","text":"\"hi\" + \"!\""}}""",
			written(edited),
		)
		assertEquals(stored[1], written(restored))
		assertEquals(
			"""{"kind":"variable","name":"fresh","value":{"kind":"expression","text":"1"}}""",
			written(StepDraft.Variable("v", "fresh", "1")),
		)
	}

	@Test
	fun aNameTheGatewayCannotTakeIsNotWrittenAndHintsOnceTyped() {
		fun hint(step: StepDraft) = cardHint(step, FN_OFFER, emptySet(), listed(FN_OFFER))

		assertNull(written(StepDraft.Variable("v", "", "1")))
		assertNull(written(StepDraft.Variable("v", "Total", "1")))
		assertNull(written(StepDraft.Await("a", "", "")))
		assertNull(written(StepDraft.Start("s", "Job 1", emptyList())))
		assertNotNull(written(StepDraft.Start("s", "", emptyList())))
		assertNull(hint(StepDraft.Variable("v", "", "1")))
		assertNotNull(hint(StepDraft.Variable("v", "Total", "1")))
		assertNotNull(hint(StepDraft.Await("a", "job", "Bad")))
		assertNull(hint(StepDraft.Await("a", "job", "")))
	}

	@Test
	fun parallelDrawsOneLabelPerBranchAndOneSlotThatAddsABranch() {
		val parallel = read(stored[3]) as StepDraft.Parallel
		val start = read(stored[4]) as StepDraft.Start
		val rows = cardsDraw(listOf(parallel, start), { null }, null, pointing = false)

		val shape = rows.map { row ->
			when (row) {
				is CardRow.Card -> "card ${row.path}"
				is CardRow.Branch -> "branch ${(row.label as BranchLabel.Parallel).number}"
				is CardRow.AddSlot -> if (row.branch) "add branch ${row.slot.index}" else "add ${row.slot.parent ?: "top"}"
				is CardRow.SideLabel, is CardRow.AddBranch -> "other"
			}
		}
		assertEquals(
			listOf(
				"card 0", "branch 1", "card 0.0.0", "branch 2", "card 0.0.1", "add branch 2",
				"card 1", "card 1.0.0", "add ${start.key}",
				"add top",
			),
			shape,
		)
	}

	@Test
	fun aCardMovesIntoAParallelAsItsNextBranch() {
		val parallel = read(stored[3]) as StepDraft.Parallel
		val tree = listOf(parallel, StepDraft.Return("r"))
		val into = moveChoices(tree, "r", FN_OFFER) { null }.single { it.label == "Into Parallel above" }

		assertEquals(Slot(parallel.key, Side.Body, 2), into.slot)
		assertEquals("0.0.2", pathsOf(movedStep(tree, "r", into.slot)!!)["r"])
	}

	@Test
	fun everyServedStatementIsOfferedAndStartsAFreshCard() {
		val draft = AutomationDraft("a", TriggerDraft.Time("08:00", setOf(1), "UTC"), emptyList(), true, 0L, EditContext(FN_OFFER, emptyList()))
		val offered = statementsOffered(draft, FN_OFFER)

		assertTrue(offered.map { it.label }.containsAll(listOf("Variable", "Run function", "Parallel", "Start task", "Await task", "Throw", "Return", "Comment")))
		assertTrue(offered.all { freshStatement(it.kind) != null })
	}

	@Test
	fun theNamesARunSetsAreItsVariablesAndTasksWithTheErrorInACatch() {
		val variable = StepDraft.Variable("v", "total", "1")
		val task = StepDraft.Start("s", "job", emptyList())
		val result = StepDraft.Await("w", "job", "done")
		val inCatch = StepDraft.Return("r")
		val tree = listOf(variable, task, result, StepDraft.Try("t", emptyList(), listOf(inCatch)))

		assertEquals(listOf("total", "job", "done", "e"), variablesOf(tree))
		assertEquals(
			listOf("total" to "Variable", "job" to "Task", "done" to "Variable", "e" to "Error"),
			variablesHere(tree, "r").map { it.name to it.description },
		)
		val renamed = replacedStep(tree, "v") { (it as StepDraft.Variable).copy(name = "") }
		assertEquals(listOf("job", "done"), variablesHere(renamed, "v").map { it.name })
	}
}
