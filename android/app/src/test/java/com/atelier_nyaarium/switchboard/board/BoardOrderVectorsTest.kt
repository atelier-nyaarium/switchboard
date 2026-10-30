package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

/** Drives BoardOrder through the vectors src/__tests__/board-order.test.ts reads. */
class BoardOrderVectorsTest {
	private val cases =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("board-order/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["cases"]!!.jsonArray

	private fun rows(raw: JsonArray): LinkedHashMap<String, BoardEntry> =
		raw.associateTo(LinkedHashMap()) { element ->
			val e = element.jsonObject
			val id = e["id"]!!.jsonPrimitive.content
			id to BoardEntry(
				id = id,
				title = id,
				state = "open",
				parent = e["parent"]?.jsonPrimitive?.content,
				rank = e["rank"]!!.jsonPrimitive.long,
				trashedAt = e["trashedAt"]?.jsonPrimitive?.long,
			)
		}

	private fun strings(o: JsonObject, key: String) = o[key]!!.jsonArray.map { it.jsonPrimitive.content }

	@Test
	fun theTwinMatchesTheSharedRule() {
		for (case in cases) {
			val o = case.jsonObject
			val name = o["name"]!!.jsonPrimitive.content
			val entries = rows(o["entries"]!!.jsonArray)
			val op = o["op"]!!.jsonObject
			val id = op["id"]?.jsonPrimitive?.content
			val parent = op["parent"]?.jsonPrimitive?.content
			when (op["kind"]!!.jsonPrimitive.content) {
				"end" -> {
					assertEquals(name, o["rank"]!!.jsonPrimitive.long, BoardOrder.endRank(entries.values, parent))
					continue
				}
				"place" -> BoardOrder.placeAt(entries, id!!, parent, op["index"]?.jsonPrimitive?.int)
				"renumber" -> assertEquals(name, strings(o, "moved"), BoardOrder.renumber(entries).sorted())
				"restore" -> assertEquals(name, strings(o, "brought"), BoardOrder.restoreAtEnd(entries, id!!))
			}
			assertEquals(name, rows(o["expected"]!!.jsonArray).values.toList(), entries.values.toList())
		}
	}
}
