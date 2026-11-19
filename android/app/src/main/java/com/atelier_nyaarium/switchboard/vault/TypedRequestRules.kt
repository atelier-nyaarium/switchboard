package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.Act
import com.atelier_nyaarium.switchboard.ENTRY_REFUSED
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.Lookup
import com.atelier_nyaarium.switchboard.PICK_SECRET_FIRST
import com.atelier_nyaarium.switchboard.addsToLine
import com.atelier_nyaarium.switchboard.endsApprovalsLine
import com.atelier_nyaarium.switchboard.entryRefusalLine
import com.atelier_nyaarium.switchboard.gatewayOf
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.newPolicyLine
import com.atelier_nyaarium.switchboard.noPolicyLine
import com.atelier_nyaarium.switchboard.noSecretFitsLine
import com.atelier_nyaarium.switchboard.policyOffLine
import com.atelier_nyaarium.switchboard.policyRefusalLine
import com.atelier_nyaarium.switchboard.reasonSentence
import com.atelier_nyaarium.switchboard.rememberLabel
import com.atelier_nyaarium.switchboard.runsAnythingLine
import com.atelier_nyaarium.switchboard.saveForLabel
import com.atelier_nyaarium.switchboard.saveForSub
import com.atelier_nyaarium.switchboard.unusableLine
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultAnswerEntryResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.VaultAnswerRefusal
import com.atelier_nyaarium.switchboard.proto.VaultAnswering
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultRemember
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import java.security.MessageDigest

/** A held secret the card may answer with. */
internal data class SecretChoice(val entryId: String, val title: String)

/** What the card shows of a typed request, and how it answers. */
internal enum class CardMode { PICK, TYPE, NEW_SECRET }

/** What the new-secret form opens with. */
internal class NewSecretSeed(val value: String, val gatewayId: String) {
	override fun toString(): String = "NewSecretSeed(gatewayId=$gatewayId)"
}

/** One open card's own state; never saved. */
internal data class TypedCardState(
	val mode: CardMode,
	val pick: String? = null,
	/** Null follows the pick. */
	val remember: Boolean? = null,
	val typed: String = "",
	val save: Boolean = false,
	val seed: NewSecretSeed? = null,
) {
	override fun toString(): String = "TypedCardState(mode=$mode, pick=$pick, remember=$remember, save=$save)"
}

internal sealed interface CardEvent {
	data class Picked(val entryId: String) : CardEvent

	data class Remember(val on: Boolean) : CardEvent

	data object TypeInstead : CardEvent

	data object PickInstead : CardEvent

	data class Typed(val text: String) : CardEvent

	data class Save(val on: Boolean) : CardEvent

	data class OpenForm(val seed: NewSecretSeed) : CardEvent

	data object FormBack : CardEvent

	/** Saved, but the Gateway has not seen it. */
	data class Saved(val entryId: String) : CardEvent
}

/** What the card knows besides the request. */
internal data class TypedCardFacts(
	val gatewayId: String,
	val views: List<VaultEntryView>,
	/** That Gateway's grants, or empty. */
	val grants: List<VaultGrant>,
	val pending: List<VaultPendingRequest>,
	/** A policy's name, when read. */
	val policyName: (String) -> String?,
)

internal sealed interface RememberPlan {
	data object Hidden : RememberPlan

	data object NoPick : RememberPlan

	data class AddTo(val answering: VaultAnswering, val policyName: String?) : RememberPlan

	data class Create(val name: String) : RememberPlan
}

internal data class SwitchView(val label: String, val sub: String?, val on: Boolean, val enabled: Boolean)

/** What the card draws for a typed request. */
internal data class TypedCardView(
	val whyLine: String?,
	val warning: String?,
	/** Null hides the picker. */
	val choices: List<SecretChoice>?,
	val picked: SecretChoice?,
	val field: Boolean,
	val switch: SwitchView?,
	val typeButton: Boolean,
	val pickButton: Boolean,
	val mainLabel: String,
	val mainEnabled: Boolean,
	val tiers: List<String>,
)

/** A Gateway that says why serves the entry answer. */
internal fun servesEntryAnswer(request: VaultRequest.Typed): Boolean = request.why != null

private fun whyCode(request: VaultRequest.Typed): Protocol.Wire.VaultTypedWhyCode? =
	request.why?.code?.let { code -> Protocol.Wire.VaultTypedWhyCode.entries.find { it.wire == code } }

/** Entries with a value allowed there; ones that already answer first. */
internal fun secretChoices(views: List<VaultEntryView>, gatewayId: String, answering: List<VaultAnswering>?): List<SecretChoice> {
	val answers = answering.orEmpty().map { it.entryId }.toSet()
	return views.grantableOn(gatewayId)
		.sortedWith(compareBy<VaultEntryView>({ it.id !in answers }, { it.title.lowercase() }, { it.id }))
		.map { SecretChoice(it.id, it.title) }
}

