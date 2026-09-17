package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceListingTest {
	private fun fixture(name: String) =
		wireJson.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("protocol/$name")!!.bufferedReader().use { it.readText() },
		)

	@Test
	fun aListingDecodesAsItsAnswerAndAnOversizedOneAsItsCount() {
		val listed = listingOf(fixture("workspace-symbol-facet-answer.json"), WorkspaceSymbolFacetAnswer.serializer())
		assertTrue((listed as WorkspaceListing.Listed).value.facet is WorkspaceFacetAnswer.Uses)

		val over = listingOf(fixture("workspace-too-large-answer.json"), WorkspaceSymbolFacetAnswer.serializer())
		assertEquals(WorkspaceListing.TooLarge(rows = 48213, bytes = 4213377), over)
	}

	@Test
	fun anAnswerThisBuildCannotReadIsNeither() {
		val foreign = buildJsonObject { put("kind", "symbolFacet"); put("facet", "callers") }
		assertNull(listingOf(foreign, WorkspaceSymbolFacetAnswer.serializer()))
		assertNull(listingOf(JsonPrimitive(3), WorkspaceSymbolFacetAnswer.serializer()))
	}
}
