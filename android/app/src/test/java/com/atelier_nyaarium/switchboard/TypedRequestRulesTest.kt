package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultAnswerEntryResult
import com.atelier_nyaarium.switchboard.proto.PolicyBinding
import com.atelier_nyaarium.switchboard.proto.PolicyRef
import com.atelier_nyaarium.switchboard.proto.PolicyRefusal
import com.atelier_nyaarium.switchboard.proto.VaultAnswerRefusal
import com.atelier_nyaarium.switchboard.proto.VaultAnswering
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultHolder
import com.atelier_nyaarium.switchboard.proto.VaultRemember
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultTypedWhy
import com.atelier_nyaarium.switchboard.vault.BackStep
import com.atelier_nyaarium.switchboard.vault.CardEvent
import com.atelier_nyaarium.switchboard.vault.CardMode
import com.atelier_nyaarium.switchboard.vault.EntryAnswered
import com.atelier_nyaarium.switchboard.vault.NewSecretSeed
import com.atelier_nyaarium.switchboard.vault.TypedCardFacts
import com.atelier_nyaarium.switchboard.vault.TypedCardState
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_ONCE
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_SESSION
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_WINDOW
import com.atelier_nyaarium.switchboard.vault.VaultDraft
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.approveOp
import com.atelier_nyaarium.switchboard.vault.backStep
import com.atelier_nyaarium.switchboard.vault.entryAnswerOp
import com.atelier_nyaarium.switchboard.vault.entryAnswerOutcome
import com.atelier_nyaarium.switchboard.vault.matchingSecret
import com.atelier_nyaarium.switchboard.vault.mintFor
import com.atelier_nyaarium.switchboard.vault.namesChoices
import com.atelier_nyaarium.switchboard.vault.ownsCard
import com.atelier_nyaarium.switchboard.vault.refusedAnswerLine
import com.atelier_nyaarium.switchboard.vault.rememberedName
import com.atelier_nyaarium.switchboard.vault.savesTyped
import com.atelier_nyaarium.switchboard.vault.shownRequest
import com.atelier_nyaarium.switchboard.vault.switchEvent
import com.atelier_nyaarium.switchboard.vault.takeoverOf
import com.atelier_nyaarium.switchboard.vault.typedCardAfter
import com.atelier_nyaarium.switchboard.vault.typedCardStart
import com.atelier_nyaarium.switchboard.vault.typedCardView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TypedRequestRulesTest {
	private val gateway = "sakura"
	private val team = "home.sakura.host.weekly"
	private val sudo = PolicyRef("sakura-sudo", 4L)
	private val nyaarium = view("nyaarium", "Sakura Nyaarium")
	private val old = view("old-pass", "Old Pass")
	private val elsewhere = view("far", "Far key", gateways = listOf("other"))

	private fun view(id: String, title: String, gateways: List<String>? = null, hasValue: Boolean = true) = VaultEntryView(
		id = id,
		revision = 1L,
		createdBy = "phone",
		createdAt = 0L,
		updatedAt = 0L,
		publicTitle = null,
		publicDescription = null,
		privateTitle = title,
		privateDescription = null,
		gateways = gateways,
		gatewaysUnreadable = false,
		hasValue = hasValue,
	)

	private fun typed(
		why: VaultTypedWhy? = VaultTypedWhy("no_policy"),
		answering: List<VaultAnswering>? = null,
		runsAnything: Boolean? = null,
		cannotRemember: Boolean? = null,
		id: String = "req-1",
	) = VaultRequest.Typed(
		v = 1L,
		requestId = id,
		operation = "/usr/bin/sudo apt-mark hold docker-ce",
		displayShape = "sudo apt-mark",
		coveredShapes = listOf("sudo apt-mark"),
		sessionTarget = "host.weekly",
		deadlineAt = Long.MAX_VALUE,
		why = why,
		runsAnything = runsAnything,
		answering = answering,
		cannotRemember = cannotRemember,
	)

	private val window = VaultGrant.Window(
		grantId = "g1",
		entryId = "nyaarium",
		holder = VaultHolder.Session("host.other"),
		displayShape = "sudo setfacl",
		coveredShapes = listOf("sudo setfacl"),
		expiresAt = Long.MAX_VALUE,
		policy = sudo,
	)

	private fun facts(views: List<VaultEntryView> = listOf(nyaarium, old, elsewhere), grants: List<VaultGrant>? = listOf(window)) =
		TypedCardFacts(gateway, views, grants) { id -> if (id == sudo.policyId) "Sakura Sudo" else null }

	private fun seed(value: String, entryId: String = "new-entry") = NewSecretSeed(value, gateway, entryId, "minted-policy")

	@Test
	fun theOneSecretAlreadyAnsweringIsPickedAndRememberedIntoItsPolicy() {
		val request = typed(answering = listOf(VaultAnswering("nyaarium", sudo)))
		val state = typedCardStart(request)
		val view = typedCardView(request, state, facts())

		assertEquals(CardMode.PICK, view.mode)
		assertEquals("nyaarium", view.picked?.entryId)
		assertEquals(listOf("nyaarium", "old-pass"), view.choices?.map { it.entryId })
		assertEquals(true, view.switch?.on)
		assertEquals(listOf(VAULT_DECISION_ONCE, VAULT_DECISION_WINDOW, VAULT_DECISION_SESSION), view.tiers)
		// Adding needs no minted id.
		assertNull(mintFor(request, state, facts()))
		assertEquals(VaultRemember(policyId = sudo.policyId), approveOp(request, state, facts(), VAULT_DECISION_WINDOW)?.remember)
		// Off again: once only, nothing written.
		val off = typedCardAfter(state, switchEvent(CardMode.PICK, false))
		assertEquals(listOf(VAULT_DECISION_ONCE), typedCardView(request, off, facts()).tiers)
		assertNull(approveOp(request, off, facts(), VAULT_DECISION_WINDOW))
		assertNull(approveOp(request, off, facts(), VAULT_DECISION_ONCE)?.remember)
	}

	@Test
	fun aNewPolicyIsMintedOnceAndKeptThroughARefusal() {
		val bare = typed()
		val picked = typedCardAfter(typedCardStart(bare), CardEvent.Picked("old-pass"))
		assertEquals(false, typedCardView(bare, picked, facts()).switch?.on)

		val remembered = typedCardAfter(picked, CardEvent.Remember(true))
		// No id yet: nothing goes out.
		assertNull(approveOp(bare, remembered, facts(), VAULT_DECISION_SESSION))
		assertEquals("old-pass", mintFor(bare, remembered, facts()))
		val minted = typedCardAfter(remembered, CardEvent.Minted("old-pass", "policy-1"))
		val first = approveOp(bare, minted, facts(), VAULT_DECISION_SESSION)?.remember
		assertEquals(VaultRemember("policy-1", name = "Old Pass"), first)

		val refused = typedCardAfter(minted, CardEvent.Refused("No."))
		assertEquals("No.", typedCardView(bare, refused, facts()).refused)
		assertNull(mintFor(bare, refused, facts()))
		assertEquals(first, approveOp(bare, refused, facts(), VAULT_DECISION_SESSION)?.remember)
		// A change clears the refusal.
		assertNull(typedCardAfter(refused, CardEvent.Picked("nyaarium")).refused)
	}

	@Test
	fun withoutOneSuggestionNothingIsPickedAndALostPickIsNoPick() {
		val request = typed(answering = listOf(VaultAnswering("nyaarium", sudo), VaultAnswering("old-pass", sudo)))
		val unpicked = typedCardView(request, typedCardStart(request), facts())
		assertNull(unpicked.picked)
		assertFalse(unpicked.mainEnabled)
		assertEquals(false, unpicked.switch?.enabled)

		val picked = typedCardAfter(typedCardStart(request), CardEvent.Picked("old-pass"))
		assertEquals(true, typedCardView(request, picked, facts()).switch?.on)
		// The picked secret left the vault.
		val gone = typedCardView(request, picked, facts(views = listOf(nyaarium)))
		assertNull(gone.picked)
		assertNull(approveOp(request, picked, facts(views = listOf(nyaarium)), VAULT_DECISION_ONCE))
	}

	@Test
	fun anAddWithGrantsUnreadSaysItMayEndApprovals() {
		val request = typed(answering = listOf(VaultAnswering("nyaarium", sudo)))
		val unread = typedCardView(request, typedCardStart(request), facts(grants = null)).switch?.sub
		val none = typedCardView(request, typedCardStart(request), facts(grants = emptyList())).switch?.sub
		val one = typedCardView(request, typedCardStart(request), facts()).switch?.sub
		assertNotNull(unread)
		assertTrue(setOf(unread, none, one).size == 3)
	}

	@Test
	fun noRememberIsOfferedWhereTheGatewayCannotRememberOrTheBindingIsBroken() {
		assertNull(entryAnswerOp("r", "e", VAULT_DECISION_WINDOW, null))
		assertNull(entryAnswerOp("r", "e", VAULT_DECISION_ONCE, VaultRemember(policyId = "p", name = " ")))
		assertNull(entryAnswerOp("r", "e", "deny", null))
		assertEquals("e", entryAnswerOp("r", "e", VAULT_DECISION_ONCE, null)?.entryId)

		val broken = typed(why = VaultTypedWhy("binding_unusable", policyName = "Sakura Sudo", entryId = "gone", unusable = "missing"))
		val unrememberable = typed(cannotRemember = true, answering = listOf(VaultAnswering("nyaarium", sudo)))
		for (request in listOf(broken, unrememberable)) {
			val state = typedCardAfter(typedCardAfter(typedCardStart(request), CardEvent.Picked("nyaarium")), CardEvent.Remember(true))
			val view = typedCardView(request, state, facts())
			assertNull(view.switch)
			assertEquals(listOf(VAULT_DECISION_ONCE), view.tiers)
			assertNull(approveOp(request, state, facts(), VAULT_DECISION_SESSION))
			assertNull(approveOp(request, state, facts(), VAULT_DECISION_ONCE)?.remember)
		}
		assertNotNull(typedCardView(unrememberable, typedCardStart(unrememberable), facts()).quiet)
		assertNull(typedCardView(broken, typedCardStart(broken), facts()).quiet)
	}

	@Test
	fun anOlderGatewayGetsTheTypedCardAndNoSaveRoad() {
		val request = typed(why = null, answering = listOf(VaultAnswering("nyaarium", sudo)))
		val state = typedCardAfter(typedCardAfter(typedCardStart(request), CardEvent.Typed("pw")), CardEvent.Save(true))
		val view = typedCardView(request, state, facts())

		assertEquals(CardMode.TYPE, view.mode)
		assertNull(view.whyLine)
		assertNull(view.switch)
		assertNull(view.choices)
		assertFalse(savesTyped(request, state))
	}

	@Test
	fun nothingFittingOffersTheFieldAndSave() {
		val request = typed(runsAnything = true)
		val only = facts(views = listOf(elsewhere))
		val state = typedCardStart(request)
		val view = typedCardView(request, state, only)

		assertEquals(CardMode.TYPE, view.mode)
		assertTrue(view.field)
		assertNotNull(view.whyLine)
		assertNotNull(view.warning)
		assertNotNull(view.switch)
		assertFalse(view.mainEnabled)
		// The switch saves, whatever mode is held.
		assertTrue(savesTyped(request, typedCardAfter(state, switchEvent(view.mode, true))))
	}

	@Test
	fun theSaveRoadLandsOnTheSecretAndKeepsTheSeedsPolicyId() {
		val request = typed(answering = listOf(VaultAnswering("nyaarium", sudo)))
		val typing = typedCardAfter(typedCardAfter(typedCardAfter(typedCardStart(request), CardEvent.TypeInstead), CardEvent.Typed("hunter3")), CardEvent.Save(true))
		assertTrue(savesTyped(request, typing))
		assertFalse(savesTyped(request, typing.copy(save = false)))

		// A match lands on that secret, remembered.
		val matched = typedCardAfter(typing, CardEvent.Landed("nyaarium"))
		assertEquals("nyaarium", typedCardView(request, matched, facts()).picked?.entryId)
		assertEquals(VaultRemember(policyId = sudo.policyId), approveOp(request, matched, facts(), VAULT_DECISION_ONCE)?.remember)

		val form = typedCardAfter(typing, CardEvent.OpenForm(seed("hunter3")))
		assertEquals(CardMode.NEW_SECRET, form.mode)
		assertEquals(BackStep.FORM_BACK, backStep(form, busy = false))
		assertEquals(BackStep.HOLD, backStep(form, busy = true))
		assertEquals(BackStep.CLOSE, backStep(typing, busy = true))
		val back = typedCardAfter(form, CardEvent.FormBack)
		assertEquals(CardMode.TYPE, back.mode)
		assertEquals("hunter3", back.typed)

		// Saved but its answer stayed: the retry names the seed's policy.
		val saved = typedCardAfter(form, CardEvent.Landed("new-entry"))
		val withNew = facts(views = listOf(nyaarium, old, view("new-entry", "Sakura Nyaarium 2")))
		assertEquals("", saved.typed)
		assertNull(mintFor(request, saved, withNew))
		assertEquals(VaultRemember("minted-policy", name = "Sakura Nyaarium 2"), approveOp(request, saved, withNew, VAULT_DECISION_ONCE)?.remember)
	}

	@Test
	fun theTypedValueStaysOutOfEveryPrintedForm() {
		val secret = "hunter3"
		assertFalse(TypedCardState(CardMode.TYPE, typed = secret).toString().contains(secret))
		assertFalse(seed(secret).toString().contains(secret))
		assertFalse(CardEvent.Typed(secret).toString().contains(secret))
		assertFalse(VaultDraft(publicTitle = "t", value = secret).toString().contains(secret))
	}

	@Test
	fun aMatchTakesTheFirstHeldSecretWithThatValue() {
		val held = listOf("a" to "hunter2", "b" to "hunter3", "c" to "hunter3")
		assertEquals("b", matchingSecret("hunter3", held))
		assertNull(matchingSecret("hunter", held))
		assertNull(matchingSecret("x", emptyList()))
	}

	@Test
	fun aPolicyNameIsTrimmedAndBounded() {
		assertEquals("Sakura", rememberedName("  Sakura  "))
		assertTrue(rememberedName("x".repeat(10_000)).length < 10_000)
	}

	@Test
	fun anEntryAnswerSaysWhetherTheRequestStays() {
		val stored = AuthorizationPolicy("p", "Sakura Sudo", PolicyBinding(entryId = "nyaarium"), listOf("sudo apt-mark"), true, 5L)
		assertEquals(EntryAnswered.Answered(stored), entryAnswerOutcome(ConsoleVaultAnswerEntryResult(ok = true, policy = stored)))
		assertTrue(entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("expired"))) is EntryAnswered.Gone)
		// Taken over or answered elsewhere: silent.
		assertEquals(EntryAnswered.Gone(null), entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("answered"))))
		assertTrue(entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("not_typed"))) is EntryAnswered.Gone)
		assertTrue(entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("unusable", unusable = "not_allowed"))) is EntryAnswered.Stays)
		assertTrue(
			entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, policyRefusal = PolicyRefusal("taken", key = "sudo apt-mark", policy = "Old Policy")))
				is EntryAnswered.Stays,
		)
		assertTrue(entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("later_word"))) is EntryAnswered.Stays)
		assertTrue(entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("cannot_remember", max = 200L))) is EntryAnswered.Stays)
	}

	@Test
	fun aRefusedTypedAnswerSpeaksByCodeAndFallsBackToItsReason() {
		val prose = "a policy stopped answering"
		assertNull(refusedAnswerLine(VaultAnswerRefusal("answered"), "already answered"))
		assertEquals(reasonSentence(Act.VAULT_ANSWER, prose), refusedAnswerLine(null, prose))
		assertEquals(reasonSentence(Act.VAULT_ANSWER, prose), refusedAnswerLine(VaultAnswerRefusal("later_word"), prose))
	}

	@Test
	fun aCardFollowsTheRequestThatTookItOverAndLandsOnlyOnItsOwnCard() {
		val takeover = VaultRequest.Entry(
			entryId = "nyaarium",
			v = 1L,
			requestId = "req-2",
			operation = "sudo apt-mark hold x",
			displayShape = "sudo apt-mark",
			coveredShapes = listOf("sudo apt-mark"),
			sessionTarget = "host.weekly",
			deadlineAt = Long.MAX_VALUE,
			replaces = "req-1",
		)
		val pending = listOf(VaultPendingRequest(team, takeover, 0L))
		assertEquals("req-2", takeoverOf("req-1", pending)?.requestId)
		assertNull(takeoverOf("req-2", pending))
		assertEquals("req-2", shownRequest("req-1", pending)?.requestId)
		assertEquals("req-2", shownRequest("req-2", pending)?.requestId)
		assertNull(shownRequest("req-9", pending))

		assertTrue(ownsCard("req-1", "req-1"))
		assertFalse(ownsCard("req-1", "req-2"))
		assertFalse(namesChoices(locked = true, revealed = false))
		assertTrue(namesChoices(locked = true, revealed = true))
	}
}