/** The one secret already answering, when it is one. */
internal fun suggestedPick(answering: List<VaultAnswering>?, choices: List<SecretChoice>): String? =
	answering?.singleOrNull()?.entryId?.takeIf { id -> choices.any { it.entryId == id } }

internal fun typedCardStart(request: VaultRequest.Typed, choices: List<SecretChoice>): TypedCardState =
	if (servesEntryAnswer(request) && choices.isNotEmpty()) {
		TypedCardState(CardMode.PICK, pick = suggestedPick(request.answering, choices))
	} else {
		TypedCardState(CardMode.TYPE)
	}

internal fun typedCardAfter(state: TypedCardState, event: CardEvent): TypedCardState = when (event) {
	is CardEvent.Picked -> state.copy(pick = event.entryId, remember = null)
	is CardEvent.Remember -> state.copy(remember = event.on)
	CardEvent.TypeInstead -> state.copy(mode = CardMode.TYPE)
	CardEvent.PickInstead -> state.copy(mode = CardMode.PICK)
	is CardEvent.Typed -> state.copy(typed = event.text)
	is CardEvent.Save -> state.copy(save = event.on)
	is CardEvent.OpenForm -> state.copy(mode = CardMode.NEW_SECRET, seed = event.seed)
	CardEvent.FormBack -> state.copy(mode = CardMode.TYPE, seed = null)
	is CardEvent.Saved -> state.copy(mode = CardMode.PICK, pick = event.entryId, remember = true, typed = "", save = false, seed = null)
}

/** What remembering would do for this pick. */
internal fun rememberPlan(request: VaultRequest.Typed, pick: SecretChoice?, policyName: (String) -> String?): RememberPlan {
	if (!servesEntryAnswer(request) || whyCode(request) == Protocol.Wire.VaultTypedWhyCode.BINDING_UNUSABLE) return RememberPlan.Hidden
	pick ?: return RememberPlan.NoPick
	val answering = request.answering.orEmpty().firstOrNull { it.entryId == pick.entryId }
	return if (answering != null) RememberPlan.AddTo(answering, policyName(answering.policy.policyId)) else RememberPlan.Create(pick.title)
}

/** On when the pick already answers. */
internal fun rememberOn(state: TypedCardState, plan: RememberPlan): Boolean = when (plan) {
	RememberPlan.Hidden, RememberPlan.NoPick -> false
	is RememberPlan.AddTo -> state.remember ?: true
	is RememberPlan.Create -> state.remember ?: false
}

/** Approvals and requests the policy write ends. */
internal fun rememberCost(plan: RememberPlan, facts: TypedCardFacts, selfId: String): Int {
	val target = (plan as? RememberPlan.AddTo)?.answering?.policy?.policyId ?: return 0
	val grants = facts.grants.count { it.policy?.policyId == target }
	val requests = facts.pending.count { pending ->
		pending.requestId != selfId &&
			runIsolated { gatewayOf(pending.team) }.getOrNull() == facts.gatewayId &&
			(pending.request as? VaultRequest.Entry)?.policy?.policyId == target
	}
	return grants + requests
}

internal fun rememberLine(plan: RememberPlan, cost: Int): String? = when (plan) {
	RememberPlan.Hidden -> null
	RememberPlan.NoPick -> PICK_SECRET_FIRST
	is RememberPlan.AddTo -> listOfNotNull(addsToLine(plan.policyName), cost.takeIf { it > 0 }?.let(::endsApprovalsLine)).joinToString(" ")
	is RememberPlan.Create -> newPolicyLine(plan.name)
}

internal fun answerTiers(remember: Boolean): List<String> =
	if (remember) listOf(VAULT_DECISION_ONCE, VAULT_DECISION_WINDOW, VAULT_DECISION_SESSION) else listOf(VAULT_DECISION_ONCE)

/** The remember a plan sends; a create takes a fresh id. */
internal fun rememberOf(plan: RememberPlan, freshPolicyId: () -> String): VaultRemember? = when (plan) {
	RememberPlan.Hidden, RememberPlan.NoPick -> null
	is RememberPlan.AddTo -> VaultRemember(policyId = plan.answering.policy.policyId)
	is RememberPlan.Create -> VaultRemember(policyId = freshPolicyId(), name = plan.name)
}

