package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.AutomationDraft
import com.atelier_nyaarium.switchboard.assistant.AutomationSaid
import com.atelier_nyaarium.switchboard.assistant.TextPreview
import com.atelier_nyaarium.switchboard.assistant.TextRef
import com.atelier_nyaarium.switchboard.assistant.TriggerDraft
import com.atelier_nyaarium.switchboard.assistant.holeAssist
import com.atelier_nyaarium.switchboard.assistant.holeAt
import com.atelier_nyaarium.switchboard.assistant.holePaint
import com.atelier_nyaarium.switchboard.assistant.nameShapes
import com.atelier_nyaarium.switchboard.assistant.offerOf
import com.atelier_nyaarium.switchboard.assistant.refusedSpan
import com.atelier_nyaarium.switchboard.assistant.textAt
import com.atelier_nyaarium.switchboard.assistant.textParam
import com.atelier_nyaarium.switchboard.assistant.withEntity
import com.atelier_nyaarium.switchboard.assistant.withName
import com.atelier_nyaarium.switchboard.liveconsole.applyTo
import com.atelier_nyaarium.switchboard.liveconsole.consoleAssist
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewName
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

	private val names = listOf(AutomationPreviewName("event", "Fix the build"), AutomationPreviewName("source", "GitHub"))

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
		val offer = offerOf(SANDBOX_SERVES)
		val draft = AutomationDraft(
			"a",
			TriggerDraft.Interval("1", com.atelier_nyaarium.switchboard.assistant.IntervalUnit.HOURS),
			listOf(toldDraft("now", "Hi"), iftttDraft("door", value2 = "two"), plugDraft("aa", "on")),
			enabled = true,
			revision = 0L,
		)
		val at = { action: Int, param: String -> textAt(draft, TextRef(action, param), offer) }
		val named = { action: Int, param: String -> textParam(draft, TextRef(action, param), offer)?.let { it.label to it.max } }

		assertEquals(
			listOf("Hi", null, "two", null, null, null),
			listOf(at(0, "message"), at(0, "value1"), at(1, "value2"), at(1, "event"), at(2, "verb"), at(9, "message")),
		)
		assertEquals(listOf("Message" to 1_000, "Value 2" to 500, null), listOf(named(0, "message"), named(1, "value2"), named(0, "when")))
		assertNull(textAt(draft, TextRef(0, "message"), offerOf(null)))
	}

	@Test
	fun theMarkedSpanIsThePreviewsElseTheSavesAndStaysInsideTheText() {
		val saved = AutomationSaid.Hole(0, "message", 6, 13, "no", text)

		assertEquals(6 until 13, refusedSpan(text, TextPreview.Plain, saved))
		assertEquals(17 until 24, refusedSpan(text, TextPreview.Refused("missing }", 17, 90), saved))
		assertNull(refusedSpan(text, TextPreview.Filled("x"), null))
		assertEquals(true, refusedSpan("", TextPreview.Refused("needs an expression", 0, 0), null)?.isEmpty())
	}
}
