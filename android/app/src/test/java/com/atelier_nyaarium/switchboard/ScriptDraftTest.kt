package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationOffer
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.automationDraftOf
import com.atelier_nyaarium.switchboard.assistant.automationEditing
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import com.atelier_nyaarium.switchboard.assistant.cardsAllowed
import com.atelier_nyaarium.switchboard.assistant.discardedScript
import com.atelier_nyaarium.switchboard.assistant.errorsAsk
import com.atelier_nyaarium.switchboard.assistant.errorsUnkept
import com.atelier_nyaarium.switchboard.assistant.functionSaveOf
import com.atelier_nyaarium.switchboard.assistant.holdsErrors
import com.atelier_nyaarium.switchboard.assistant.parsedInto
import com.atelier_nyaarium.switchboard.assistant.scriptIssues
import com.atelier_nyaarium.switchboard.assistant.scriptOf
import com.atelier_nyaarium.switchboard.assistant.scriptParseOp
import com.atelier_nyaarium.switchboard.assistant.scriptPending
import com.atelier_nyaarium.switchboard.assistant.scriptPrintOp
import com.atelier_nyaarium.switchboard.assistant.shownAs
import com.atelier_nyaarium.switchboard.assistant.startedScript
import com.atelier_nyaarium.switchboard.assistant.typedScript
import com.atelier_nyaarium.switchboard.assistant.unkeyed
import com.atelier_nyaarium.switchboard.assistant.LineMark
import com.atelier_nyaarium.switchboard.assistant.KeptLine
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.keptLines
import com.atelier_nyaarium.switchboard.assistant.Served
import com.atelier_nyaarium.switchboard.assistant.rowScriptErrors
import com.atelier_nyaarium.switchboard.assistant.ScriptShown
import com.atelier_nyaarium.switchboard.assistant.scriptShown
import com.atelier_nyaarium.switchboard.assistant.scriptShapes
import com.atelier_nyaarium.switchboard.assistant.scriptCurrent
import com.atelier_nyaarium.switchboard.assistant.PointMode
import com.atelier_nyaarium.switchboard.assistant.RunsHead
import com.atelier_nyaarium.switchboard.assistant.calleeOf
import com.atelier_nyaarium.switchboard.assistant.pointedTo
import com.atelier_nyaarium.switchboard.assistant.parseFailed
import com.atelier_nyaarium.switchboard.assistant.parseRetried
import com.atelier_nyaarium.switchboard.assistant.parseToSend
import com.atelier_nyaarium.switchboard.assistant.keyGone
import com.atelier_nyaarium.switchboard.assistant.jumpedTo
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.SaidAt
import com.atelier_nyaarium.switchboard.assistant.ScriptEdit
import com.atelier_nyaarium.switchboard.assistant.ScriptPage
import com.atelier_nyaarium.switchboard.assistant.TextRef
import com.atelier_nyaarium.switchboard.assistant.freshBody
import com.atelier_nyaarium.switchboard.assistant.reloadedFunction
import com.atelier_nyaarium.switchboard.assistant.withFunctionName
import com.atelier_nyaarium.switchboard.proto.ScriptName
import com.atelier_nyaarium.switchboard.proto.ScriptType
import com.atelier_nyaarium.switchboard.proto.ScriptTypeMember
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptPrintResult
import com.atelier_nyaarium.switchboard.assistant.scriptLines
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.ScriptStatement
import com.atelier_nyaarium.switchboard.proto.StepArg
import kotlinx.serialization.json.JsonPrimitive
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptParseResult
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.ScriptIssue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScriptDraftTest {
	private val none = SourceFields(emptyList())
	private val offer: AutomationOffer = FN_OFFER.copy(
		functions = FN_OFFER.functions!!.copy(
			served = FN_OFFER.functions!!.served.copy(
				script = true,
				statements = FN_OFFER.functions!!.served.statements.orEmpty() + "unparsed",
			),
		),
	)
	private val pointed = Automation(enabled = true, trigger = CROSSING, actions = listOf(AutomationAction.RunFunction(function = "warm")))

	private fun opened(steps: List<FunctionStep>, at: AutomationOffer = offer, users: List<String> = listOf("mine")): AutomationDraft {
		val rows = listOf(functionRow("warm", "Warm", users, steps = steps))
		val listed = at.copy(functions = at.functions!!.copy(rows = rows))
		return automationDraftOf(AutomationRow("mine", 2L, pointed, "Thermometer above 26 °C"), EditContext(listed, emptyList()))!!
	}

	private fun AutomationDraft.offered(): AutomationOffer = context.offer

	private val issues = ConsoleScriptParseResult(
		issues = listOf(ScriptIssue(0, 1, "it does nothing")),
		names = emptyList(),
		types = emptyList(),
		statements = emptyList(),
	)

	private fun steps(vararg steps: FunctionStep) =
		ConsoleScriptParseResult(steps = steps.toList(), names = emptyList(), types = emptyList(), statements = emptyList())

	/** Apply the parse answer. */
	private fun AutomationDraft.answered(answer: ConsoleScriptParseResult): AutomationDraft {
		val asked = scriptParseOp(this, null, offered())!!
		return parsedInto(null, asked, answer, offered())
	}

	@Test
	fun aScriptThatReadsReplacesTheCardsAndAnAnswerForOlderTextLandsNothing() {
		val draft = opened(listOf(plugStep("on"))).startedScript(null, "devices.set(\"Desk lamp\", \"on\")")
		val stale = scriptParseOp(draft, null, draft.offered())!!
		val typed = draft.typedScript(null, "devices.set(\"Desk lamp\", \"off\")")
		val ignored = typed.parsedInto(null, stale, steps(plugStep("on"), plugStep("on")), typed.offered())
		val pendingBefore = scriptPending(typed, typed.offered())
		val landed = typed.answered(steps(plugStep("off")))

		assertEquals(typed, ignored)
		assertTrue(pendingBefore)
		assertFalse(scriptPending(landed, landed.offered()))
		val saved = functionSaveOf(landed, none, landed.offered(), confirmed = false)?.function as AutomationSaveFunction.Edit
		assertEquals(listOf(plugStep("off")), written(saved.body))
		assertTrue(cardsAllowed(landed, null, landed.offered()))
		val cards = landed.shownAs(null, script = false, landed.offered())
		assertNull(cards.scriptOf(null))
		assertFalse(cards.scripted)
	}

	@Test
	fun aScriptWithErrorsSavesAsOneStepAndAsksOnceWhenTheErrorsAreNew() {
		val draft = opened(listOf(plugStep("on"))).startedScript(null, "x")
		val broken = draft.typedScript(null, "devices.set(").answered(issues)
		val op = functionSaveOf(broken, none, broken.offered(), confirmed = false)
		val storedBroken = opened(listOf(FunctionStep.Unparsed("devices.set(")))

		assertTrue(holdsErrors(broken.steps))
		assertFalse(cardsAllowed(broken, null, broken.offered()))
		assertEquals(broken, broken.shownAs(null, script = false, broken.offered()))
		assertEquals(1, scriptIssues(broken, null, broken.offered()).size)
		val body = (op?.function as AutomationSaveFunction.Edit).body
		assertEquals(listOf(FunctionStep.Unparsed("devices.set(")), written(body))
		assertEquals(listOf("Warm"), errorsAsk(broken, broken.offered())?.functions)
		assertNull(errorsAsk(storedBroken, storedBroken.offered()))
	}

	@Test
	fun aStoredScriptWithErrorsOpensAsItsTextAndReadsAsAChangeOnceItParses() {
		val draft = opened(listOf(FunctionStep.Unparsed("devices.set(\"Desk lamp\", \"on\")")))
		val opening = draft
		val fixed = draft.answered(steps(plugStep("on")))

		assertTrue(draft.scripted)
		assertEquals("devices.set(\"Desk lamp\", \"on\")", draft.scriptOf(null)?.text)
		assertFalse(draft.changedFrom(opening))
		assertTrue(fixed.changedFrom(opening))
		assertNull(scriptPrintOp(draft, null, draft.offered()))
	}

	@Test
	fun discardReturnsToTheCardsItBeganFromOrToAStoredScriptsText() {
		val cards = opened(listOf(plugStep("on")))
		val discarded = cards.startedScript(null, "a").typedScript(null, "b").answered(issues).discardedScript(null)
		val stored = opened(listOf(FunctionStep.Unparsed("broken(")))
		val back = stored.typedScript(null, "devices.set(").answered(issues).discardedScript(null)

		assertEquals(unkeyed(cards.steps), unkeyed(discarded.steps))
		assertNull(discarded.scriptOf(null))
		assertEquals("broken(", back.scriptOf(null)?.text)
		assertFalse(back.changedFrom(stored))
	}

	@Test
	fun saveWaitsForTheParseOfTheTextShownAndForAGatewayThatCanKeepErrors() {
		val held = opened(listOf(plugStep("on")))
		val typed = held.startedScript(null, "a").typedScript(null, "devices.set(\"Desk lamp\", \"off\")")
		val landed = typed.answered(steps(plugStep("off")))
		val olderOffer = offer.copy(functions = offer.functions!!.copy(served = offer.functions!!.served.copy(statements = listOf("do", "if"))))
		val older = opened(listOf(plugStep("on")), olderOffer).startedScript(null, "a").typedScript(null, "x(")
		val olderBroken = older.answered(issues)

		fun canSave(draft: AutomationDraft) =
			automationEditing(AutomationSlot.Held("mine"), draft, none, offered = true, busy = false, gone = false, draft.offered()).save

		assertFalse(canSave(typed))
		assertTrue(canSave(landed))
		assertTrue(errorsUnkept(olderBroken, olderBroken.offered()))
		assertFalse(canSave(olderBroken))
	}

	@Test
	fun aParseIsAskedAgainWhenTheValuesItReadsAgainstChange() {
		val draft = opened(listOf(plugStep("on"))).startedScript(null, "a").answered(steps(plugStep("on")))
		val renamed = draft.copy(
			runs = (draft.runs as com.atelier_nyaarium.switchboard.assistant.RunsHead.Points).let {
				it.copy(pointing = it.pointing.copy(params = listOf(com.atelier_nyaarium.switchboard.assistant.FunctionValueDraft("k", com.atelier_nyaarium.switchboard.proto.FunctionParam("room", "device")))))
			},
		)

		assertFalse(scriptPending(draft, draft.offered()))
		assertTrue(scriptPending(renamed, renamed.offered()))
		assertNotNull(scriptParseOp(renamed, null, renamed.offered())?.params)
	}

	@Test
	fun eachLineShowsHowTheStatementItOpensEndedInTheLastRun() {
		val text = "a = 1\nif (x) {\n\tdevices.set(lamp, \"on\")\n}\nexit"
		val statements = listOf(ScriptStatement("0", 0, 5), ScriptStatement("1", 6, 41), ScriptStatement("1.0.0", 16, 39), ScriptStatement("2", 42, 46))
		val run = AutomationLastRun(
			at = 1L,
			revision = 2L,
			steps = listOf(
				AutomationLastStep("0.0", "let", "ran"),
				AutomationLastStep("0.1", "if", "ran", side = "then"),
				AutomationLastStep("0.1.0.0", "device_set", "refused", reason = "unreachable"),
			),
			running = false,
		)
		val lines = scriptLines(text, statements, run, pointing = true)

		assertEquals(
			listOf(LineMark.RAN, LineMark.RAN, LineMark.FAILED, null, LineMark.UNREACHED),
			lines.map { it.mark },
		)
		assertEquals("unreachable", lines[2].said)
		assertEquals(listOf("a = 1", "if (x) {", "\tdevices.set(lamp, \"on\")", "}", "exit"), lines.map { text.substring(it.start, it.end) })
		assertTrue(scriptLines(text, statements, null, pointing = true).all { it.mark == null })
	}

	@Test
	fun aKeptCardShowsItsFirstLineOfScriptAndWhereItStarts() {
		val cards = listOf(
			StepDraft.Kept("kept", FunctionStep.Let("humid", StepArg.Literal(JsonPrimitive("1")))),
			StepDraft.Do("plain", plugDraft(SANDBOX_SWITCH, "on")),
			StepDraft.Kept("block", FunctionStep.Parallel(listOf(plugStep("on")))),
		)
		val text = "humid = \"1\"\ndevices.set(\"Desk lamp\", \"on\")\nparallel {\n\tdevices.set(\"Desk lamp\", \"on\")\n}"
		val print = ConsoleScriptPrintResult(
			text = text,
			names = emptyList(),
			types = emptyList(),
			statements = listOf(ScriptStatement("0", 0, 11), ScriptStatement("1", 12, 42), ScriptStatement("2", 43, text.length.toLong())),
		)

		assertEquals(mapOf("kept" to KeptLine("humid = \"1\"", 0), "block" to KeptLine("parallel {", 43)), keptLines(cards, print))
		assertEquals(emptyMap<String, KeptLine>(), keptLines(cards, null))
	}

	@Test
	fun aRowSaysItsScriptHasErrorsWhenAFunctionItReachesHoldsThem() {
		val call = FunctionStep.Call(function = "inner")
		val rows = listOf(
			functionRow("outer", "Outer", listOf("mine"), steps = listOf(call)),
			functionRow("inner", "Inner", emptyList(), steps = listOf(FunctionStep.Unparsed("x("))),
			functionRow("fine", "Fine", listOf("other")),
		)
		val served = Served.Known(offer.copy(functions = offer.functions!!.copy(rows = rows)))
		fun row(function: String) = AutomationRow(function, 1L, pointed.copy(actions = listOf(AutomationAction.RunFunction(function = function))), "")

		assertTrue(rowScriptErrors(row("outer"), served))
		assertFalse(rowScriptErrors(row("fine"), served))
		val shared = opened(listOf(plugStep("on")), users = listOf("mine", "other")).startedScript(null, "a").typedScript(null, "x(").answered(issues)
		val others = listOf(AutomationRow("other", 1L, pointed, "Downstairs above 26 °C"))
		assertEquals(listOf("Downstairs above 26 °C"), errorsAsk(shared, shared.offered(), others)?.others)
	}

	@Test
	fun anAnswerForTheSameTextUnderAnotherContextLandsNothingAndShowsNothing() {
		val draft = opened(listOf(plugStep("on"))).startedScript(null, "a").typedScript(null, "x(")
		val asked = scriptParseOp(draft, null, draft.offered())!!
		val broken = draft.parsedInto(null, asked, issues, draft.offered())
		val moved = broken.copy(trigger = (broken.trigger as com.atelier_nyaarium.switchboard.assistant.TriggerDraft.Crossing).copy(threshold = "31"))
		val stale = moved.parsedInto(null, asked, steps(plugStep("off")), moved.offered())

		assertEquals(moved, stale)
		assertTrue(scriptCurrent(broken, null, broken.offered()))
		assertFalse(scriptCurrent(moved, null, moved.offered()))
		assertEquals(emptyList<ScriptIssue>(), scriptIssues(moved, null, moved.offered()))
		assertTrue((scriptShown(moved, null, moved.offered(), null, false) as ScriptShown.Text).checking)
	}

	@Test
	fun typingThatReadsAsTheSameStepsIsNoChange() {
		val held = opened(listOf(plugStep("on")))
		val typed = held.startedScript(null, "a").typedScript(null, "// note\na")

		assertTrue(typed.changedFrom(held))
		assertFalse(typed.answered(steps(plugStep("on"))).changedFrom(held))
		assertTrue(typed.answered(steps(plugStep("off"))).changedFrom(held))
	}

	@Test
	fun theViewSaysAStoredScriptReadsNowAndOffersDiscardOnlyForAChange() {
		val stored = opened(listOf(FunctionStep.Unparsed("broken(")))
		val fixed = stored.typedScript(null, "devices.set(\"Desk lamp\", \"on\")").answered(steps(plugStep("on")))
		val untouched = stored.answered(issues)

		val shownFixed = scriptShown(fixed, null, fixed.offered(), null, false) as ScriptShown.Text
		val shownUntouched = scriptShown(untouched, null, untouched.offered(), null, false) as ScriptShown.Text
		assertTrue(shownFixed.fixed)
		assertFalse(shownFixed.errors)
		assertTrue(shownFixed.discard)
		assertTrue(shownUntouched.errors)
		assertFalse(shownUntouched.discard)
		assertEquals(ScriptShown.Reading, scriptShown(opened(listOf(plugStep("on"))), null, offer, null, false))
		assertEquals(ScriptShown.Unread, scriptShown(opened(listOf(plugStep("on"))), null, offer, null, true))
	}

	@Test
	fun theErrorsAskNamesWhoRunsACalleeAndNoOneForACopy() {
		val call = FunctionStep.Call(function = "inner")
		val rows = listOf(
			functionRow("warm", "Warm", listOf("mine"), steps = listOf(call)),
			functionRow("inner", "Inner", listOf("other"), steps = listOf(plugStep("on"))).copy(callers = listOf("warm")),
		)
		val listed = offer.copy(functions = offer.functions!!.copy(rows = rows))
		val draft = automationDraftOf(AutomationRow("mine", 2L, pointed, ""), EditContext(listed, emptyList()))!!
		val callee = calleeOf(rows[1], listed).copy(script = com.atelier_nyaarium.switchboard.assistant.ScriptEdit("x(", "a", emptyList()), scripted = true)
		val withCallee = draft.copy(callees = mapOf("inner" to callee))
		val broken = withCallee.parsedInto("inner", scriptParseOp(withCallee, "inner", listed)!!, issues, listed)
		val automations = listOf(AutomationRow("other", 1L, pointed, "Downstairs above 26 °C"))
		val copied = opened(listOf(plugStep("on")), users = listOf("mine", "other")).let { held ->
			held.copy(runs = (held.runs as RunsHead.Points).let { it.copy(pointing = it.pointing.copy(mode = PointMode.UNIQUE)) })
		}.startedScript(null, "a").typedScript(null, "x(").answered(issues)

		assertEquals(listOf("Inner"), errorsAsk(broken, listed, automations)?.functions)
		assertEquals(listOf("Downstairs above 26 °C"), errorsAsk(broken, listed, automations)?.others)
		assertEquals(emptyList<String>(), errorsAsk(copied, copied.offered(), automations)?.others)
	}

	@Test
	fun completionsOfferAMembersTypeOnlyWhereItsNameReaches() {
		val names = listOf(ScriptName("e", "Error", 20, 40), ScriptName("first", "Error", 50, 60))
		val types = listOf(ScriptType("Error", listOf(ScriptTypeMember("code", "Text"))))

		assertEquals(setOf("e"), scriptShapes(names, types, 30).keys)
		assertEquals(emptySet<String>(), scriptShapes(names, types, 45).keys)
		assertEquals(listOf("code"), scriptShapes(names, types, 55)["first"]?.fields)
	}

	private fun withTypedCallee(): Pair<AutomationDraft, AutomationOffer> {
		val inner = functionRow("inner", "Inner", emptyList(), steps = listOf(plugStep("on")))
		val rows = listOf(functionRow("warm", "Warm", listOf("mine")), inner)
		val listed = offer.copy(functions = offer.functions!!.copy(rows = rows))
		val draft = automationDraftOf(AutomationRow("mine", 2L, pointed, ""), EditContext(listed, emptyList()))!!
		val callee = calleeOf(inner, listed).copy(script = ScriptEdit("devices.set(\"Desk lamp\", \"off\")", "a", emptyList()), scripted = true)
		return draft.copy(callees = mapOf("inner" to callee)) to listed
	}

	@Test
	fun pickingACalleeWhoseScriptIsUnreadCarriesTheTextAndSaveWaitsForIt() {
		val (draft, listed) = withTypedCallee()
		val picked = draft.pointedTo(listed.functions!!.row("inner")!!, listed)

		assertEquals("devices.set(\"Desk lamp\", \"off\")", picked.scriptOf(null)?.text)
		assertTrue(scriptPending(picked, listed))
	}

	@Test
	fun aParseWithNoAnswerWaitsForRetryAndAnOverlongTextIsNotSent() {
		val draft = opened(listOf(plugStep("on"))).startedScript(null, "a").typedScript(null, "x(")
		val asked = parseToSend(draft, null, draft.offered())!!
		val failed = draft.parseFailed(null, asked, draft.offered())
		val retried = failed.parseRetried(null)
		val long = draft.typedScript(null, "x".repeat(com.atelier_nyaarium.switchboard.proto.Protocol.Wire.SCRIPT_SOURCE_MAX + 1))

		assertNull(parseToSend(failed, null, failed.offered()))
		assertTrue((scriptShown(failed, null, failed.offered(), null, false) as ScriptShown.Text).failed)
		assertEquals(asked, parseToSend(retried, null, retried.offered()))
		assertNull(parseToSend(long, null, long.offered()))
		assertTrue((scriptShown(long, null, long.offered(), null, false) as ScriptShown.Text).tooLong)
	}

	@Test
	fun aRefusalHeldByACardAParseReplacedIsGone() {
		val draft = opened(listOf(plugStep("on")))
		val key = draft.steps.single().key
		val said = AutomationSaid.Field(SaidAt.Card(key, "verb"), "refused", "on")
		val reparsed = draft.startedScript(null, "a").answered(steps(plugStep("on")))

		assertFalse(keyGone(said, draft))
		assertTrue(keyGone(said, reparsed))
		assertFalse(keyGone(AutomationSaid.Line("x"), reparsed))
	}

	@Test
	fun aListRefreshKeepsACalleesTypedScriptAndTheSameIssueJumpsAgain() {
		val (draft, listed) = withTypedCallee()
		val newer = listed.copy(functions = listed.functions!!.copy(rows = listed.functions!!.rows.map { if (it.id == "inner") it.copy(revision = 9L) else it }))
		val page = draft.startedScript(null, "a")

		assertEquals(draft.callees["inner"]?.script, draft.freshened(newer).callees["inner"]?.script)
		assertEquals(draft.callees["inner"]?.script, draft.openedCallee("inner", newer).callees["inner"]?.script)
		val once = page.jumpedTo(3)
		val twice = once.jumpedTo(3)
		assertEquals(3, twice.scriptPage?.at)
		assertTrue(twice.scriptPage!!.jumps > once.scriptPage!!.jumps)
	}

	@Test
	fun everySwapOfATreeClosesPagesIntoTheOldOneAndOpensAStoredScriptAsText() {
		val held = opened(listOf(plugStep("on")))
		val own = held.copy(text = TextRef(held.steps.single().key, "verb"), scriptPage = ScriptPage(null))
		val broken = functionRow("warm", "Warm", listOf("mine"), steps = listOf(FunctionStep.Unparsed("x(")), revision = 9L)
		val other = functionRow("other", "Other", emptyList())
		val reloaded = own.reloadedFunction(broken, own.offered()).first
		val (withCallee, listed) = withTypedCallee()
		val calleeKey = withCallee.callees.getValue("inner").steps.single().key
		val inCallee = withCallee.copy(text = TextRef(calleeKey, "verb"), scriptPage = ScriptPage("inner"))
		val newer = functionRow("inner", "Inner", emptyList(), steps = listOf(plugStep("off")), revision = 9L)
		val reloadedCallee = inCallee.reloadedCallee(newer, listed).first

		for (swapped in listOf(own.freshBody(), reloaded, own.pointedTo(other, own.offered().copy(functions = own.offered().functions!!.copy(rows = own.offered().functions!!.rows + other))), reloadedCallee)) {
			assertNull(swapped.text)
			assertNull(swapped.scriptPage)
		}
		assertEquals("x(", reloaded.scriptOf(null)?.text)
		assertTrue(reloaded.scripted)
		assertNull(reloadedCallee.scriptOf("inner"))
	}

	@Test
	fun renamingTheFunctionKeepsTheTreesScript() {
		val typed = opened(listOf(plugStep("on"))).startedScript(null, "a").typedScript(null, "b")

		assertEquals(typed.scriptOf(null), typed.withFunctionName("Hall warmth").scriptOf(null))
	}
}