/** Null for one the Gateway would refuse as malformed. */
internal fun entryAnswerOp(requestId: String, entryId: String, decision: String, remember: VaultRemember?): ConsoleOp.VaultAnswerEntry? {
	if (decision !in answerTiers(true)) return null
	if (decision != VAULT_DECISION_ONCE && remember == null) return null
	// A name creates; blank is no name.
	if (remember?.name?.isBlank() == true) return null
	return ConsoleOp.VaultAnswerEntry(requestId = requestId, entryId = entryId, decision = decision, remember = remember)
}

/** The why-line; null from an older Gateway. */
internal fun typedWhyLine(request: VaultRequest.Typed, facts: TypedCardFacts, fits: Boolean): String? {
	val why = request.why ?: return null
	val key = request.displayShape
	val said = when (whyCode(request)) {
		Protocol.Wire.VaultTypedWhyCode.NO_POLICY -> noPolicyLine(key)
		Protocol.Wire.VaultTypedWhyCode.POLICY_OFF -> policyOffLine(key, why.policyName)
		Protocol.Wire.VaultTypedWhyCode.BINDING_UNUSABLE -> unusableLine(
			why.policyName,
			why.entryId?.let { id -> facts.views.firstOrNull { it.id == id }?.title },
			why.unusable?.let { code -> Protocol.Wire.VaultUnusableCode.entries.find { it.wire == code } },
			facts.gatewayId,
		)
		null -> null
	}
	val fitsLine = if (fits) null else noSecretFitsLine(facts.gatewayId)
	return listOfNotNull(said, fitsLine).ifEmpty { null }?.joinToString(" ")
}

internal fun typedCardView(request: VaultRequest.Typed, state: TypedCardState, facts: TypedCardFacts): TypedCardView {
	val serves = servesEntryAnswer(request)
	val choices = if (serves) secretChoices(facts.views, facts.gatewayId, request.answering) else emptyList()
	val pick = choices.firstOrNull { it.entryId == state.pick }
	val warning = if (request.runsAnything == true) runsAnythingLine(request.displayShape) else null
	val why = typedWhyLine(request, facts, choices.isNotEmpty())
	if (state.mode != CardMode.PICK || choices.isEmpty()) {
		return TypedCardView(
			whyLine = why,
			warning = warning,
			choices = null,
			picked = null,
			field = state.mode == CardMode.TYPE || choices.isEmpty(),
			switch = if (serves) SwitchView(saveForLabel(request.displayShape), saveForSub(facts.gatewayId), state.save, true) else null,
			typeButton = false,
			pickButton = choices.isNotEmpty(),
			mainLabel = "Send",
			mainEnabled = state.typed.isNotEmpty(),
			tiers = answerTiers(false),
		)
	}
	val plan = rememberPlan(request, pick, facts.policyName)
	val on = rememberOn(state, plan)
	val switch = when (plan) {
		RememberPlan.Hidden -> null
		else -> SwitchView(rememberLabel(request.displayShape), rememberLine(plan, rememberCost(plan, facts, request.requestId)), on, pick != null)
	}
	return TypedCardView(
		whyLine = why,
		warning = warning,
		choices = choices,
		picked = pick,
		field = false,
		switch = switch,
		typeButton = true,
		pickButton = false,
		mainLabel = "Approve",
		mainEnabled = pick != null,
		tiers = answerTiers(on),
	)
}

/** What Send does with the typed value. */
internal sealed interface SendStep {
	/** The typed answer. */
	data class Typed(val value: String) : SendStep

	data class WithEntry(val op: ConsoleOp.VaultAnswerEntry) : SendStep

	data class OpenForm(val seed: NewSecretSeed) : SendStep
}

/** The card's switch: remember when picking, save when typing. */
internal fun switchEvent(state: TypedCardState, on: Boolean): CardEvent =
	if (state.mode == CardMode.PICK) CardEvent.Remember(on) else CardEvent.Save(on)

/** `matchOf` finds a held secret with that value; asked only to save. */
internal fun sendStep(
	request: VaultRequest.Typed,
	state: TypedCardState,
	facts: TypedCardFacts,
	matchOf: (String) -> String?,
	freshPolicyId: () -> String,
): SendStep {
	if (!state.save || !servesEntryAnswer(request)) return SendStep.Typed(state.typed)
	val match = matchOf(state.typed) ?: return SendStep.OpenForm(NewSecretSeed(state.typed, facts.gatewayId))
	val choice = secretChoices(facts.views, facts.gatewayId, request.answering).firstOrNull { it.entryId == match }
		?: return SendStep.OpenForm(NewSecretSeed(state.typed, facts.gatewayId))
	val remember = rememberOf(rememberPlan(request, choice, facts.policyName), freshPolicyId)
	return entryAnswerOp(request.requestId, match, VAULT_DECISION_ONCE, remember)?.let(SendStep::WithEntry)
		?: SendStep.Typed(state.typed)
}

