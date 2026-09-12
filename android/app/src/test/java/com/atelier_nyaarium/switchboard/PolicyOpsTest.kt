package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyPutResult
import com.atelier_nyaarium.switchboard.proto.PolicyBinding
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

private fun policy(
	id: String,
	name: String = id,
	revision: Long = 1L,
	enabled: Boolean = true,
	examples: List<String> = listOf("sudo $id"),
) = AuthorizationPolicy(
	id = id,
	name = name,
	binding = PolicyBinding(entryId = "deploy"),
	selectorKeys = examples,
	enabled = enabled,
	revision = revision,
)

/** The gateway's key rule, as far as a test needs it. */
private fun keyOf(example: String) = example.trim().split(Regex("\\s+")).take(2).joinToString(" ")

class PolicyOpsTest {
	/** Answers per gateway; a gateway in `refusing` throws, as an older build's unknown op does. */
	private class FakeGateway : PolicyGateway {
		val shelves = mutableMapOf<String, List<AuthorizationPolicy>>()
		val refusing = mutableSetOf<String>()
		val unreachable = mutableSetOf<String>()
		val staleIds = mutableSetOf<String>()
		val puts = mutableListOf<Pair<String, Long?>>()
		/** The next list, or the next enable, of that gateway waits here once. */
		val holds = mutableMapOf<String, TestHold>()
		val enableHolds = mutableMapOf<String, TestHold>()

		override suspend fun list(gatewayId: String): PolicyListAnswer {
			// Read before the hold, so a held answer is the older one.
			val listed = shelves[gatewayId].orEmpty()
			holds.remove(gatewayId)?.pass()
			if (gatewayId in refusing) return PolicyListAnswer.Refused
			if (gatewayId in unreachable) throw IllegalStateException("timed out")
			return PolicyListAnswer.Listed(listed)
		}

		override suspend fun put(gatewayId: String, policy: AuthorizationPolicy, baseRevision: Long?): ConsolePolicyPutResult {
			puts += policy.id to baseRevision
			if (policy.id in staleIds) {
				return ConsolePolicyPutResult(stored = false, revision = 5L, reason = "revision 5 is stored; this edits ${baseRevision ?: 0}")
			}
			// Stored as keys at the gateway's revision, never as sent.
			val stored = policy.copy(revision = (baseRevision ?: 0L) + 1, selectorKeys = policy.selectorKeys.map(::keyOf))
			shelves[gatewayId] = shelves[gatewayId].orEmpty().filterNot { it.id == policy.id } + stored
			return ConsolePolicyPutResult(stored = true, revision = stored.revision, policy = stored)
		}

		override suspend fun delete(gatewayId: String, policyId: String, baseRevision: Long): ConsolePolicyDeleteResult {
			if (policyId in staleIds) return ConsolePolicyDeleteResult(deleted = false, reason = "revision 5 is stored")
			shelves[gatewayId] = shelves[gatewayId].orEmpty().filterNot { it.id == policyId }
			return ConsolePolicyDeleteResult(deleted = true)
		}

		override suspend fun enable(gatewayId: String, policyId: String, enabled: Boolean, baseRevision: Long): ConsolePolicyPutResult {
			enableHolds.remove(gatewayId)?.pass()
			val held = shelves[gatewayId].orEmpty().find { it.id == policyId }
				?: return ConsolePolicyPutResult(stored = false, revision = 0L, reason = "no policy with that id is stored")
			if (held.revision != baseRevision) {
				return ConsolePolicyPutResult(stored = false, revision = held.revision, reason = "revision ${held.revision} is stored; this edits $baseRevision")
			}
			return put(gatewayId, held.copy(enabled = enabled), baseRevision)
		}
	}

	private class Host(override val gateway: PolicyGateway?) : PolicyHost

	private fun admitting(vararg gatewayIds: String) = MutableStateFlow(ChatState(gateways = testRegistry(*gatewayIds)))

	/** Drawn Gateway answers. */
	private fun ChatState.drawn() = gateways.gateways.filter { it.policies != null }.map { it.id }

