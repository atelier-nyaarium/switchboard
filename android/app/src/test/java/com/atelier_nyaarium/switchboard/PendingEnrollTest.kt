package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapFrame
import com.atelier_nyaarium.switchboard.proto.GatewayBootstrapPutResult
import com.atelier_nyaarium.switchboard.proto.SealedEnvelope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A Gateway's unfinished setup: what its card says, and what each drain pass does about it. */
class PendingEnrollTest {
	private val frame = GatewayBootstrapFrame(v = 1L, signerSignPub = "console", sealed = SealedEnvelope("e", "n", "c", "s"))

	private fun rec(id: String = "mikan", heldIncarnation: Long = 0L) =
		PendingEnroll(
			gatewayId = id,
			bundle = wireJson.encodeToString(GatewayBootstrapFrame.serializer(), frame),
			pickupId = bootstrapPickupId("code-$id"),
			gatewaySignPub = "sign-$id",
			heldIncarnation = heldIncarnation,
			at = 1_700_000_000_000,
		)

	private fun roster(vararg entries: GatewayEntry) =
		GatewayRegistry(provenance = RegistryProvenance.Current, gateways = entries.toList())

	private fun entry(id: String = "mikan", connected: Boolean, incarnation: Long) =
		GatewayEntry(id = id, connected = connected, incarnation = incarnation, lastRegisteredAt = 0L)

	private class FakeRouter : EnrollRouter {
		var holds: Boolean? = true
		var answer: GatewayBootstrapPutResult? = GatewayBootstrapPutResult(held = true)
		val reads = mutableListOf<String>()
		val puts = mutableListOf<Pair<String, String>>()

		override suspend fun held(pickupId: String): Boolean? {
			reads += pickupId
			return holds
		}

		override suspend fun put(pickupId: String, gatewaySignPub: String, frame: GatewayBootstrapFrame): GatewayBootstrapPutResult? {
			puts += pickupId to gatewaySignPub
			if (answer?.held == true) holds = true
			return answer
		}
	}

	private class World(stored: Map<String, PendingEnroll> = emptyMap()) {
		var disk: String? = if (stored.isEmpty()) null else encodePendingEnrolls(stored)
		var registry = GatewayRegistry(provenance = RegistryProvenance.Current)
		var now = 0L
		val revoked = mutableSetOf<String>()
		val router = FakeRouter()
		val ops = PendingEnrollOps({ disk }, { disk = it }, router, { registry }, { it !in revoked }, { now })

		fun tick() = runBlocking { ops.tick() }
	}