/** Approve with the picked secret; null when nothing is picked. */
internal fun approveOp(
	request: VaultRequest.Typed,
	state: TypedCardState,
	facts: TypedCardFacts,
	decision: String,
	freshPolicyId: () -> String,
): ConsoleOp.VaultAnswerEntry? {
	val pick = secretChoices(facts.views, facts.gatewayId, request.answering).firstOrNull { it.entryId == state.pick } ?: return null
	val plan = rememberPlan(request, pick, facts.policyName)
	val remember = if (rememberOn(state, plan)) rememberOf(plan, freshPolicyId) else null
	return entryAnswerOp(request.requestId, pick.entryId, decision, remember)
}

private fun digest(text: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))

/** The secret holding that value, compared in constant time. */
internal fun matchingSecret(typed: String, candidates: List<Pair<String, String>>): String? {
	val wanted = digest(typed)
	var found: String? = null
	for ((id, value) in candidates) {
		if (MessageDigest.isEqual(wanted, digest(value)) && found == null) found = id
	}
	return found
}

/** How an entry answer came back. */
internal sealed interface EntryAnswered {
	data class Answered(val policy: AuthorizationPolicy?) : EntryAnswered

	/** The request ended; drop it. Null says nothing. */
	data class Gone(val line: String?) : EntryAnswered

	data class Stays(val line: String) : EntryAnswered
}

/** The form road: the save, then the answer. */
internal sealed interface SavedAnswer {
	data class NotSaved(val line: String) : SavedAnswer

	data class Saved(val entryId: String, val answered: EntryAnswered) : SavedAnswer
}

internal fun entryAnswerOutcome(result: ConsoleVaultAnswerEntryResult): EntryAnswered {
	if (result.ok) return EntryAnswered.Answered(result.policy)
	result.policyRefusal?.let { return EntryAnswered.Stays(policyRefusalLine(it, null)) }
	val refusal = result.refusal ?: return EntryAnswered.Stays(ENTRY_REFUSED)
	val code = Protocol.Wire.VaultAnswerRefusalCode.entries.find { it.wire == refusal.code }
		?: return EntryAnswered.Stays(ENTRY_REFUSED)
	val line = entryRefusalLine(code, refusal.unusable?.let { word -> Protocol.Wire.VaultUnusableCode.entries.find { it.wire == word } })
	return when (code) {
		// Answered elsewhere, or taken over.
		Protocol.Wire.VaultAnswerRefusalCode.ANSWERED -> EntryAnswered.Gone(null)
		Protocol.Wire.VaultAnswerRefusalCode.EXPIRED,
		Protocol.Wire.VaultAnswerRefusalCode.NOT_TYPED,
		-> EntryAnswered.Gone(line)
		Protocol.Wire.VaultAnswerRefusalCode.UNREADY,
		Protocol.Wire.VaultAnswerRefusalCode.UNUSABLE,
		Protocol.Wire.VaultAnswerRefusalCode.BOUND_ELSEWHERE,
		Protocol.Wire.VaultAnswerRefusalCode.TARGET_OFF,
		Protocol.Wire.VaultAnswerRefusalCode.CANNOT_REMEMBER,
		-> EntryAnswered.Stays(line)
	}
}

/** A refused `vault_answer`'s line; null says nothing. */
internal fun refusedAnswerLine(refusal: VaultAnswerRefusal?, reason: String?): String? {
	val code = refusal?.code?.let { word -> Protocol.Wire.VaultAnswerRefusalCode.entries.find { it.wire == word } }
		?: return reasonSentence(Act.VAULT_ANSWER, reason)
	if (code == Protocol.Wire.VaultAnswerRefusalCode.ANSWERED) return null
	return entryRefusalLine(code, refusal.unusable?.let { word -> Protocol.Wire.VaultUnusableCode.entries.find { it.wire == word } })
}

/** A policy's name, when its list is read. */
internal fun policyNameOf(registry: GatewayRegistry, gatewayId: String): (String) -> String? = { policyId ->
	when (val found = registry.policyOn(gatewayId, policyId)) {
		is Lookup.Found -> found.row.name
		Lookup.Gone, Lookup.Reading, Lookup.Unreachable, Lookup.NotServed -> null
	}
}

/** The request a card on this id shows: itself, or what took it over. */
internal fun shownRequest(requestId: String?, pending: List<VaultPendingRequest>): VaultPendingRequest? {
	requestId ?: return null
	return pending.firstOrNull { it.requestId == requestId }
		?: pending.firstOrNull { (it.request as? VaultRequest.Entry)?.replaces == requestId }
}
