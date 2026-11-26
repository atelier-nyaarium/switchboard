package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.EditContext
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.TextPreview
import com.atelier_nyaarium.switchboard.assistant.TextRef
import com.atelier_nyaarium.switchboard.assistant.StepDraft
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.holeAssist
import com.atelier_nyaarium.switchboard.assistant.holeAt
import com.atelier_nyaarium.switchboard.assistant.holePaint
import com.atelier_nyaarium.switchboard.assistant.nameShapes
import com.atelier_nyaarium.switchboard.assistant.namesHere
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.pickCompletion
import com.atelier_nyaarium.switchboard.assistant.refusedSpan
import com.atelier_nyaarium.switchboard.assistant.textAt
import com.atelier_nyaarium.switchboard.assistant.textParam
import com.atelier_nyaarium.switchboard.assistant.withEntity
import com.atelier_nyaarium.switchboard.assistant.withName
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleCompletion
import com.atelier_nyaarium.switchboard.liveconsole.HolePart
import com.atelier_nyaarium.switchboard.liveconsole.applyTo
import com.atelier_nyaarium.switchboard.liveconsole.consoleAssist
import com.atelier_nyaarium.switchboard.liveconsole.scanHoles
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewName
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEntityDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleMemberDescription
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HoleTextRulesTest {
	private val text = "It is {value} at {device"

	private val console = ConsoleDescription(
		builtins = emptyList(),
		entities = listOf(
			ConsoleEntityDescription(
				name = "sensors",
				description = "Paired sensors.",
				catalogue = false,
				members = listOf(
					ConsoleMemberDescription("list", "property", "List<Sensor>", "", emptyList(), slow = false),
					ConsoleMemberDescription("listen", "method", "List<Advert>", "", emptyList(), slow = true),
				),
			),
		),
	)

	private val names = namesHere(
		offerOf(SANDBOX_SERVES, away = false),
		"event",
		listOf(AutomationPreviewName("event", "Fix the build"), AutomationPreviewName("source", "GitHub")),
	)

	@Test
	fun aPickThatFinishesAnOpenHoleClosesItAndOneStillBeingTypedLeavesItOpen() {
		val entities = setOf("sensors")
		val pick = { typed: String, insert: String, start: Int, end: Int -> pickCompletion(typed, ConsoleCompletion(insert, insert, start, end), entities) }
		val offered = holeAssist("On {sou", 7, console, null, nameShapes(names, emptyList())).completions.single()

		assertEquals("On {source}" to 11, pickCompletion("On {sou", offered, entities))
		assertEquals("On {source}" to 10, pick("On {sou}", "source", 4, 7))
		assertEquals("{event.reason" to 13, pick("{event.re", "reason", 7, 9))
		assertEquals("{round(" to 7, pick("{rou", "round(", 1, 4))
		assertEquals("{round(source" to 13, pick("{round(sou", "source", 7, 10))
		assertEquals("{sensors" to 8, pick("{sens", "sensors", 1, 5))
		assertEquals("{source and more" to 7, pick("{sou and more", "source", 1, 4))
		assertEquals("{round(value) + source}" to 23, pick("{round(value) + sou", "source", 16, 19))
	}

	@Test
	fun aTextMayUseTheServedRowsNamesBeforeItsTriggerIsCompleteAndTheirValuesOnceAnswered() {
		val offer = offerOf(SANDBOX_SERVES, away = false)
		val crossing = listOf("value", "device", "measure", "threshold")
		val untyped = namesHere(offer, "crossing", null)
		val answered = namesHere(offer, "crossing", listOf(AutomationPreviewName("value", "1.8 °C"), AutomationPreviewName("wind", "calm")))

		assertEquals(crossing, untyped.map { it.name })
		assertEquals(listOf(true, true, true, true), untyped.map { it.description.isNotEmpty() && it.shown == null })
		assertEquals(crossing, answered.map { it.name })
		assertEquals(listOf("1.8 °C", null, null, null), answered.map { it.shown })
		assertEquals(listOf("time"), namesHere(offer, "time", null).map { it.name })
		assertEquals(emptyList<Any>(), namesHere(offer.copy(triggers = emptyList()), "crossing", null))
	}

	@Test
	fun functionValuesFollowTriggerNamesWithTheirTypeAndThisAutomationsValue() {
		val offer = offerOf(SANDBOX_SERVES, away = false)
		val names = namesHere(
			offer,
			"crossing",
			null,
			listOf(FunctionParam("lamp", "device"), FunctionParam("message", "text"), FunctionParam("target", "number")),
			mapOf("lamp" to SANDBOX_SWITCH, "message" to "Good night", "target" to "26"),
		)

		assertEquals(listOf("value", "device", "measure", "threshold", "lamp", "message", "target"), names.map { it.name })
		assertEquals(listOf("Device", "Text", "Number"), names.takeLast(3).map { it.description })
		assertEquals(listOf("Desk lamp", "Good night", "26"), names.takeLast(3).map { it.shown })
	}

	@Test
	fun theCursorIsInAHoleOnlyBetweenItsBracesAndAnOpenOneRunsToTheEnd() {
		val inside = { cursor: Int -> holeAt(text, cursor)?.source }

		assertEquals(listOf(null, "value", "value", null), listOf(6, 7, 12, 13).map(inside))
		assertEquals(listOf(null, "device", "device"), listOf(17, 18, text.length).map(inside))
	}

	@Test
	fun aNameGoesInBareInsideAHoleAndAsItsOwnHoleOutsideAndAnEntityLeavesTheCursorAfterItsDot() {
		assertEquals("It {time}is" to 9, withName("It is", 3, "time"))
		assertEquals("{a + time}" to 9, withName("{a + }", 5, "time"))
		assertEquals("Now {sensors.}" to 13, withEntity("Now ", 4, "sensors"))
		assertEquals("{sensors.}" to 9, withEntity("{}", 1, "sensors"))
		// Odd backslash escapes the brace.
		val holes = { text: String -> scanHoles(text).count { it is HolePart.Hole } }
		val inserted = listOf(withName("C:\\", 3, "time"), withEntity("C:\\", 3, "sensors"), withName("a\\\\", 3, "time"))
		assertEquals(listOf(1, 1, 1), inserted.map { holes(it.first) })
		assertEquals("a\\\\{time}" to 9, inserted[2])
	}

	@Test
	fun paintCoversEachHolesBracesAndExpressionAndEachEscapeAndNothingElse() {
		val painted = { source: String ->
			holePaint(source, entities = setOf("sensors"), names = setOf("value")).map { source.substring(it.start, it.end) to it.token }
		}

		assertEquals(
			listOf("{" to CodeToken.PUNCTUATION, "value" to CodeToken.VARIABLE, "}" to CodeToken.PUNCTUATION),
			painted("It is {value} out"),
		)
		assertEquals(
			listOf("{" to CodeToken.PUNCTUATION, "sensors" to CodeToken.TYPE, "." to CodeToken.PUNCTUATION, "list" to CodeToken.FUNCTION),
			painted("See {sensors.list"),
		)
		assertEquals(listOf("\\{" to CodeToken.ESCAPE, "\\\\" to CodeToken.ESCAPE), painted("a \\{b} c \\\\ d"))
		assertEquals(
			listOf("round" to CodeToken.FUNCTION, "value" to CodeToken.VARIABLE, "other" to CodeToken.PROPERTY),
			painted("{round(value) + other}").filter { it.second != CodeToken.PUNCTUATION && it.second != CodeToken.OPERATOR },
		)
		assertEquals(emptyList<Any>(), painted("plain } text"))
	}

	@Test
	fun completionsAreOfferedForTheHoleUnderTheCursorAndLandInTheWholeText() {
		val shapes = nameShapes(names, eventFields = listOf("reason", "title"))
		val typed = "On {source}: {ev"

		val offered = holeAssist(typed, typed.length, console, null, shapes).completions
		val member = holeAssist("{event.re}", 9, console, null, shapes).completions

		assertEquals(listOf("event"), offered.map { it.label })
		assertEquals("On {source}: {event" to 19, offered.single().applyTo(typed))
		assertEquals(listOf("reason"), member.map { it.label })
		assertEquals(emptyList<Any>(), holeAssist(typed, 2, console, null, shapes).completions)
		assertEquals(listOf("list"), holeAssist("{sensors.}", 9, console, null, shapes).completions.map { it.label })
		assertEquals(listOf("list", "listen"), consoleAssist("sensors.", 8, console, null, shapes).completions.map { it.label })
		assertEquals(listOf("reason", "title", "id", "url"), shapes.getValue("event")?.fields)
		assertNull(shapes.getValue("source"))
	}

	@Test
	fun aRefNamesOneTextOfTheDraftWithTheLabelAndCapItsGatewayGaveIt() {
		val offer = offerOf(SANDBOX_SERVES, away = false)
		val draft = AutomationDraft(
			"a",
			TriggerDraft.Interval("1", com.atelier_nyaarium.switchboard.assistant.IntervalUnit.HOURS),
			listOf(
				StepDraft.Do("tell", toldDraft("now", "Hi")),
				StepDraft.Do("ifttt", iftttDraft("door", value2 = "two")),
				StepDraft.Do("plug", plugDraft("aa", "on")),
			),
			enabled = true,
			revision = 0L,
			EditContext(offer, emptyList()),
		)
		val at = { key: String, param: String -> textAt(draft, TextRef(key, param), offer) }
		val named = { key: String, param: String -> textParam(draft, TextRef(key, param), offer)?.let { it.label to it.max } }

		assertEquals(
			listOf("Hi", null, "two", null, null, null),
			listOf(at("tell", "message"), at("tell", "value1"), at("ifttt", "value2"), at("ifttt", "event"), at("plug", "verb"), at("missing", "message")),
		)
		assertEquals(listOf("Message" to 1_000, "Value 2" to 500, null), listOf(named("tell", "message"), named("ifttt", "value2"), named("tell", "when")))
		assertNull(textAt(draft, TextRef("tell", "message"), offerOf(null, away = false)))
	}

	@Test
	fun theMarkedSpanIsThePreviewsElseTheSavesAndStaysInsideTheText() {
		val saved = AutomationSaid.Hole("tell", "message", 6, 13, "no", text)

		assertEquals(6 until 13, refusedSpan(text, TextPreview.Plain, saved))
		assertEquals(17 until 24, refusedSpan(text, TextPreview.Refused("missing }", 17, 90), saved))
		assertNull(refusedSpan(text, TextPreview.Filled("x"), null))
		assertEquals(true, refusedSpan("", TextPreview.Refused("needs an expression", 0, 0), null)?.isEmpty())
	}
}
