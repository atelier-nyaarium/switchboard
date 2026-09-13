package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutation
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileMutationAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileStateAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceTreeAnswer
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every key an expectation may name; any other is a typo nothing would check. */
private val EXPECT_KEYS = setOf("refused", "state", "outcome", "path", "hash", "identity", "gone", "names")

/** Drives `WorkspaceFileTable` through the vectors src/__tests__/workspace-file-ops-vectors.test.ts runs on the plugin. */
class WorkspaceFileTableVectorsTest {
	private val vectors =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("workspace-file-ops/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	private fun sha256(text: String) =
		MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

	@Test
	fun theTableAnswersAsThePluginDoes() {
		val cases = vectors["cases"]!!.jsonArray
		assertTrue(cases.isNotEmpty())
		for (case in cases) {
			val vector = case.jsonObject
			val name = vector["name"]!!.jsonPrimitive.content
			val table = WorkspaceFileTable(
				folders = vector["folders"]!!.jsonArray.map { it.jsonPrimitive.content },
				files = vector["files"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content },
			)
			val bound = mutableMapOf<String, Pair<String?, String?>>()

			fun resolve(element: JsonElement): JsonElement =
				when (element) {
					is JsonPrimitive -> {
						val text = if (element.isString) element.content else null
						when {
							text == null -> element
							text.startsWith("sha256:") -> JsonPrimitive(sha256(text.removePrefix("sha256:")))
							text.startsWith("#") -> JsonPrimitive(bound[text.drop(1)]?.first)
							text.startsWith("@") -> JsonPrimitive(bound[text.drop(1)]?.second)
							else -> element
						}
					}
					is JsonArray -> JsonArray(element.map(::resolve))
					is JsonObject -> JsonObject(element.mapValues { resolve(it.value) })
				}

			for ((index, stepElement) in vector["steps"]!!.jsonArray.withIndex()) {
				val step = stepElement.jsonObject
				val at = "$name, step $index"
				when {
					"bind" in step -> {
						val state = (table.state(step["path"]!!.jsonPrimitive.content) as WorkspaceAnswer.Read).value
						bound[step["bind"]!!.jsonPrimitive.content] = state.hash to state.identity
					}
					"put" in step -> table.put(step["put"]!!.jsonPrimitive.content, step["text"]!!.jsonPrimitive.content)
					"edit" in step -> table.edit(step["edit"]!!.jsonPrimitive.content, step["text"]!!.jsonPrimitive.content)
					"remove" in step -> table.remove(step["remove"]!!.jsonPrimitive.content)
					else -> {
						val op = resolve(step["op"]!!).jsonObject
						val expected = resolve(step["expect"]!!).jsonObject
						val unknown = expected.keys - EXPECT_KEYS
						assertTrue("$at: expect names $unknown, which nothing checks", unknown.isEmpty())
						assertTrue("$at: expect names no result", listOf("refused", "state", "outcome", "names").any { it in expected })
						val answer: WorkspaceAnswer<Any> = when (op["kind"]!!.jsonPrimitive.content) {
							"tree" -> table.tree(op["path"]!!.jsonPrimitive.content)
							"fileState" -> table.state(op["path"]!!.jsonPrimitive.content)
							"mutateFile" -> table.mutate(wireJson.decodeFromJsonElement<WorkspaceFileMutation>(op["mutation"]!!))
							else -> error("$at: an op this runner does not drive")
						}
						if (expected["refused"]?.jsonPrimitive?.booleanOrNull == true) {
							assertTrue("$at: refused, got $answer", answer is WorkspaceAnswer.Refused)
							continue
						}
						val value = (answer as? WorkspaceAnswer.Read)?.value ?: error("$at: answered, got $answer")
						val fields: Map<String, String?> = when (value) {
							is WorkspaceFileStateAnswer ->
								mapOf("state" to value.state, "path" to value.path, "hash" to value.hash, "identity" to value.identity)
							is WorkspaceFileMutationAnswer -> mapOf("outcome" to value.outcome, "path" to value.path, "hash" to value.hash)
							is WorkspaceTreeAnswer -> mapOf("path" to value.path)
							else -> error("$at: an answer this runner does not read")
						}
						expected["names"]?.let { names ->
							assertEquals(
								"$at names",
								names.jsonArray.map { it.jsonPrimitive.content },
								(value as WorkspaceTreeAnswer).entries.map { it.name },
							)
						}
						for (key in listOf("state", "outcome", "path", "hash", "identity")) {
							expected[key]?.let { assertEquals("$at $key", it.jsonPrimitive.content, fields[key]) }
						}
						if (value is WorkspaceFileMutationAnswer) {
							assertEquals("$at gone", expected["gone"]?.jsonPrimitive?.booleanOrNull == true, value.gone == true)
						}
					}
				}
			}
			assertEquals(name, vector["after"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }, table.files())
		}
	}
}