	@Test
	fun everyAdmittedGatewayIsDrawnAndOneThatRefusesTheListIsDrawnAsNothing() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(policy("apt"))
		fake.shelves["mikan"] = listOf(policy("apt", name = "Elsewhere"))
		fake.refusing += "old-box"
		val state = admitting("sakura", "mikan", "old-box")
		val ops = PolicyOps(state, Host(fake))

		runBlocking { ops.refreshAll() }

		assertEquals(listOf("mikan", "sakura"), state.value.drawn())
		assertEquals("Elsewhere", state.value.gateways.policyOn("mikan", "apt")?.name)
		// One that cannot be reached keeps what it drew; one that refuses now stops being drawn.
		fake.unreachable += "sakura"
		fake.refusing += "mikan"
		runBlocking { ops.refreshAll() }
		assertEquals(listOf("sakura"), state.value.drawn())
		assertEquals(listOf("apt"), state.value.gateways.policiesOn("sakura").map { it.id })
	}

	@Test
	fun aReadLandingAfterTheKeyringDroppedItsGatewayDrawsNothing() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(policy("apt"))
		fake.shelves["mikan"] = listOf(policy("apt"))
		val state = admitting("sakura", "mikan")
		val ops = PolicyOps(state, Host(fake))

		runBlocking {
			val hold = TestHold()
			fake.holds["mikan"] = hold
			val slow = launch { ops.refreshAll() }
			hold.entered.await()
			state.value = state.value.copy(gateways = testRegistry("sakura"))
			ops.refreshAll()
			hold.gate.complete(Unit)
			slow.join()
		}

		assertEquals(listOf("sakura"), state.value.drawn())
	}

	@Test
	fun aSlowerReadLandingAfterANewerOneDoesNotPutBackWhatTheNewerReplaced() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(policy("apt", name = "Old"))
		val state = admitting("sakura")
		val ops = PolicyOps(state, Host(fake))

		runBlocking {
			val hold = TestHold()
			fake.holds["sakura"] = hold
			val slow = launch { ops.refresh("sakura") }
			hold.entered.await()
			fake.shelves["sakura"] = listOf(policy("apt", name = "New"))
			ops.refresh("sakura")
			assertEquals("New", state.value.gateways.policyOn("sakura", "apt")?.name)
			hold.gate.complete(Unit)
			slow.join()
		}

		assertEquals("New", state.value.gateways.policyOn("sakura", "apt")?.name)
	}

	@Test
	fun aGatewayTheKeyringNoLongerAdmitsStopsBeingDrawn() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(policy("apt"))
		fake.shelves["mikan"] = listOf(policy("apt"))
		val state = admitting("sakura", "mikan")
		val ops = PolicyOps(state, Host(fake))

		runBlocking { ops.refreshAll() }
		state.value = state.value.copy(gateways = testRegistry("sakura"))
		runBlocking { ops.refreshAll() }

		assertEquals(listOf("sakura"), state.value.drawn())
	}

	@Test
	fun aSaveCarriesTheRevisionItReadAndAdoptsTheOneTheGatewayNames() {
		val fake = FakeGateway()
		val state = admitting("sakura")
		val ops = PolicyOps(state, Host(fake))

		val stored = runBlocking { ops.save(policy("apt", examples = listOf("sudo apt update")), null, "sakura") }
		// What the gateway stored is what the phone holds, not what it sent.
		assertEquals(listOf("sudo apt"), (stored as PolicySaved.Stored).policy.selectorKeys)
		assertEquals(policy("apt", examples = listOf("sudo apt")), state.value.gateways.policyOn("sakura", "apt"))

		val edited = runBlocking { ops.save(policy("apt", name = "Renamed"), 1L, "sakura") }
		assertEquals("Renamed", (edited as PolicySaved.Stored).policy.name)
		assertEquals(listOf("apt" to null, "apt" to 1L), fake.puts)

		fake.staleIds += "apt"
		val refused = runBlocking { ops.save(policy("apt", name = "Older"), 1L, "sakura") }
		assertEquals(5L, (refused as PolicySaved.Refused).heldRevision)
		assertEquals("revision 5 is stored; this edits 1", refused.reason)
		assertEquals(PolicySaved.Unreachable, runBlocking { PolicyOps(state, Host(null)).save(policy("apt"), null, "sakura") })
	}

	@Test
	fun aRefusedToggleSaysWhyOnTheRowUntilOneLands() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(policy("apt", revision = 2L))
		val state = admitting("sakura")
		val ops = PolicyOps(state, Host(fake))
		runBlocking { ops.refreshAll() }

		val stale = runBlocking { ops.setEnabled("apt", false, 1L, "sakura") }
		assertEquals("revision 2 is stored; this edits 1", (stale as PolicySaved.Refused).reason)
		assertEquals("revision 2 is stored; this edits 1", ops.toggleRefusalFor("sakura", "apt"))
		// The row draws what the gateway holds after a refusal.
		assertEquals(true, state.value.gateways.policyOn("sakura", "apt")?.enabled)

		assertEquals(true, runBlocking { ops.setEnabled("apt", false, 2L, "sakura") } is PolicySaved.Stored)
		assertEquals(null, ops.toggleRefusalFor("sakura", "apt"))
		assertEquals(false, state.value.gateways.policyOn("sakura", "apt")?.enabled)
	}

	@Test
	fun anOlderTogglesRefusalDoesNotOverwriteANewerTogglesAnswer() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(policy("apt", revision = 2L))
		val state = admitting("sakura")
		val ops = PolicyOps(state, Host(fake))
		runBlocking { ops.refreshAll() }

		runBlocking {
			val hold = TestHold()
			fake.enableHolds["sakura"] = hold
			val older = launch { ops.setEnabled("apt", false, 1L, "sakura") }
			hold.entered.await()
			assertEquals(true, ops.setEnabled("apt", false, 2L, "sakura") is PolicySaved.Stored)
			hold.gate.complete(Unit)
			older.join()
		}

		assertEquals(null, ops.toggleRefusalFor("sakura", "apt"))
		assertEquals(false, state.value.gateways.policyOn("sakura", "apt")?.enabled)
	}

	@Test
	fun aDeleteIsTheGatewaysAnswerAndAStaleOneKeepsTheRow() {
		val fake = FakeGateway()
		fake.shelves["sakura"] = listOf(policy("apt"), policy("held"))
		fake.staleIds += "held"
		val state = admitting("sakura")
		val ops = PolicyOps(state, Host(fake))
		runBlocking { ops.refreshAll() }

		val refused = runBlocking { ops.delete("held", 1L, "sakura") }
		assertEquals("revision 5 is stored", (refused as PolicyDeleted.Refused).reason)
		assertEquals(listOf("apt", "held"), state.value.gateways.policiesOn("sakura").map { it.id })
		assertEquals(PolicyDeleted.Deleted, runBlocking { ops.delete("apt", 1L, "sakura") })
		assertEquals(listOf("held"), state.value.gateways.policiesOn("sakura").map { it.id })
	}

	@Test
	fun anEditOnOneGatewayIsNotTheEditOnAnotherOfTheSameId() {
		val ops = PolicyOps(MutableStateFlow(ChatState()), Host(null))
		val here = com.atelier_nyaarium.switchboard.policies.PolicyDraft(id = "apt", name = "Here")
		val there = com.atelier_nyaarium.switchboard.policies.PolicyDraft(id = "apt", name = "There")

		ops.keepDraft("sakura", "apt", here)
		ops.keepDraft("mikan", "apt", there)
		assertEquals(here, ops.draftFor("sakura", "apt"))
		assertEquals(there, ops.draftFor("mikan", "apt"))
		ops.dropDraft("sakura", "apt")
		assertEquals(null, ops.draftFor("sakura", "apt"))
		assertEquals(there, ops.draftFor("mikan", "apt"))
	}
}
