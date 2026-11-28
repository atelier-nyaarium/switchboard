package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.CarryRefusal
import com.atelier_nyaarium.switchboard.assistant.FunctionsServed
import com.atelier_nyaarium.switchboard.assistant.carriedFunctionsOf
import com.atelier_nyaarium.switchboard.assistant.carryRefusal
import com.atelier_nyaarium.switchboard.assistant.conditionOf
import com.atelier_nyaarium.switchboard.assistant.sealedRefusal
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationConditionServes
import com.atelier_nyaarium.switchboard.proto.ContentEnvelope
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.util.Base64
import com.atelier_nyaarium.switchboard.proto.AssistantHomeCarried
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionServes
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.CarriedAutomation
import com.atelier_nyaarium.switchboard.proto.CarriedFunction
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FunctionCarryTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("automation-carry/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun aMoveCarriesWhatTheGatewaysPickCarries() {
		val cases = vectors["pick"]!!.jsonArray
		assertEquals(true, cases.isNotEmpty())
		for (case in cases) {
			val o = case.jsonObject
			val automations = o["automations"]!!.jsonArray.map { wireJson.decodeFromJsonElement(CarriedAutomation.serializer(), it) }
			val listed = o["listed"]!!.jsonArray.map { wireJson.decodeFromJsonElement(CarriedFunction.serializer(), it) }
			val expected = o["expect"]!!.jsonArray.map { it.jsonPrimitive.content }

			assertEquals(o["name"]!!.jsonPrimitive.content, expected, carriedFunctionsOf(automations, listed).map { it.id })
		}
	}

	@Test
	fun aDestinationMustHoldFunctionsAndEveryCarriedStepKind() {
		val tell = FunctionStep.Action(action = "tell_assistant", args = JsonObject(emptyMap()))
		val chime = CarriedFunction("chime", AutomationFunction("Chime", emptyList(), listOf(tell)))
		val later = CarriedFunction("later", AutomationFunction("Later", emptyList(), listOf(FunctionStep.Unknown("wait", JsonObject(emptyMap())))))
		val serves = AutomationFunctionServes(max = 32L, steps = listOf("tell_assistant", "device_set"), paramTypes = listOf("device", "text", "number"))

		fun carrying(functions: List<CarriedFunction>, automations: List<CarriedAutomation>? = null) =
			AssistantHomeCarried(approveEverySend = false, watchers = emptyList(), automations = automations, functions = functions)

		assertNull(carryRefusal(carrying(emptyList()), FunctionsServed.None))
		assertNull(carryRefusal(null, FunctionsServed.Reading))
		assertEquals(CarryRefusal.NoFunctions, carryRefusal(carrying(listOf(chime)), FunctionsServed.None))
		// Unread is never none.
		assertEquals(CarryRefusal.Reading, carryRefusal(carrying(listOf(chime)), FunctionsServed.Reading))
		assertEquals(CarryRefusal.Unreachable, carryRefusal(carrying(listOf(chime)), FunctionsServed.Unreachable))
		assertNull(carryRefusal(carrying(listOf(chime)), FunctionsServed.Serves(serves)))
		assertEquals(CarryRefusal.StepNotServed("wait"), carryRefusal(carrying(listOf(chime, later)), FunctionsServed.Serves(serves)))
		// Its function left behind.
		val pointing = CarriedAutomation("wake", Automation(enabled = true, trigger = AutomationTrigger.Event("github", emptyList()), actions = listOf(AutomationAction.RunFunction(function = "unread"))))
		assertEquals(CarryRefusal.NoFunctions, carryRefusal(carrying(emptyList(), listOf(pointing)), FunctionsServed.None))
		assertNull(carryRefusal(carrying(emptyList(), listOf(pointing)), FunctionsServed.Serves(serves)))
	}

	@Test
	fun aDestinationMustHoldAConditionsValuesAndTest() {
		val functions = AutomationFunctionServes(max = 32L, steps = listOf("tell_assistant"), paramTypes = listOf("text"))
		val served = AutomationConditionServes(listOf("is", "is_not", "contains", "contains_not"), 16L)
		fun wake(vararg conditions: AutomationCondition) = AssistantHomeCarried(
			approveEverySend = false,
			watchers = emptyList(),
			automations = listOf(CarriedAutomation("wake", Automation(enabled = true, trigger = AutomationTrigger.Event("github", conditions.toList()), actions = listOf(AutomationAction.TellAssistant("now"))))),
		)
		val plain = wake(conditionOf("reason", "is", listOf("mention")))
		val listed = wake(conditionOf("reason", "is", listOf("mention", "subscribed")))
		val unlike = wake(conditionOf("repository", "contains_not", listOf("fork")))

		assertNull(carryRefusal(plain, FunctionsServed.None))
		assertEquals(listOf(CarryRefusal.ConditionsNotServed, CarryRefusal.ConditionsNotServed), listOf(listed, unlike).map { carryRefusal(it, FunctionsServed.None) })
		assertEquals(CarryRefusal.ConditionsNotServed, carryRefusal(listed, FunctionsServed.Serves(functions)))
		assertEquals(CarryRefusal.Reading, carryRefusal(unlike, FunctionsServed.Reading))
		assertEquals(listOf(null, null), listOf(listed, unlike).map { carryRefusal(it, FunctionsServed.Serves(functions, served)) })
		assertEquals(CarryRefusal.ConditionsNotServed, carryRefusal(listed, FunctionsServed.Serves(functions, served.copy(values = 1L))))
	}

	@Test
	fun aTreeIsReadAtEveryDepthActionsByStepsStatementsByStatementsAndNoNameByUnnamed() {
		val tell = FunctionStep.Action(action = "tell_assistant", args = JsonObject(emptyMap()))
		val ifttt = FunctionStep.Action(action = "ifttt_trigger", args = JsonObject(emptyMap()))
		fun tree(name: String, inside: FunctionStep) =
			CarriedFunction(name.ifBlank { "own" }, AutomationFunction(name, emptyList(), listOf(FunctionStep.If(condition = "true", steps = listOf(inside)))))
		val serves = AutomationFunctionServes(
			max = 32L,
			steps = listOf("tell_assistant", "device_set"),
			paramTypes = listOf("device", "text", "number"),
			statements = listOf("do", "if"),
			unnamed = true,
		)
		fun refusal(function: CarriedFunction, held: AutomationFunctionServes = serves) =
			carryRefusal(AssistantHomeCarried(approveEverySend = false, watchers = emptyList(), functions = listOf(function)), FunctionsServed.Serves(held))

		assertNull(refusal(tree("Warm", tell)))
		assertEquals(CarryRefusal.StepNotServed("ifttt_trigger"), refusal(tree("Warm", ifttt)))
		assertEquals(CarryRefusal.StepNotServed("if"), refusal(tree("Warm", tell), serves.copy(statements = null)))
		assertEquals(CarryRefusal.UnnamedNotServed, refusal(tree("", tell), serves.copy(unnamed = null)))
		assertNull(refusal(tree("", tell)))
	}

	@Test
	fun aSealedHomePastTheRoutersBoundIsRefusedBeforeItIsSent() {
		fun sealedOf(bytes: Int) = ContentEnvelope(1L, 1L, "nonce", Base64.getEncoder().encodeToString(ByteArray(bytes)))
		val max = Protocol.Wire.ASSISTANT_HOME_SEALED_MAX_BYTES

		assertNull(sealedRefusal(sealedOf(max)))
		assertNull(sealedRefusal(sealedOf(max - 1)))
		assertEquals(CarryRefusal.TooLarge, sealedRefusal(sealedOf(max + 1)))
	}
}
