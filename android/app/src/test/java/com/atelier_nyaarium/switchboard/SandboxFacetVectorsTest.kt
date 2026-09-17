package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeCounts
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The corpus the plugin writes from its own drill-in builders, answered here by the sandbox rules.
 * A rule that holds on one side and not the other fails the vector that names it.
 */
class SandboxFacetVectorsTest {
	private val cases =
		Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("workspace-facets/vectors.json")!!.bufferedReader().readText(),
		).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }

	/** Every vector is reported, or the first mismatch hides which other rules also broke. */
	@Test
	fun `every vector answers what the plugin answered`() {
		assertTrue(cases.size >= 7)
		val broken = cases.filter { answerOf(it) != it["answer"]!!.jsonObject }.map { it.text("name") }

		assertEquals(emptyList<String>(), broken)
		for (case in cases) assertEquals(case.text("name"), case["answer"]!!.jsonObject, answerOf(case))
	}

	private fun answerOf(case: JsonObject): JsonObject {
		val declared = case.rows("symbols").associate { it.text("id") to symbolOf(it) }
		val symbols = FacetSymbols { declared[it] }
		val subject = declared[case.text("subject")]!!

		val uses = sandboxUsesAnswer(case.rows("uses").map(::useSiteOf), symbols)
		val targets = sandboxTargetsAnswer(case.rows("targets").map(::targetSiteOf), symbols)
		val members = sandboxMembers(case.names("members"), symbols)
		val hierarchy = hierarchyOf(case, subject, symbols)
		val comments = commentsOf(case, subject, symbols)

		return buildJsonObject {
			put("uses", buildJsonObject {
				put("rows", buildJsonArray { for (row in uses.rows) add(rowOf(row)) })
				put("uses", uses.uses)
				put("plain", uses.plain)
			})
			put("usesFrom", buildJsonObject {
				put("targets", buildJsonArray { for (target in targets.targets) add(targetOf(target)) })
				put("targetCount", targets.targetCount)
				put("references", targets.references)
				put("plain", targets.plain)
			})
			put("members", buildJsonObject {
				put("members", buildJsonArray { for (member in members) add(member.symbolId) })
			})
			put("hierarchy", hierarchyJsonOf(hierarchy))
			put("comments", commentsJsonOf(comments))
			put("counts", countsOf(sandboxCounts(uses.rows, targets.targets, members, hierarchy, comments)))
		}
	}

	////////////////////////////////
	//  The case's rows

	private fun symbolOf(row: JsonObject) = WorkspaceFacetSymbol(
		symbolId = row.text("id"),
		name = row.text("name"),
		symbolKind = row.text("kind"),
		module = row.text("module"),
		startLine = row.number("startLine"),
		endLine = row.number("endLine"),
		signature = row.textOrNull("signature"),
	)

	private fun useSiteOf(row: JsonObject) = FacetUseSite(
		module = row.text("module"),
		line = row.number("line"),
		name = row.text("name"),
		role = row.text("role"),
		holderId = row.textOrNull("holder"),
		topLevelId = row.textOrNull("topLevel"),
	)

	private fun targetSiteOf(row: JsonObject) = FacetTargetSite(
		use = useSiteOf(row),
		name = row.text("name"),
		status = row.text("status"),
		targetId = row.textOrNull("target"),
		reason = row.textOrNull("reason"),
	)

	private fun hierarchyOf(
		case: JsonObject,
		subject: WorkspaceFacetSymbol,
		symbols: FacetSymbols,
	): WorkspaceFacetAnswer.Hierarchy {
		val held = case["hierarchy"] as? JsonObject
		val above = held?.rows("supertypes").orEmpty()
		return sandboxHierarchy(
			subject = subject,
			supertypes = above.filter { it["symbol"] != null }.map { FacetTypeSite(it.text("symbol"), it.textOrNull("role")) },
			ancestorIds = held?.names("ancestors").orEmpty(),
			unbound = above.filter { it["symbol"] == null }.map { FacetUnboundSite(it.text("name"), it.textOrNull("role")) },
			subtypes = held?.rows("subtypes").orEmpty().map { FacetTypeSite(it.text("symbol"), it.textOrNull("role")) },
			symbols = symbols,
		)
	}

	/** The index's anchor is what both sides resolve a holder from. */
	private fun commentsOf(
		case: JsonObject,
		subject: WorkspaceFacetSymbol,
		symbols: FacetSymbols,
	): WorkspaceFacetAnswer.Comments {
		val sites = case.rows("comments").map { row ->
			FacetCommentSite(
				text = row.text("text"),
				form = row.text("form"),
				line = row.number("line"),
				anchorId = row.textOrNull("anchor"),
				holderId = row.textOrNull("anchor"),
			)
		}
		return sandboxComments(
			subjectId = subject.symbolId,
			sites = sites,
			total = case["commentTotal"]?.jsonPrimitive?.long ?: sites.size.toLong(),
			sourceTruncated = case["commentTruncated"]?.jsonPrimitive?.boolean ?: false,
			symbols = symbols,
		)
	}

	////////////////////////////////
	//  Back to the corpus's form

	private fun rowOf(use: WorkspaceFacetUse) = buildJsonObject {
		put("module", use.module)
		put("line", use.line)
		put("name", use.name)
		put("role", use.role)
		put("holder", use.holder?.symbolId)
		put("topLevel", use.topLevel?.symbolId)
	}

	private fun targetOf(target: WorkspaceFacetTarget) = buildJsonObject {
		put("name", target.name)
		put("status", target.status)
		put("target", target.target?.symbolId)
		put("reason", target.reason)
		put("uses", buildJsonArray { for (use in target.uses) add(rowOf(use)) })
	}

	private fun hierarchyJsonOf(hierarchy: WorkspaceFacetAnswer.Hierarchy) = buildJsonObject {
		put("subject", hierarchy.subject.symbolId)
		put("supertypes", buildJsonArray {
			for (type in hierarchy.supertypes) {
				add(buildJsonObject {
					put("symbol", type.symbol.symbolId)
					put("role", type.role)
				})
			}
		})
		put("ancestors", buildJsonArray { for (symbol in hierarchy.ancestors) add(symbol.symbolId) })
		put("unbound", buildJsonArray {
			for (type in hierarchy.unbound) {
				add(buildJsonObject {
					put("name", type.name)
					put("role", type.role)
				})
			}
		})
		put("subtypes", buildJsonArray {
			for (type in hierarchy.subtypes) {
				add(buildJsonObject {
					put("symbol", type.symbol.symbolId)
					put("role", type.role)
				})
			}
		})
		put("supertypeCount", hierarchy.supertypeCount)
		put("subtypeCount", hierarchy.subtypeCount)
	}

	private fun commentsJsonOf(comments: WorkspaceFacetAnswer.Comments) = buildJsonObject {
		put("comments", buildJsonArray {
			for (comment in comments.comments) {
				add(buildJsonObject {
					put("text", comment.text)
					put("form", comment.form)
					put("line", comment.line)
					put("holder", comment.holder?.symbolId)
				})
			}
		})
		put("total", comments.total)
		put("truncated", comments.truncated ?: false)
	}

	private fun countsOf(counts: WorkspaceKnowledgeCounts) = buildJsonObject {
		put("uses", counts.uses)
		put("useFiles", counts.useFiles)
		put("dependents", counts.dependents)
		put("dependentFiles", counts.dependentFiles)
		put("targets", counts.targets)
		put("boundTargets", counts.boundTargets)
		put("references", counts.references)
		put("members", counts.members)
		put("supertypes", counts.supertypes)
		put("subtypes", counts.subtypes)
		put("comments", counts.comments)
	}
}

////////////////////////////////
//  Reading the corpus

private fun JsonObject.text(key: String): String = this[key]!!.jsonPrimitive.content

private fun JsonObject.textOrNull(key: String): String? =
	this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

private fun JsonObject.number(key: String): Long = this[key]!!.jsonPrimitive.long

private fun JsonObject.rows(key: String): List<JsonObject> =
	(this[key] as? JsonArray)?.map { it.jsonObject } ?: emptyList()

private fun JsonObject.names(key: String): List<String> =
	(this[key] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
