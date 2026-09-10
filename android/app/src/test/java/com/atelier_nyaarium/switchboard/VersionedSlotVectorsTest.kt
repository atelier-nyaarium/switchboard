package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PlaneLineage
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

/** Drives the fold twin through the vectors src/__tests__/versioned-slot.test.ts reads. */
class VersionedSlotVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("versioned-slot/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun lineage(element: kotlinx.serialization.json.JsonElement?): PlaneLineage? =
		element?.takeIf { it !is JsonNull }?.jsonObject?.let {
			PlaneLineage(it["epoch"]!!.jsonPrimitive.long, it["version"]!!.jsonPrimitive.long)
		}

	@Test
	fun theFoldMatchesTheSharedRule() {
		for (case in vectors["cases"]!!.jsonArray) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val held = o["held"]!!.jsonObject
			val expected = o["expected"]!!.jsonObject
			val fold = foldVersionedSlot(
				HeldLineage(lineage(held["lineage"]), held["observed"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.long),
				lineage(o["incoming"])!!,
				o["observedAt"]!!.jsonPrimitive.long,
			)
			val want: SlotFold = when (expected["kind"]!!.jsonPrimitive.content) {
				"take" -> SlotFold.Take(expected["lineageChanged"]!!.jsonPrimitive.content.toBoolean())
				"held" -> SlotFold.Held
				"behind" -> SlotFold.Behind
				else -> error("unknown kind in $name")
			}
			assertEquals(name, want, fold)
		}
	}
}
