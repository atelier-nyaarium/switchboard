package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.SessionKey
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.composeSessionName
import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import com.atelier_nyaarium.switchboard.proto.parseStoreKey
import com.atelier_nyaarium.switchboard.proto.storeKey
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drives the hand-authored address twin (Address / SpawnPoint / parseQualifiedTarget / SessionKey /
 * storeKey) through the same vectors the vitest suite reads (tests/fixtures/session-id/vectors.json),
 * so the twin cannot drift from the TS source: a differing canonical string fails one of the two
 * runtimes.
 */
class SessionIdVectorsTest {
	private val json = Json { ignoreUnknownKeys = true }

	private fun vectors() =
		json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("session-id/vectors.json")!!.bufferedReader().readText(),
		).jsonObject

	@Test
	fun addressVectors() {
		for (v in vectors()["address"]!!.jsonArray) {
			val o = v.jsonObject
			val domain = o["domain"]!!.jsonPrimitive.content
			val gateway = o["gateway"]!!.jsonPrimitive.content
			val spawn = o["spawn"]!!.jsonPrimitive.content
			val session = o["session"]!!.jsonPrimitive.content
			val a = Address.of(domain, gateway, spawn, session)
			assertEquals(o["canonical"]!!.jsonPrimitive.content, a.canonical)
			assertEquals(o["spawnPointCanonical"]!!.jsonPrimitive.content, a.spawnPoint.canonical)
			// SpawnPoint.of produces the same arity-3 canonical.
			assertEquals(o["spawnPointCanonical"]!!.jsonPrimitive.content, SpawnPoint.of(domain, gateway, spawn).canonical)
		}
	}

	/** The phone's contract has no local forms to fill. */
	@Test
	fun parseQualifiedTargetVectors() {
		for (v in vectors()["parseQualifiedTarget"]!!.jsonArray) {
			val o = v.jsonObject
			val input = o["input"]!!.jsonPrimitive.content
			val t = parseQualifiedTarget(input)
			assertEquals(input, o["kind"]!!.jsonPrimitive.content, if (t is Address) "address" else "spawn")
			assertEquals(input, o["canonical"]!!.jsonPrimitive.content, t.canonical)
		}
		for (s in vectors()["parseQualifiedTargetReject"]!!.jsonArray) {
			val str = s.jsonPrimitive.content
			assertThrows(str, IllegalArgumentException::class.java) { parseQualifiedTarget(str) }
		}
	}

	@Test
	fun storeKeyVectors() {
		for (v in vectors()["storeKey"]!!.jsonArray) {
			val o = v.jsonObject
			val kind = o["kind"]!!.jsonPrimitive.content
			val domain = o["domain"]!!.jsonPrimitive.content
			val gateway = o["gateway"]!!.jsonPrimitive.content
			val spawn = o["spawn"]!!.jsonPrimitive.content
			val session = o["session"]!!.jsonPrimitive.content
			val expectedKey = o["key"]!!.jsonPrimitive.content
			val addr = Address.of(domain, gateway, spawn, session)
			val key = when (kind) {
				"conv" -> SessionKey.Conv(o["conversationId"]!!.jsonPrimitive.content, addr)
				"notice" -> SessionKey.Notice(addr)
				else -> error("unknown store-key kind $kind")
			}
			assertEquals(expectedKey, storeKey(key))
			// Round-trip: parseStoreKey is the inverse of storeKey.
			assertEquals(key, parseStoreKey(expectedKey))
		}
	}

	@Test
	fun parseStoreKeyRejects() {
		for (s in vectors()["parseStoreKeyReject"]!!.jsonArray) {
			val str = s.jsonPrimitive.content
			assertNull(str, parseStoreKey(str))
		}
	}

	@Test
	fun crossGatewayStoreKeyIsByteStable() {
		// A fully-qualified address store key is byte-stable regardless of any local gateway/domain,
		// since parseStoreKey reads the embedded domain + gateway, never a local default.
		val wire = "conv.c.dom.gwb.api.claude"
		val parsed = parseStoreKey(wire)
		assertTrue(parsed is SessionKey.Conv)
		assertEquals(wire, storeKey(parsed!!))
	}

	@Test
	fun sessionNameVectors() {
		for (v in vectors()["sessionName"]!!.jsonArray) {
			val o = v.jsonObject
			val input = o["input"]!!.jsonPrimitive.content
			val parsed = parseSessionName(input)
			assertEquals(input, o["project"]!!.jsonPrimitive.content, parsed.project)
			assertEquals(input, o["session"]!!.jsonPrimitive.content, parsed.session)
			assertEquals(input, o["composite"]!!.jsonPrimitive.boolean, isComposite(input))
			assertEquals(
				input,
				o["composed"]!!.jsonPrimitive.content,
				composeSessionName(o["project"]!!.jsonPrimitive.content, o["session"]!!.jsonPrimitive.content),
			)
		}
	}

	@Test
	fun equalsAndHashCodeContract() {
		// SessionKey values become map keys (the thread store, the idempotency cache); equal values
		// must hash equal regardless of how they were built (constructed vs parsed).
		val a = Address.of("dom", "gwb", "api", "claude")
		val b = parseStoreKey("conv.c.dom.gwb.api.claude") as SessionKey.Conv
		assertEquals(SessionKey.Conv("c", a), b)
		assertEquals(SessionKey.Conv("c", a).hashCode().toLong(), b.hashCode().toLong())
		// Address equality is by value, independent of construction path.
		assertEquals(a, parseQualifiedTarget("dom.gwb.api.claude"))
	}
}
