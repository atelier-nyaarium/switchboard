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
import com.atelier_nyaarium.switchboard.vault.CardEvent
import com.atelier_nyaarium.switchboard.vault.CardMode
import com.atelier_nyaarium.switchboard.vault.EntryAnswered
import com.atelier_nyaarium.switchboard.vault.NewSecretSeed
import com.atelier_nyaarium.switchboard.vault.SendStep
import com.atelier_nyaarium.switchboard.vault.TypedCardFacts
import com.atelier_nyaarium.switchboard.vault.TypedCardState
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_ONCE
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_SESSION
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_WINDOW
import com.atelier_nyaarium.switchboard.vault.VaultDraft
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.approveOp
import com.atelier_nyaarium.switchboard.vault.entryAnswerOp
import com.atelier_nyaarium.switchboard.vault.entryAnswerOutcome
import com.atelier_nyaarium.switchboard.vault.matchingSecret
import com.atelier_nyaarium.switchboard.vault.refusedAnswerLine
import com.atelier_nyaarium.switchboard.vault.secretChoices
import com.atelier_nyaarium.switchboard.vault.sendStep
import com.atelier_nyaarium.switchboard.vault.shownRequest
import com.atelier_nyaarium.switchboard.vault.switchEvent
import com.atelier_nyaarium.switchboard.vault.typedCardAfter
import com.atelier_nyaarium.switchboard.vault.typedCardStart
import com.atelier_nyaarium.switchboard.vault.typedCardView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

	private fun facts(views: List<VaultEntryView> = listOf(nyaarium, old, elsewhere), grants: List<VaultGrant> = listOf(window)) =
		TypedCardFacts(gateway, views, grants, emptyList()) { id -> if (id == sudo.policyId) "Sakura Sudo" else null }

	private fun start(request: VaultRequest.Typed, facts: TypedCardFacts = facts()) =
		typedCardStart(request, secretChoices(facts.views, facts.gatewayId, request.answering))

	private var minted = 0

	private fun fresh(): String = "policy-${++minted}"

	@Test
	fun theOneSecretAlreadyAnsweringIsPickedAndRememberedIntoItsPolicy() {
		val request = typed(answering = listOf(VaultAnswering("nyaarium", sudo)))
		val state = start(request)
		val view = typedCardView(request, state, facts())

		assertEquals(CardMode.PICK, state.mode)
		assertEquals("nyaarium", view.picked?.entryId)
		assertEquals(listOf("nyaarium", "old-pass"), view.choices?.map { it.entryId })
		assertEquals("Adds to Sakura Sudo. Ends 1 approval.", view.switch?.sub)
		assertEquals(true, view.switch?.on)
		assertEquals(listOf(VAULT_DECISION_ONCE, VAULT_DECISION_WINDOW, VAULT_DECISION_SESSION), view.tiers)
		assertEquals(
			VaultRemember(policyId = sudo.policyId),
			approveOp(request, state, facts(), VAULT_DECISION_WINDOW, ::fresh)?.remember,
		)
		// Off again: once only, nothing written.
		val off = typedCardAfter(state, switchEvent(state, false))
		assertEquals(listOf(VAULT_DECISION_ONCE), typedCardView(request, off, facts()).tiers)
		assertNull(approveOp(request, off, facts(), VAULT_DECISION_WINDOW, ::fresh))
		assertNull(approveOp(request, off, facts(), VAULT_DECISION_ONCE, ::fresh)?.remember)
	}

	@Test
	fun withoutOneSuggestionTheOwnerPicksAndAHandPickStartsOff() {
		val request = typed(answering = listOf(VaultAnswering("nyaarium", sudo), VaultAnswering("old-pass", sudo)))
		val state = start(request)
		val unpicked = typedCardView(request, state, facts())

		assertNull(unpicked.picked)
		assertFalse(unpicked.mainEnabled)
		assertEquals(PICK_SECRET_FIRST, unpicked.switch?.sub)
		assertEquals(false, unpicked.switch?.enabled)

		val inList = typedCardAfter(state, CardEvent.Picked("old-pass"))
		assertEquals(true, typedCardView(request, inList, facts()).switch?.on)

		val bare = typed()
		val picked = typedCardAfter(start(bare), CardEvent.Picked("old-pass"))
		val shown = typedCardView(bare, picked, facts())
		assertEquals(false, shown.switch?.on)
		assertEquals("New policy Old Pass.", shown.switch?.sub)
		val remembered = typedCardAfter(picked, CardEvent.Remember(true))
		assertEquals(
			VaultRemember("policy-1", name = "Old Pass"),
			approveOp(bare, remembered, facts(), VAULT_DECISION_SESSION, ::fresh)?.remember,
		)
	}

	@Test
	fun noOpTheGatewayWouldRefuseAsMalformedIsEverBuilt() {
		assertNull(entryAnswerOp("r", "e", VAULT_DECISION_WINDOW, null))
		assertNull(entryAnswerOp("r", "e", VAULT_DECISION_ONCE, VaultRemember(policyId = "p", name = " ")))
		assertNull(entryAnswerOp("r", "e", "deny", null))
		assertEquals("e", entryAnswerOp("r", "e", VAULT_DECISION_ONCE, null)?.entryId)
		// A broken binding offers no remember, so no tier past once.
		val broken = typed(why = VaultTypedWhy("binding_unusable", policyName = "Sakura Sudo", entryId = "gone", unusable = "missing"))
		val state = typedCardAfter(start(broken), CardEvent.Picked("nyaarium"))
		val view = typedCardView(broken, state, facts())
		assertNull(view.switch)
		assertEquals(listOf(VAULT_DECISION_ONCE), view.tiers)
		assertEquals("Sakura Sudo has this, but its secret is gone.", view.whyLine)
		assertNull(approveOp(broken, state, facts(), VAULT_DECISION_SESSION, ::fresh))
	}

	@Test
	fun anOlderGatewayGetsTodaysCardAndNoSaveRoad() {
		val request = typed(why = null, answering = listOf(VaultAnswering("nyaarium", sudo)))
		val state = typedCardAfter(typedCardAfter(start(request), CardEvent.Typed("pw")), CardEvent.Save(true))
		val view = typedCardView(request, state, facts())

		assertEquals(CardMode.TYPE, state.mode)
		assertNull(view.whyLine)
		assertNull(view.switch)
		assertNull(view.choices)
		assertEquals(SendStep.Typed("pw"), sendStep(request, state, facts(), { "nyaarium" }, ::fresh))
	}

	@Test
	fun nothingFittingOffersTheFieldAndSaveAndSaysWhy() {
		val request = typed(runsAnything = true)
		val view = typedCardView(request, start(request, facts(views = listOf(elsewhere))), facts(views = listOf(elsewhere)))

		assertTrue(view.field)
		assertEquals("No policy covers \"sudo apt-mark\". No saved secret works on sakura.", view.whyLine)
		assertEquals("\"sudo apt-mark\" runs anything.", view.warning)
		assertEquals("New secret and policy on sakura.", view.switch?.sub)
		assertEquals(false, view.mainEnabled)
	}

	@Test
	fun savingATypedValueAHeldSecretHasAnswersWithItAndMakesNoEntry() {
		val request = typed(answering = listOf(VaultAnswering("nyaarium", sudo)))
		val typing = typedCardAfter(typedCardAfter(typedCardAfter(start(request), CardEvent.TypeInstead), CardEvent.Typed("hunter3")), CardEvent.Save(true))
		val asked = mutableListOf<String>()

		val matched = sendStep(request, typing, facts(), { asked += it; "nyaarium" }, ::fresh)
		assertEquals(listOf("hunter3"), asked)
		assertTrue(matched is SendStep.WithEntry)
		val op = (matched as SendStep.WithEntry).op
		assertEquals("nyaarium", op.entryId)
		assertEquals(VAULT_DECISION_ONCE, op.decision)
		assertEquals(VaultRemember(policyId = sudo.policyId), op.remember)

		val unmatched = sendStep(request, typing, facts(), { null }, ::fresh)
		assertTrue(unmatched is SendStep.OpenForm)
		val form = typedCardAfter(typing, CardEvent.OpenForm((unmatched as SendStep.OpenForm).seed))
		assertEquals(CardMode.NEW_SECRET, form.mode)
		assertEquals("hunter3", form.seed?.value)
		assertEquals(gateway, form.seed?.gatewayId)
		// Back keeps what was typed.
		val back = typedCardAfter(form, CardEvent.FormBack)
		assertEquals(CardMode.TYPE, back.mode)
		assertEquals("hunter3", back.typed)
		// Saved but unseen: the saved secret is offered, remembered.
		val saved = typedCardAfter(form, CardEvent.Saved("nyaarium"))
		assertEquals(CardMode.PICK, saved.mode)
		assertEquals("nyaarium", saved.pick)
		assertEquals("", saved.typed)
		// Save off is today's typed answer.
		assertEquals(SendStep.Typed("hunter3"), sendStep(request, typing.copy(save = false), facts(), { error("not asked") }, ::fresh))
	}

	@Test
	fun theTypedValueStaysOutOfEveryPrintedForm() {
		val secret = "hunter3"
		assertFalse(TypedCardState(CardMode.TYPE, typed = secret).toString().contains(secret))
		assertFalse(NewSecretSeed(secret, gateway).toString().contains(secret))
		assertFalse(VaultDraft(publicTitle = "t", value = secret).toString().contains(secret))
	}

	@Test
	fun aMatchIsFoundByValueAlone() {
		val held = listOf("a" to "hunter2", "b" to "hunter3", "c" to "hunter3")
		assertEquals("b", matchingSecret("hunter3", held))
		assertNull(matchingSecret("hunter", held))
		assertNull(matchingSecret("x", emptyList()))
	}

	@Test
	fun anEntryAnswerSaysWhetherTheRequestStays() {
		val stored = AuthorizationPolicy("p", "Sakura Sudo", PolicyBinding(entryId = "nyaarium"), listOf("sudo apt-mark"), true, 5L)
		assertEquals(EntryAnswered.Answered(stored), entryAnswerOutcome(ConsoleVaultAnswerEntryResult(ok = true, policy = stored)))
		assertEquals(EntryAnswered.Gone("That request expired."), entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("expired"))))
		// Taken over or answered elsewhere: silent.
		assertEquals(EntryAnswered.Gone(null), entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("answered"))))
		assertTrue(entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("not_typed"))) is EntryAnswered.Gone)
		assertEquals(
			EntryAnswered.Stays("That secret is not allowed on this Gateway."),
			entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("unusable", unusable = "not_allowed"))),
		)
		assertEquals(
			EntryAnswered.Stays(takenLine("sudo apt-mark", "Old Policy")),
			entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, policyRefusal = PolicyRefusal("taken", key = "sudo apt-mark", policy = "Old Policy"))),
		)
		assertEquals(EntryAnswered.Stays(ENTRY_REFUSED), entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("later_word"))))
		// Remember off answers once.
		assertEquals(
			EntryAnswered.Stays("This command cannot be remembered."),
			entryAnswerOutcome(ConsoleVaultAnswerEntryResult(false, VaultAnswerRefusal("cannot_remember", max = 200L))),
		)
	}

	@Test
	fun aRefusedTypedAnswerSpeaksByCodeAndFallsBackToItsReason() {
		val prose = "a policy stopped answering"
		assertNull(refusedAnswerLine(VaultAnswerRefusal("answered"), "already answered"))
		assertEquals("That request expired.", refusedAnswerLine(VaultAnswerRefusal("expired"), "request expired"))
		assertEquals(reasonSentence(Act.VAULT_ANSWER, prose), refusedAnswerLine(null, prose))
		assertEquals(reasonSentence(Act.VAULT_ANSWER, prose), refusedAnswerLine(VaultAnswerRefusal("later_word"), prose))
	}

	@Test
	fun aCardFollowsTheRequestThatTookItsOver() {
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
		assertEquals("req-2", shownRequest("req-1", pending)?.requestId)
		assertEquals("req-2", shownRequest("req-2", pending)?.requestId)
		assertNull(shownRequest("req-9", pending))
	}
}