	@Test
	fun thePickupIdIsWhatTheSharedVectorsPin() {
		val vectors = Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("gateway-bootstrap/vectors.json")!!.bufferedReader().readText(),
		).jsonObject
		val cases = vectors.getValue("cases").jsonArray
		assertTrue(cases.isNotEmpty())
		for (case in cases) {
			val expected = case.jsonObject.getValue("pickupId").jsonPrimitive.content
			assertEquals(expected, bootstrapPickupId(case.jsonObject.getValue("code").jsonPrimitive.content))
		}
		// The code as a Gateway shows it.
		val payload = vectors.getValue("payload").jsonObject
		val shown = gatewayScanOf(payload.getValue("text").jsonPrimitive.content) as GatewayScan.Code
		assertEquals(payload.getValue("pickupId").jsonPrimitive.content, bootstrapPickupId(shown.gateway.code))
	}

	@Test
	fun aPendingCardWaitsUntilTheGatewayRegistersAfterItsAdmission() {
		fun line(registry: GatewayRegistry, pending: PendingEnroll?, sessions: Int = 0) =
			gatewayCardLine(gatewayCardState(sessions, registry, "mikan", pending))

		assertEquals(GATEWAY_PENDING_LINE, line(roster(), rec()))
		assertEquals(GATEWAY_PENDING_LINE, line(roster(entry(connected = false, incarnation = 0)), rec()))
		// A roster still showing the registration held at admission proves nothing.
		assertEquals(GATEWAY_PENDING_LINE, line(roster(entry(connected = true, incarnation = 4)), rec(heldIncarnation = 4), 2))
		// Online with no sessions.
		assertEquals("online · 0 sessions", line(roster(entry(connected = true, incarnation = 1)), rec()))
		assertEquals("online · 1 session", line(roster(entry(connected = true, incarnation = 5)), rec(heldIncarnation = 4), 1))
		assertEquals("offline · 2 sessions", line(roster(entry(connected = false, incarnation = 3)), null, 2))
		assertEquals("offline · 0 sessions", line(roster(), null))
	}

	@Test
	fun aPassHandsInAgainOnlyWhatTheRouterDropped() {
		val world = World(mapOf("mikan" to rec()))
		world.tick()
		assertEquals(listOf(rec().pickupId), world.router.reads)
		assertEquals(0, world.router.puts.size)

		// Not due yet.
		world.router.holds = false
		world.now = ENROLL_CHECK_DELAYS_MS[0] - 1
		world.tick()
		assertEquals(1, world.router.reads.size)

		world.now = ENROLL_CHECK_DELAYS_MS[0]
		world.tick()
		assertEquals(listOf(rec().pickupId to "sign-mikan"), world.router.puts)

		// No answer is not a drop.
		world.router.holds = null
		world.now += ENROLL_CHECK_DELAYS_MS[1]
		world.tick()
		assertEquals(3, world.router.reads.size)
		assertEquals(1, world.router.puts.size)

		// A refused hand-in keeps the record, and the next pass tries again.
		world.router.holds = false
		world.router.answer = GatewayBootstrapPutResult(held = false, refusal = "too_many")
		repeat(2) {
			world.now += ENROLL_CHECK_DELAYS_MS.last()
			world.tick()
		}
		assertEquals(3, world.router.puts.size)
		assertEquals(setOf("mikan"), world.ops.pending.value.keys)
	}

	@Test
	fun thePassBacksOffToItsLastDelay() {
		val world = World(mapOf("mikan" to rec()))
		val readAt = mutableListOf<Long>()
		while (readAt.size < ENROLL_CHECK_DELAYS_MS.size + 2) {
			val before = world.router.reads.size
			world.tick()
			if (world.router.reads.size > before) readAt += world.now
			world.now += 1_000
		}
		assertEquals(ENROLL_CHECK_DELAYS_MS + ENROLL_CHECK_DELAYS_MS.last(), readAt.zipWithNext { a, b -> b - a })
	}

	@Test
	fun aRegistrationRetiresTheRecordOnDiskAndAsksNothing() {
		val world = World(mapOf("mikan" to rec(), "yuzu" to rec("yuzu", heldIncarnation = 3)))
		// Yuzu still shows the registration it held when admitted.
		world.registry = roster(entry(connected = true, incarnation = 1), entry("yuzu", connected = true, incarnation = 3))
		world.tick()
		assertEquals(setOf("yuzu"), world.ops.pending.value.keys)
		assertEquals(setOf("yuzu"), decodePendingEnrolls(world.disk).keys)
		assertEquals(listOf(rec("yuzu").pickupId), world.router.reads)

		world.registry = roster(entry("yuzu", connected = true, incarnation = 4))
		world.tick()
		assertEquals(emptySet<String>(), decodePendingEnrolls(world.disk).keys)
	}

	@Test
	fun aRevokedGatewaysRecordRetiresWithoutAsking() {
		val world = World(mapOf("mikan" to rec(), "yuzu" to rec("yuzu")))
		world.revoked += "sign-mikan"
		world.tick()
		assertEquals(setOf("yuzu"), decodePendingEnrolls(world.disk).keys)
		assertEquals(listOf(rec("yuzu").pickupId), world.router.reads)
	}

	@Test
	fun aCorruptOrAbsentBlobReadsAsEmpty() {
		// The last is a record with no pickup id, which cannot be handed in.
		val unfit = "{\"mikan\":{\"gatewayId\":\"mikan\",\"bundle\":\"x\",\"lanHost\":\"192.168.1.5\"}}"
		for (text in listOf(null, "", "{ this is not json", "[1,2,3]", unfit)) {
			assertEquals(emptyMap<String, PendingEnroll>(), decodePendingEnrolls(text))
		}
		val map = mapOf("mikan" to rec(), "yuzu" to rec("yuzu", heldIncarnation = 7))
		assertEquals(map, decodePendingEnrolls(encodePendingEnrolls(map)))
	}

	@Test
	fun aScanIsACodeAnOlderMachinesCodeOrNeither() {
		val fields = "\"gatewayId\":\"mikan\",\"signPub\":\"c2lnbg==\",\"boxPub\":\"Ym94\""
		val code = gatewayScanOf("  {\"type\":\"enroll-gateway\",$fields,\"code\":\"abc\"}\n") as GatewayScan.Code
		assertEquals("mikan", code.gateway.gatewayId)
		assertEquals("abc", code.gateway.code)
		assertEquals(GatewayScan.Outdated, gatewayScanOf("{\"type\":\"admit-gateway\",$fields}"))
		// A code with no one-time code cannot be answered.
		assertEquals(GatewayScan.NotACode, gatewayScanOf("{\"type\":\"enroll-gateway\",$fields}"))
		assertEquals(GatewayScan.NotACode, gatewayScanOf("{\"type\":\"enroll-owner\"}"))
		assertEquals(GatewayScan.NotACode, gatewayScanOf("not json"))
	}
}
