package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeScopeTarget
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * A sandbox read that answers without suspending passes a screen keyed on its own load, which a real
 * session would cancel.
 */
class SandboxWorkspaceGatewayTest {
	private val gateway = SandboxWorkspaceGateway { 1_800_000_000_000L }

	private val target = WorkspaceTarget("parsing", "domain.parsing.host.main")

	/** Unconfined runs the body here until it suspends, so a settled answer means no round trip. */
	private fun atOnce(call: suspend () -> Unit): Boolean = runBlocking {
		val answered = CompletableDeferred<Unit>()
		val asking = launch(Dispatchers.Unconfined) {
			call()
			answered.complete(Unit)
		}
		val settled = answered.isCompleted
		asking.cancelAndJoin()
		settled
	}

	@Test
	fun `every drill-in answers after a round trip, never at once`() {
		assertFalse(atOnce { gateway.symbolFacet(target, "missing", WorkspaceFacet.Uses) })
		assertFalse(atOnce { gateway.fileHistory(target, "AGENTS.md") })
		assertFalse(atOnce { gateway.knowledgeScope(target, WorkspaceKnowledgeScopeTarget.File("AGENTS.md"), false) })
	}
}
