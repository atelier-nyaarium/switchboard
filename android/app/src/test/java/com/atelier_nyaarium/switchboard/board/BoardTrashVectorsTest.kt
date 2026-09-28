package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

/** Drives the twins through the vectors src/__tests__/board-structure.test.ts reads. */
class BoardTrashVectorsTest {
	private val cases =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("board-trash/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["cases"]!!.jsonArray

	@Test
	fun theTwinsMatchTheSharedRule() {
		for (case in cases) {
			val o = case.jsonObject
			val byId = o["entries"]!!.jsonArray.associate { raw ->
				val e = raw.jsonObject
				val id = e["id"]!!.jsonPrimitive.content
				id to BoardEntry(
					id = id,
					title = id,
					state = "open",
					parent = e["parent"]?.jsonPrimitive?.content,
					rank = id,
					trashedAt = e["trashedAt"]?.jsonPrimitive?.long,
				)
			}
			val id = o["id"]!!.jsonPrimitive.content
			val taken = if (o["op"]!!.jsonPrimitive.content == "trash") trashTakes(byId, id) else restoreBrings(byId, id)
			assertEquals(
				o["name"]!!.jsonPrimitive.content,
				o["expected"]!!.jsonArray.map { it.jsonPrimitive.content },
				taken.sorted(),
			)
		}
	}
}
