package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayReadFenceTest {
	@Test
	fun aFailedBodyIsFreshAndNullWhileASupersededReadIsStale() = runBlocking {
		val fence = GatewayReadFence()
		assertEquals(GatewayRead.Fresh<String?>(null), fence.read<String?>("sakura") { null })

		val entered = CompletableDeferred<Unit>()
		val gate = CompletableDeferred<Unit>()
		val older = async {
			fence.read("sakura") {
				entered.complete(Unit)
				gate.await()
				"older"
			}
		}
		entered.await()
		assertEquals(GatewayRead.Fresh("newer"), fence.read("sakura") { "newer" })
		gate.complete(Unit)
		assertEquals(GatewayRead.Stale, older.await())

		// Another gateway's read is not superseded by this one's.
		assertEquals(GatewayRead.Fresh("mikan"), fence.read("mikan") { "mikan" })
	}

	@Test
	fun aReadStillOutAtAReprovisionIsStale() = runBlocking {
		val fence = GatewayReadFence()
		val entered = CompletableDeferred<Unit>()
		val gate = CompletableDeferred<Unit>()
		val out = async {
			fence.read("sakura") {
				entered.complete(Unit)
				gate.await()
				"the previous owner's rows"
			}
		}
		entered.await()

		fence.clear()
		gate.complete(Unit)

		assertEquals(GatewayRead.Stale, out.await())
		assertEquals(GatewayRead.Fresh("after"), fence.read("sakura") { "after" })
	}

	@Test
	fun rowsReplaceARefusalSaysNotServedAndSilenceKeepsWhatWasDrawn() {
		val drawn = GatewayList.Listed(listOf("a"))

		assertEquals(GatewayList.Listed(listOf("b")), drawn.after(ListAnswer.Listed(listOf("b"))))
		assertEquals(GatewayList.NotServed, drawn.after(ListAnswer.NotServed))
		assertEquals(drawn, drawn.after(ListAnswer.Unreachable))
		assertEquals(GatewayList.NotServed, GatewayList.NotServed.after(ListAnswer.Unreachable))
		assertEquals(GatewayList.Unreachable, GatewayList.Unread.after(ListAnswer.Unreachable))
		assertEquals(GatewayList.Listed(listOf("b")), GatewayList.Unreachable.after(ListAnswer.Listed(listOf("b"))))
		val lists = listOf(drawn, GatewayList.NotServed, GatewayList.Unread, GatewayList.Unreachable)
		assertEquals(listOf(listOf("a"), null, null, null), lists.map { it.listedRows() })
		assertEquals(
			listOf(Lookup.Found("a"), Lookup.NotServed, Lookup.Reading, Lookup.Unreachable),
			lists.map { list -> list.lookup { it == "a" } },
		)
		assertEquals(Lookup.Gone, drawn.lookup { it == "missing" })
	}

	@Test
	fun onlyTheTokenSaysNotServedForAListEveryBuildServes() {
		val rows: (kotlinx.serialization.json.JsonElement) -> List<String>? = { listOf("row") }
		val token = ConsoleClient.ValueAnswer.Refused(com.atelier_nyaarium.switchboard.proto.Protocol.Wire.OP_REASON_NOT_SERVED)
		val prose = ConsoleClient.ValueAnswer.Refused("content key unavailable")
		val answered = ConsoleClient.ValueAnswer.Answered(kotlinx.serialization.json.JsonNull)

		assertEquals(ListAnswer.Listed(listOf("row")), listAnswerOf(answered, ProseRefusal.FAULT, rows))
		assertEquals(ListAnswer.Unreachable, listAnswerOf<String>(answered, ProseRefusal.FAULT) { null })
		assertEquals(ListAnswer.NotServed, listAnswerOf(token, ProseRefusal.FAULT, rows))
		assertEquals(ListAnswer.Unreachable, listAnswerOf(prose, ProseRefusal.FAULT, rows))
		assertEquals(ListAnswer.NotServed, listAnswerOf(prose, ProseRefusal.OLDER_BUILD, rows))
		assertEquals(ListAnswer.Unreachable, listAnswerOf(ConsoleClient.ValueAnswer.Undelivered("held"), ProseRefusal.OLDER_BUILD, rows))
		assertEquals(ListAnswer.Unreachable, listAnswerOf(ConsoleClient.ValueAnswer.Unreachable, ProseRefusal.OLDER_BUILD, rows))
	}

	@Test
	fun aListThatThrowsIsUnreachableAndASupersededOneAnswersNothing() = runBlocking {
		val fence = GatewayReadFence()
		assertEquals(ListAnswer.Unreachable, fence.list<String>("Test", "sakura") { error("down") })
		assertEquals(ListAnswer.NotServed, fence.list<String>("Test", "sakura") { ListAnswer.NotServed })
		assertEquals(ListAnswer.Unreachable, fence.list<String>("Test", "sakura", null))

		val entered = CompletableDeferred<Unit>()
		val gate = CompletableDeferred<Unit>()
		val older = async {
			fence.list("Test", "sakura") {
				entered.complete(Unit)
				gate.await()
				ListAnswer.Listed(listOf("older"))
			}
		}
		entered.await()
		assertEquals(ListAnswer.Listed(listOf("newer")), fence.list("Test", "sakura") { ListAnswer.Listed(listOf("newer")) })
		gate.complete(Unit)
		assertEquals(null, older.await())
	}
}
