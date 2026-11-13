package com.atelier_nyaarium.switchboard.plugins

import com.atelier_nyaarium.switchboard.CutClaim
import com.atelier_nyaarium.switchboard.Message
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadCutClaimsTest {
	private class Handler(private val answer: (List<InboundMessage>, List<InboundMessage>) -> CutClaim?) : ThreadCutHandler {
		override fun claims(team: String, rows: List<InboundMessage>, left: List<InboundMessage>) = answer(rows, left)
		override fun onCut(team: String, rows: List<InboundMessage>, left: List<InboundMessage>) = Unit
	}

	private fun row(at: Long) = Message(fromMe = false, text = "m$at", at = at)

	@Test
	fun theConfirmationHearsEveryPluginThatHasAClaimAndOutlivesOneThatThrows() {
		val host = PluginHost(PluginRuntime(), android.content.ContextWrapper(null))
		host.threadCutHandlers.claim("quiet:cut", Handler { _, _ -> null })
		host.threadCutHandlers.claim("broken:cut", Handler { _, _ -> error("boom") })
		host.threadCutHandlers.claim("cards:cut", Handler { rows, left -> CutClaim(rows.size, "card of ${left.size} left") })

		val claims = host.cutClaims("t", listOf(row(1), row(2)), listOf(row(3)))

		assertEquals(listOf(CutClaim(2, "card of 1 left")), claims)
	}
}
