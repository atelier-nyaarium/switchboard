package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.RunbookParameter
import com.atelier_nyaarium.switchboard.runbooks.RunbookManager
import com.atelier_nyaarium.switchboard.runbooks.RunbookStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class RunbookManagerTest {
	private val GW = "sakura"

	private class MemoryStore : RunbookStore {
		var blob: String? = null
		var refusing = false
		override fun loadRunbooks() = blob
		override fun saveRunbooks(json: String) {
			if (refusing) throw java.io.IOException("no room")
			blob = json
		}
	}

	private fun book(id: String, revision: Long = 1L) = Runbook(
		id = id,
		name = id,
		body = "release {{level}}",
		parameters = listOf(RunbookParameter(name = "level", label = "Level", kind = "text")),
		revision = revision,
	)

	@Test
	fun theLibrarySurvivesTheAppBeingRestarted() {
		val store = MemoryStore()
		RunbookManager(store).merge(GW, listOf(book("deploy"), book("release")))

		val reopened = RunbookManager(store)
		assertEquals(listOf("deploy", "release"), reopened.all(GW).map { it.id })
		assertEquals("release {{level}}", reopened.find(GW, "deploy")?.body)

		reopened.remove(GW, "deploy")
		assertEquals(listOf("release"), RunbookManager(store).all(GW).map { it.id })
	}

	@Test
	fun aCopyArrivingFromAGatewayOnlyWinsWhenItIsNewer() {
		val manager = RunbookManager(MemoryStore())
		manager.merge(GW, listOf(book("deploy", revision = 4L)))

		manager.merge(GW, listOf(book("deploy", revision = 2L)))
		assertEquals(4L, manager.find(GW, "deploy")?.revision)

		manager.merge(GW, listOf(book("deploy", revision = 9L)))
		assertEquals(9L, manager.find(GW, "deploy")?.revision)
	}

	@Test
	fun oneGatewaysRevisionsAreNotTheOthers() {
		val store = MemoryStore()
		val manager = RunbookManager(store)
		manager.merge(GW, listOf(book("deploy", revision = 9L)))
		manager.merge("laptop", listOf(book("deploy", revision = 2L)))

		// The higher revision belongs to one gateway and says nothing about the other's copy.
		assertEquals(9L, manager.find(GW, "deploy")?.revision)
		assertEquals(2L, manager.find("laptop", "deploy")?.revision)

		manager.remove("laptop", "deploy")
		assertEquals(listOf("deploy"), RunbookManager(store).all(GW).map { it.id })
		assertEquals(emptyList<Runbook>(), RunbookManager(store).all("laptop"))
	}

	@Test
	fun aLibraryWrittenBeforeTheCopiesWereSplitIsTheHomeGatewaysAndNobodyElses() {
		val store = MemoryStore()
		store.blob = """[{"id":"deploy","name":"deploy","body":"do it","parameters":[],"revision":3}]"""

		val manager = RunbookManager(store) { GW }
		assertEquals(listOf("deploy"), manager.all(GW).map { it.id })
		// Named rather than raced: two syncs cannot each push that copy to a different gateway.
		assertEquals(emptyList<Runbook>(), manager.all("laptop"))

		manager.merge(GW, listOf(book("deploy", revision = 4L)))
		assertEquals(4L, manager.find(GW, "deploy")?.revision)
		assertEquals(emptyList<Runbook>(), manager.all("laptop"))
	}

	@Test
	fun aLibraryOnDiskThatNoLongerDecodesStartsEmptyRatherThanCrashing() {
		val store = MemoryStore().also { it.blob = "{not json" }
		assertEquals(emptyList<Runbook>(), RunbookManager(store).all(GW))
	}

	@Test
	fun aLibraryThatCouldNotBeWrittenIsNotShownAsIfItHad() {
		val store = MemoryStore()
		val manager = RunbookManager(store)
		manager.merge(GW, listOf(book("deploy")))

		store.refusing = true
		assertEquals(listOf("deploy"), manager.merge(GW, listOf(book("release"))).map { it.id })
		assertEquals(listOf("deploy"), RunbookManager(store).all(GW).map { it.id })
	}

	@Test
	fun reprovisioningLeavesThePreviousOwnerNothing() {
		val store = MemoryStore()
		val manager = RunbookManager(store)
		manager.merge(GW, listOf(book("deploy")))

		runBlocking { manager.clearInMemory() }
		assertEquals(emptyList<Runbook>(), manager.all(GW))
		assertEquals(emptyList<Runbook>(), RunbookManager(store).all(GW))
	}

	@Test
	fun aClearTheDiskRefusesStillTakesTheLibraryOutOfMemory() {
		val store = MemoryStore()
		val manager = RunbookManager(store)
		manager.merge(GW, listOf(book("deploy")))

		store.refusing = true
		runBlocking { manager.clearInMemory() }
		assertEquals(emptyList<Runbook>(), manager.all(GW))
	}
}
