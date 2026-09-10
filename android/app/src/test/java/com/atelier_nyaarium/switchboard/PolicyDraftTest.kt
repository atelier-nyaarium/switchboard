package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.policies.PolicyDraft
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.PolicyBinding
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PolicyDraftTest {
	private val ready = PolicyDraft(id = "apt", name = "Package administration", entryId = "deploy", examples = listOf("sudo apt update"))

	@Test
	fun refusesWhatTheSchemaBoundsAndSendsTheRestAsTyped() {
		assertNull(ready.refusal())
		assertNotNull(ready.copy(name = " ").refusal())
		assertNotNull(ready.copy(entryId = "").refusal())
		assertNotNull(ready.copy(examples = emptyList()).refusal())
		// Each refusal names its own field, so the editor can put it there.
		assertNotNull(ready.copy(name = " ").nameRefusal())
		assertNull(ready.copy(name = " ").bindingRefusal())
		assertNotNull(ready.copy(entryId = "").bindingRefusal())
		assertNotNull(ready.copy(examples = emptyList()).commandsRefusal())
		assertNull(ready.copy(examples = emptyList()).nameRefusal())
		assertNotNull(ready.copy(examples = listOf("sudo apt", "  ")).refusal())
		assertNotNull(ready.copy(id = "a/b").refusal())
		assertNotNull(ready.copy(examples = List(65) { "sudo x$it" }).refusal())
		assertNull(ready.copy(name = " ").toPolicy())

		// The examples go as typed; the gateway derives the keys. The revision is the one read.
		val sent = ready.copy(revision = 4L).toPolicy()
		assertEquals(listOf("sudo apt update"), sent?.selectorKeys)
		assertEquals(PolicyBinding(entryId = "deploy"), sent?.binding)
		assertEquals(4L, sent?.revision)
		assertEquals(1L, ready.toPolicy()?.revision)
	}

	@Test
	fun aRefusalNamingANewerRevisionIsTheOnlyOneASaveOverItRebasesOnto() {
		val opened = ready.copy(revision = 2L)
		assertEquals(opened.copy(revision = 5L), opened.over(5L))
		assertNull(opened.over(2L))
		assertNull(opened.over(0L))
	}

	@Test
	fun aStoredPolicyOpensAsItsKeys() {
		val stored = AuthorizationPolicy(
			id = "apt",
			name = "Package administration",
			binding = PolicyBinding(entryId = "deploy"),
			selectorKeys = listOf("sudo apt", "sudo systemctl"),
			enabled = false,
			revision = 3L,
		)
		val draft = PolicyDraft.of(stored)
		assertEquals(listOf("sudo apt", "sudo systemctl"), draft.examples)
		assertEquals(false, draft.enabled)
		assertEquals(3L, draft.revision)
		assertEquals(stored, draft.toPolicy())
	}

	private fun entry(gateways: List<String>?, unreadable: Boolean = false) = VaultEntryView(
		id = "deploy",
		revision = 1L,
		createdBy = "phone",
		createdAt = 0L,
		updatedAt = 0L,
		publicTitle = "Deploy",
		publicDescription = null,
		privateTitle = null,
		privateDescription = null,
		gateways = gateways,
		gatewaysUnreadable = unreadable,
		hasValue = true,
	)

	@Test
	fun anEntryIsAllowedOnEveryGatewayOrTheListedOnesAndNeverThroughAnUnreadableList() {
		assertEquals(true, entry(null).allowedOn("sakura"))
		assertEquals(true, entry(listOf("sakura")).allowedOn("sakura"))
		assertEquals(false, entry(listOf("mikan")).allowedOn("sakura"))
		assertEquals(false, entry(null, unreadable = true).allowedOn("sakura"))
	}
}
