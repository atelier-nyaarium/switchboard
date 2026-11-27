package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.FlowAct
import com.atelier_nyaarium.switchboard.assistant.FlowColour
import com.atelier_nyaarium.switchboard.assistant.FlowGraph
import com.atelier_nyaarium.switchboard.assistant.FlowInput
import com.atelier_nyaarium.switchboard.assistant.FlowKey
import com.atelier_nyaarium.switchboard.assistant.FlowLine
import com.atelier_nyaarium.switchboard.assistant.FlowNote
import com.atelier_nyaarium.switchboard.assistant.FlowPattern
import com.atelier_nyaarium.switchboard.assistant.FlowReplay
import com.atelier_nyaarium.switchboard.assistant.FlowWeight
import com.atelier_nyaarium.switchboard.assistant.SwitchOffer
import com.atelier_nyaarium.switchboard.assistant.Unfollowed
import com.atelier_nyaarium.switchboard.assistant.colourOf
import com.atelier_nyaarium.switchboard.assistant.flowFacts
import com.atelier_nyaarium.switchboard.assistant.flowGraph
import com.atelier_nyaarium.switchboard.assistant.flowLayout
import com.atelier_nyaarium.switchboard.assistant.flowReach
import com.atelier_nyaarium.switchboard.assistant.flowRuns
import com.atelier_nyaarium.switchboard.assistant.flowSheet
import com.atelier_nyaarium.switchboard.assistant.replayStands
import com.atelier_nyaarium.switchboard.assistant.selectionAfter
import com.atelier_nyaarium.switchboard.assistant.functionDepths
import com.atelier_nyaarium.switchboard.assistant.patternOf
import com.atelier_nyaarium.switchboard.assistant.weightOf
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class FlowMapTest {
	private val expression = { text: String ->
		buildJsonObject {
			put("kind", "expression")
			put("text", text)
		}
	}
	private val setNamed = FunctionStep.Do("device_set", args = JsonObject(mapOf("device" to expression("device"), "verb" to literal("on"))))
	private val tell = FunctionStep.Do("tell_assistant", args = JsonObject(mapOf("when" to literal("now"))))
	private val point = { function: String, device: String? ->
		AutomationAction.RunFunction(function, device?.let { JsonObject(mapOf("device" to JsonPrimitive(it))) })
	}
	private val warm = functionRow(
		"warm",
		"Warm the room",
		listOf("mine", "downstairs"),
		params = listOf(FunctionParam("device", "device")),
		steps = listOf(setNamed, FunctionStep.Call("blink")),
	)
	private val blink = functionRow("blink", "Blink", listOf())
	private val guarded = functionRow("guarded", "Guarded", listOf("caught"), steps = listOf(FunctionStep.Try(listOf(plugStep("on")), listOf(tell))))
	private val bare = functionRow("bare", "Bare", listOf("loose"), steps = listOf(plugStep("on")))
	private val careful = functionRow("careful", "Careful", listOf("wrapped"), steps = listOf(FunctionStep.Try(listOf(FunctionStep.Call("bare")), listOf(tell))))

	private fun input(rows: List<AutomationRow>) = FlowInput(
		rows = rows,
		functions = listOf(warm, blink, guarded, bare, careful),
		sources = emptyList(),
		switches = listOf(SwitchOffer("plug-a", "Heater"), SwitchOffer(SANDBOX_SWITCH, "Lamp")),
		numbers = emptyList(),
	)

	private fun step(path: String, kind: String, outcome: String?, start: Long? = null, end: Long? = null, retrying: Boolean? = null) =
		AutomationLastStep(path, kind, outcome = outcome, startMs = start, endMs = end, retrying = retrying)

	private fun run(at: Long, vararg steps: AutomationLastStep, running: Boolean = false) =
		AutomationLastRun(at, 1L, steps.toList(), running = running)

	private fun FlowGraph.line(from: FlowKey, to: FlowKey, onFailure: Boolean = false): Int =
		lines.indexOfFirst { it.from == from && it.to == to && it.onFailure == onFailure }

	private fun styles(facts: com.atelier_nyaarium.switchboard.assistant.FlowFacts) = Triple(colourOf(facts), patternOf(facts), weightOf(facts))

	@Test
	fun `a shared function is one node, its calls are lines, and a device follows what each automation gives`() {
		val rows = listOf(
			automationRow("mine", "Mine", listOf(point("warm", "plug-a"))),
			automationRow("downstairs", "Downstairs", listOf(point("warm", "plug-b"))),
			automationRow("lost", "Lost", listOf(point("unread", null))),
		)
		val graph = flowGraph(input(rows))
		val shape = graph.lines.map { Triple(it.from, it.to, it.steps) }

		assertEquals(
			listOf(
				Triple(FlowKey.Sensor(SANDBOX_SENSOR), FlowKey.Automation("mine"), mapOf("mine" to emptySet<String>())),
				Triple(FlowKey.Automation("mine"), FlowKey.Function("warm"), mapOf("mine" to setOf("0"))),
				Triple(FlowKey.Function("warm"), FlowKey.Switch("plug-a"), mapOf("mine" to setOf("0.0"))),
				Triple(FlowKey.Function("warm"), FlowKey.Function("blink"), mapOf("mine" to setOf("0.1"), "downstairs" to setOf("0.1"))),
				Triple(FlowKey.Function("blink"), FlowKey.Switch(SANDBOX_SWITCH), mapOf("mine" to setOf("0.1.0"), "downstairs" to setOf("0.1.0"))),
				Triple(FlowKey.Sensor(SANDBOX_SENSOR), FlowKey.Automation("downstairs"), mapOf("downstairs" to emptySet())),
				Triple(FlowKey.Automation("downstairs"), FlowKey.Function("warm"), mapOf("downstairs" to setOf("0"))),
				Triple(FlowKey.Function("warm"), FlowKey.Switch("plug-b"), mapOf("downstairs" to setOf("0.0"))),
				Triple(FlowKey.Sensor(SANDBOX_SENSOR), FlowKey.Automation("lost"), mapOf("lost" to emptySet())),
			),
			shape,
		)
		assertEquals(listOf(FlowNote.Unfollowed("unread", Unfollowed.MISSING)), graph.node(FlowKey.Automation("lost"))?.notes)
		assertEquals("Heater", graph.node(FlowKey.Switch("plug-a"))?.label)
		assertEquals(mapOf("warm" to 0, "blink" to 1), functionDepths(graph))
		val layout = flowLayout(graph, { it.label.length * 7f }, 360f)
		val y = { key: FlowKey -> layout.boxes.getValue(key).center.y }
		assertEquals(
			listOf(true, true, true),
			listOf(
				y(FlowKey.Sensor(SANDBOX_SENSOR)) < y(FlowKey.Automation("mine")),
				y(FlowKey.Function("warm")) < y(FlowKey.Function("blink")),
				y(FlowKey.Function("blink")) < y(FlowKey.Switch(SANDBOX_SWITCH)),
			),
		)
	}

	@Test
	fun `a caught failure is red where it failed only, and an uncaught one is thick where it began and red as far up as it went`() {
		val rows = listOf(
			automationRow("caught", "Caught", listOf(point("guarded", null))).copy(
				lastRun = run(
					10L,
					step("0", "run_function", "ran"),
					step("0.0", "try", "ran"),
					step("0.0.0.0", "device_set", "refused"),
					step("0.0.1.0", "tell_assistant", "ran"),
				),
			),
			automationRow("loose", "Loose", listOf(point("bare", null))).copy(
				lastRun = run(20L, step("0", "run_function", "refused"), step("0.0", "device_set", "refused")),
			),
		)
		val wrapped = automationRow("wrapped", "Wrapped", listOf(point("careful", null))).copy(
			lastRun = run(
				5L,
				step("0", "run_function", "ran"),
				step("0.0", "try", "ran"),
				step("0.0.0.0", "call", "refused"),
				step("0.0.0.0.0", "device_set", "refused"),
				step("0.0.1.0", "tell_assistant", "ran"),
			),
		)
		val graph = flowGraph(input(rows + wrapped))
		val facts = flowFacts(graph, flowRuns(rows + wrapped))
		val lineStyle = { from: FlowKey, to: FlowKey, onFailure: Boolean -> styles(facts.lines[graph.line(from, to, onFailure)]) }
		// A caller's catch handled it: red, never thick.
		val caughtAbove = graph.lines.withIndex().single { (_, line) -> line.from == FlowKey.Function("bare") && "wrapped" in line.steps }.index
		assertEquals(FlowWeight.THIN, weightOf(flowFacts(graph, flowRuns(rows + wrapped), prefer = "wrapped").lines[caughtAbove]))

		assertEquals(Triple(FlowColour.RED, FlowPattern.SOLID, FlowWeight.THIN), lineStyle(FlowKey.Function("guarded"), FlowKey.Switch(SANDBOX_SWITCH), false))
		assertEquals(true, facts.lines[graph.line(FlowKey.Function("guarded"), FlowKey.Assistant, true)].onFailure)
		assertEquals(FlowColour.OK, colourOf(facts.nodes.getValue(FlowKey.Automation("caught"))))
		assertEquals(Triple(FlowColour.RED, FlowPattern.SOLID, FlowWeight.THICK), lineStyle(FlowKey.Function("bare"), FlowKey.Switch(SANDBOX_SWITCH), false))
		assertEquals(Triple(FlowColour.RED, FlowPattern.SOLID, FlowWeight.THIN), lineStyle(FlowKey.Automation("loose"), FlowKey.Function("bare"), false))
		assertEquals(FlowColour.RED, colourOf(facts.nodes.getValue(FlowKey.Automation("loose"))))
		assertEquals(FlowColour.OK, colourOf(facts.lines[graph.line(FlowKey.Sensor(SANDBOX_SENSOR), FlowKey.Automation("loose"))]))
		// The newest act on the lamp is the loose one's.
		assertEquals(FlowColour.RED, colourOf(facts.nodes.getValue(FlowKey.Switch(SANDBOX_SWITCH))))
	}

	@Test
	fun `a step in flight moves, a retry is amber, a switched-off automation is dotted, and one that never ran is faint`() {
		val rows = listOf(
			automationRow("busy", "Busy", listOf(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on"))).copy(
				lastRun = run(5L, step("0", "device_set", null, retrying = true), running = true),
			),
			automationRow("off", "Off", listOf(AutomationAction.DeviceSet("plug-a", "on"))).let {
				it.copy(automation = it.automation.copy(enabled = false), lastRun = run(1L, step("0", "device_set", "ran")))
			},
			automationRow("never", "Never", listOf(AutomationAction.DeviceSet("plug-c", "on"))),
			automationRow("broken", "Broken", listOf(AutomationAction.DeviceSet("plug-d", "on"))).copy(
				invalid = "its plug is gone",
				lastRun = run(2L, step("0", "device_set", "ran")),
			),
		)
		val graph = flowGraph(input(rows))
		val facts = flowFacts(graph, flowRuns(rows))

		assertEquals(
			Triple(FlowColour.AMBER, FlowPattern.MOVING_DASH, FlowWeight.THIN),
			styles(facts.lines[graph.line(FlowKey.Automation("busy"), FlowKey.Switch(SANDBOX_SWITCH))]),
		)
		assertEquals(FlowPattern.MOVING_DASH, patternOf(facts.nodes.getValue(FlowKey.Automation("busy"))))
		assertEquals(
			listOf(FlowPattern.DOTS, FlowPattern.DOTS),
			listOf(
				patternOf(facts.nodes.getValue(FlowKey.Automation("off"))),
				patternOf(facts.lines[graph.line(FlowKey.Automation("off"), FlowKey.Switch("plug-a"))]),
			),
		)
		assertEquals(
			listOf(Triple(FlowColour.FAINT, FlowPattern.DOTS, FlowWeight.THIN), Triple(FlowColour.FAINT, FlowPattern.DOTS, FlowWeight.THIN)),
			listOf(styles(facts.nodes.getValue(FlowKey.Automation("never"))), styles(facts.nodes.getValue(FlowKey.Automation("broken")))),
		)
		assertEquals(listOf(FlowNote.Invalid("its plug is gone")), graph.node(FlowKey.Automation("broken"))?.notes)
	}

	@Test
	fun `a selected automation's lines read its own run, and its reach is its own lines`() {
		val rows = listOf(
			automationRow("mine", "Mine", listOf(point("warm", "plug-a"))).copy(
				lastRun = run(100L, step("0", "run_function", "ran"), step("0.0", "device_set", "ran"), step("0.1", "call", "ran"), step("0.1.0", "device_set", "ran")),
			),
			automationRow("downstairs", "Downstairs", listOf(point("warm", "plug-b"))).copy(
				lastRun = run(
					200L,
					step("0", "run_function", "refused"),
					step("0.0", "device_set", "ran"),
					step("0.1", "call", "refused"),
					step("0.1.0", "device_set", "refused"),
				),
			),
		)
		val graph = flowGraph(input(rows))
		val call = graph.line(FlowKey.Function("warm"), FlowKey.Function("blink"))
		val newest = flowFacts(graph, flowRuns(rows))
		val chosen = flowFacts(graph, flowRuns(rows), prefer = "mine")

		assertEquals(listOf(FlowColour.RED, FlowColour.OK), listOf(colourOf(newest.lines[call]), colourOf(chosen.lines[call])))
		val lamp = FlowKey.Switch(SANDBOX_SWITCH)
		assertEquals(listOf(FlowColour.RED, FlowColour.OK), listOf(colourOf(newest.nodes.getValue(lamp)), colourOf(chosen.nodes.getValue(lamp))))
		assertEquals(
			setOf(FlowKey.Switch("plug-a")),
			flowReach(graph, FlowKey.Automation("mine")).map(FlowLine::to).filterIsInstance<FlowKey.Switch>().filter { it.device.startsWith("plug") }.toSet(),
		)
		assertEquals(true, flowReach(graph, FlowKey.Automation("mine")).none { it.act == FlowAct.ACTS && it.to == FlowKey.Switch("plug-b") })
	}

	@Test
	fun `a thing takes its newest act by step time, and its card names each toucher once`() {
		val rows = listOf(
			automationRow("both", "Both", listOf(AutomationAction.DeviceSet(SANDBOX_SWITCH, "on"), point("bare", null))).copy(
				lastRun = run(
					1L,
					step("0", "device_set", "ran", start = 0, end = 10),
					step("1", "run_function", "refused", start = 20, end = 30),
					step("1.0", "device_set", "refused", start = 20, end = 30),
				),
			),
		)
		val graph = flowGraph(input(rows))
		val facts = flowFacts(graph, flowRuns(rows))
		val lamp = FlowKey.Switch(SANDBOX_SWITCH)

		assertEquals(FlowColour.RED, colourOf(facts.nodes.getValue(lamp)))
		val sheet = flowSheet(graph, facts, rows, lamp) as com.atelier_nyaarium.switchboard.assistant.FlowSheet.OfThing
		assertEquals(listOf("Both", "Bare"), sheet.touches.map { it.label })
	}

	@Test
	fun `a call the walk refused draws no line, and a refresh drops a gone selection and a replaced replay`() {
		val loopy = functionRow("loopy", "Loopy", listOf("spin"), steps = listOf(FunctionStep.Call("loopy")))
		val spin = automationRow("spin", "Spin", listOf(point("loopy", null)))
		val graph = flowGraph(input(listOf(spin)).copy(functions = listOf(loopy)))
		val ran = run(1L, step("0", "run_function", null))
		val refreshed = listOf(spin.copy(lastRun = run(2L, step("0", "run_function", "ran"))))

		assertEquals(emptyList<FlowLine>(), graph.lines.filter { it.act == FlowAct.CALLS })
		assertEquals(listOf(FlowNote.Unfollowed("loopy", Unfollowed.LOOP)), graph.node(FlowKey.Function("loopy"))?.notes)
		assertEquals(
			listOf(null, FlowKey.Automation("spin")),
			listOf(selectionAfter(graph, FlowKey.Automation("gone")), selectionAfter(graph, FlowKey.Automation("spin"))),
		)
		assertEquals(false, replayStands(refreshed, "spin", ran))
		// An ended run's unfinished step is not running.
		val sheet = flowSheet(graph, flowFacts(graph, emptyMap()), listOf(spin.copy(lastRun = ran.copy(running = false))), FlowKey.Automation("spin"))
		assertEquals(listOf(false), (sheet as com.atelier_nyaarium.switchboard.assistant.FlowSheet.OfAutomation).steps.map { it.open })
	}

	@Test
	fun `the legend shows every colour, pattern and weight the map draws`() {
		val shown = com.atelier_nyaarium.switchboard.assistant.FLOW_LEGEND.flatMap { it.rows }.map { it.facts }

		assertEquals(FlowColour.entries.toSet(), shown.map(::colourOf).toSet())
		assertEquals(FlowPattern.entries.toSet(), shown.map(::patternOf).toSet())
		assertEquals(FlowWeight.entries.toSet(), shown.map(::weightOf).toSet())
	}

	@Test
	fun `an automation the lane told alone reads as run at its last-ran time, and its card says when`() {
		val told = automationRow("told", "Told", listOf(AutomationAction.TellAssistant("now"))).copy(lastRanAt = 5_000L)
		val graph = flowGraph(input(listOf(told)))
		val facts = flowFacts(graph, flowRuns(listOf(told)))
		val sheet = flowSheet(graph, facts, listOf(told), FlowKey.Automation("told")) as com.atelier_nyaarium.switchboard.assistant.FlowSheet.OfAutomation

		assertEquals(
			listOf(FlowPattern.SOLID, FlowPattern.SOLID, FlowPattern.SOLID),
			listOf(
				patternOf(facts.nodes.getValue(FlowKey.Automation("told"))),
				patternOf(facts.lines[graph.line(FlowKey.Sensor(SANDBOX_SENSOR), FlowKey.Automation("told"))]),
				patternOf(facts.lines[graph.line(FlowKey.Automation("told"), FlowKey.Assistant)]),
			),
		)
		assertEquals(FlowColour.OK, colourOf(facts.nodes.getValue(FlowKey.Assistant)))
		assertEquals(5_000L, sheet.ranAt)
	}

	@Test
	fun `a replay reads the run at a moment by its times, and a beat a step in written order when it has none`() {
		val timed = run(
			0L,
			step("0", "device_set", "ran", start = 0, end = 0),
			step("1", "wait", "ran", start = 0, end = 300_000),
			step("2", "device_set", "refused", start = 300_000, end = 310_000).copy(retriedMs = 302_000),
		)
		val replay = FlowReplay(timed)
		val opened = { moment: Long -> replay.runAt(moment).steps.map { it.path to it.outcome } }
		val untimed = FlowReplay(run(0L, step("0", "device_set", "ran"), step("1", "device_set", "ran")))

		assertEquals(listOf("0" to null), opened(0))
		assertEquals(listOf("0" to "ran", "1" to null), opened(500))
		// Five minutes plays as one long gap.
		assertEquals(true, replay.length < 6_000)
		assertEquals(timed, replay.runAt(replay.length))
		// Grey while its first attempt is out, amber once one failed.
		val tried = { moment: Long -> replay.runAt(moment).steps.last().let { it.outcome to it.retrying } }
		assertEquals(listOf(null to null, null to true), listOf(tried(2_000), tried(3_500)))
		val held = com.atelier_nyaarium.switchboard.assistant.Replaying.of("warm", timed)
		val ended = held.advanced(replay.length + 1_000)
		assertEquals(
			listOf(replay.length to false, 0L to true, 1_000L to false),
			listOf(ended, ended.toggled(), ended.toggled().scrubbed(1_000)).map { it.moment to it.playing },
		)
		assertEquals(listOf("0" to null), untimed.runAt(500).steps.map { it.path to it.outcome })
		assertEquals(listOf("0" to "ran", "1" to null), untimed.runAt(1_000).steps.map { it.path to it.outcome })
	}
}
