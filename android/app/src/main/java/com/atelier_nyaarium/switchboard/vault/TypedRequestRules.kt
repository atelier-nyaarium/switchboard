package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.Act
import com.atelier_nyaarium.switchboard.CANNOT_REMEMBER_LINE
import com.atelier_nyaarium.switchboard.ENTRY_REFUSED
import com.atelier_nyaarium.switchboard.GatewayRegistry
import com.atelier_nyaarium.switchboard.Lookup
import com.atelier_nyaarium.switchboard.MAY_END_APPROVALS
import com.atelier_nyaarium.switchboard.PICK_SECRET_FIRST
import com.atelier_nyaarium.switchboard.addsToLine
import com.atelier_nyaarium.switchboard.endsApprovalsLine
import com.atelier_nyaarium.switchboard.entryRefusalLine
import com.atelier_nyaarium.switchboard.newPolicyLine
import com.atelier_nyaarium.switchboard.newSecretSub
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

/** Ids minted once. */
internal class NewSecretSeed(val value: String, val gatewayId: String, val entryId: String, val policyId: String) {
	override fun toString(): String = "NewSecretSeed(gatewayId=$gatewayId, entryId=$entryId)"
}

/** One open card's own state; never saved. */
internal data class TypedCardState(
	val mode: CardMode,
	val pick: String? = null,
	/** Untouched follows the suggestion. */
	val touched: Boolean = false,
	/** Null follows the plan. */
	val remember: Boolean? = null,
	val typed: String = "",
	val save: Boolean = false,
	val seed: NewSecretSeed? = null,
	/** Policy id per secret. */
	val policyIds: Map<String, String> = emptyMap(),
	val refused: String? = null,
) {
	override fun toString(): String = "TypedCardState(mode=$mode, pick=$pick, remember=$remember, save=$save, refused=$refused)"
}

internal sealed interface CardEvent {
	data class Picked(val entryId: String) : CardEvent

	data class Remember(val on: Boolean) : CardEvent

	data object TypeInstead : CardEvent

	data object PickInstead : CardEvent

	class Typed(val text: String) : CardEvent {
		override fun toString(): String = "Typed"
	}

	data class Save(val on: Boolean) : CardEvent

	data class OpenForm(val seed: NewSecretSeed) : CardEvent

	data object FormBack : CardEvent

	/** Pick this secret. */
	data class Landed(val entryId: String) : CardEvent

	data class Refused(val line: String) : CardEvent

	data class Minted(val entryId: String, val policyId: String) : CardEvent
}

/** What the card knows besides the request. */
internal data class TypedCardFacts(
	val gatewayId: String,
	val views: List<VaultEntryView>,
	/** Null while unread. */
	val grants: List<VaultGrant>?,
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
	val mode: CardMode,
	val whyLine: String?,
	val warning: String?,
	val quiet: String?,
	val refused: String?,
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

internal fun cannotRemember(request: VaultRequest.Typed): Boolean = request.cannotRemember == true

private fun whyCode(request: VaultRequest.Typed): Protocol.Wire.VaultTypedWhyCode? =
	request.why?.code?.let { code -> Protocol.Wire.VaultTypedWhyCode.entries.find { it.wire == code } }

/** Entries with a value allowed there; ones that already answer first. */
private const val SHARED_PROGRAM = "sudo"

/** Honoured for sudo alone, whatever the Gateway's build. */
internal fun answeringOf(typed: VaultRequest.Typed): List<VaultAnswering>? =
	typed.answering?.takeIf { typed.displayShape.substringBefore(' ') == SHARED_PROGRAM }

internal fun secretChoices(views: List<VaultEntryView>, gatewayId: String, answering: List<VaultAnswering>?): List<SecretChoice> {
	val answers = answering.orEmpty().map { it.entryId }.toSet()
	return views.grantableOn(gatewayId)
		.sortedWith(compareBy<VaultEntryView>({ it.id !in answers }, { it.title.lowercase() }, { it.id }))
		.map { SecretChoice(it.id, it.title) }
}

/** The one secret already answering, when it is one. */
internal fun suggestedPick(answering: List<VaultAnswering>?, choices: List<SecretChoice>): String? =
	answering?.singleOrNull()?.entryId?.takeIf { id -> choices.any { it.entryId == id } }

/** Pick, else suggestion. */
internal fun pickOf(request: VaultRequest.Typed, state: TypedCardState, choices: List<SecretChoice>): SecretChoice? {
	val id = if (state.touched) state.pick else suggestedPick(answeringOf(request), choices)
	return choices.firstOrNull { it.entryId == id }
}

internal fun effectiveMode(state: TypedCardState, choices: List<SecretChoice>): CardMode =
	if (state.mode == CardMode.PICK && choices.isEmpty()) CardMode.TYPE else state.mode

internal fun typedCardStart(request: VaultRequest.Typed): TypedCardState =
	TypedCardState(if (servesEntryAnswer(request)) CardMode.PICK else CardMode.TYPE)

internal fun typedCardAfter(state: TypedCardState, event: CardEvent): TypedCardState = when (event) {
	is CardEvent.Picked -> state.copy(pick = event.entryId, touched = true, remember = null, refused = null)
	is CardEvent.Remember -> state.copy(remember = event.on, refused = null)
	CardEvent.TypeInstead -> state.copy(mode = CardMode.TYPE, refused = null)
	CardEvent.PickInstead -> state.copy(mode = CardMode.PICK, refused = null)
	is CardEvent.Typed -> state.copy(typed = event.text)
	is CardEvent.Save -> state.copy(save = event.on, refused = null)
	is CardEvent.OpenForm -> state.copy(mode = CardMode.NEW_SECRET, seed = event.seed)
	CardEvent.FormBack -> state.copy(mode = CardMode.TYPE, seed = null)
	is CardEvent.Landed -> state.copy(
		mode = CardMode.PICK,
		pick = event.entryId,
		touched = true,
		remember = true,
		typed = "",
		save = false,
		seed = null,
		policyIds = state.seed?.takeIf { it.entryId == event.entryId }?.let { state.policyIds + (it.entryId to it.policyId) } ?: state.policyIds,
		refused = null,
	)
	is CardEvent.Refused -> state.copy(refused = event.line)
	is CardEvent.Minted -> state.copy(policyIds = state.policyIds + (event.entryId to event.policyId))
}

/** Cut to the name cap. */
internal fun rememberedName(title: String): String = title.trim().take(Protocol.Wire.MAX_POLICY_NAME_LEN)

/** Hides remember entirely. */
internal fun rememberHidden(request: VaultRequest.Typed): Boolean =
	!servesEntryAnswer(request) || cannotRemember(request) || whyCode(request) == Protocol.Wire.VaultTypedWhyCode.BINDING_UNUSABLE

/** What remembering would do for this pick. */
internal fun rememberPlan(request: VaultRequest.Typed, pick: SecretChoice?, policyName: (String) -> String?): RememberPlan {
	if (rememberHidden(request)) return RememberPlan.Hidden
	pick ?: return RememberPlan.NoPick
	val answering = answeringOf(request).orEmpty().firstOrNull { it.entryId == pick.entryId }
	return if (answering != null) {
		RememberPlan.AddTo(answering, policyName(answering.policy.policyId))
	} else {
		RememberPlan.Create(rememberedName(pick.title))
	}
}

/** On when the pick already answers. */
internal fun rememberOn(state: TypedCardState, plan: RememberPlan): Boolean = when (plan) {
	RememberPlan.Hidden, RememberPlan.NoPick -> false
	is RememberPlan.AddTo -> state.remember ?: true
	is RememberPlan.Create -> state.remember ?: false
}

/** Null while grants unread. */
internal fun rememberCost(plan: RememberPlan, grants: List<VaultGrant>?): Int? {
	val target = (plan as? RememberPlan.AddTo)?.answering?.policy?.policyId ?: return 0
	return grants?.count { it.policy?.policyId == target }
}

internal fun rememberLine(plan: RememberPlan, cost: Int?, on: Boolean): String? {
	if (!on && (plan is RememberPlan.AddTo || plan is RememberPlan.Create)) return null
	return when (plan) {
	RememberPlan.Hidden -> null
	RememberPlan.NoPick -> PICK_SECRET_FIRST
	is RememberPlan.AddTo -> {
		val ends = when (cost) {
			null -> MAY_END_APPROVALS
			0 -> null
			else -> endsApprovalsLine(cost)
		}
		listOfNotNull(addsToLine(plan.policyName), ends).joinToString(" ")
	}
	is RememberPlan.Create -> newPolicyLine(plan.name)
}
}

internal fun saveSecretLabel(request: VaultRequest.Typed): String =
	if (cannotRemember(request)) "Save as a secret" else saveForLabel(request.displayShape)

internal fun answerTiers(remember: Boolean): List<String> =
	if (remember) listOf(VAULT_DECISION_ONCE, VAULT_DECISION_WINDOW, VAULT_DECISION_SESSION) else listOf(VAULT_DECISION_ONCE)

/** A create needs its id. */
internal fun rememberOf(plan: RememberPlan, policyId: String?): VaultRemember? = when (plan) {
	RememberPlan.Hidden, RememberPlan.NoPick -> null
	is RememberPlan.AddTo -> VaultRemember(policyId = plan.answering.policy.policyId)
	is RememberPlan.Create -> policyId?.let { VaultRemember(policyId = it, name = plan.name) }
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
	val choices = if (serves) secretChoices(facts.views, facts.gatewayId, answeringOf(request)) else emptyList()
	val mode = effectiveMode(state, choices)
	val warning = if (request.runsAnything == true) runsAnythingLine(request.displayShape) else null
	val why = typedWhyLine(request, facts, choices.isNotEmpty())
	val quiet = if (serves && cannotRemember(request)) CANNOT_REMEMBER_LINE else null
	if (mode != CardMode.PICK) {
		val saveSub = if (rememberHidden(request)) newSecretSub(facts.gatewayId) else saveForSub()
		return TypedCardView(
			mode = mode,
			whyLine = why,
			warning = warning,
			quiet = quiet,
			refused = state.refused,
			choices = null,
			picked = null,
			field = true,
			switch = if (serves) SwitchView(saveSecretLabel(request), saveSub, state.save, true) else null,
			typeButton = false,
			pickButton = choices.isNotEmpty(),
			mainLabel = "Send",
			mainEnabled = state.typed.isNotEmpty(),
			tiers = answerTiers(false),
		)
	}
	val pick = pickOf(request, state, choices)
	val plan = rememberPlan(request, pick, facts.policyName)
	val on = rememberOn(state, plan)
	val switch = when (plan) {
		RememberPlan.Hidden -> null
		else -> SwitchView(rememberLabel(request.displayShape), rememberLine(plan, rememberCost(plan, facts.grants), on), on, pick != null)
	}
	return TypedCardView(
		mode = mode,
		whyLine = why,
		warning = warning,
		quiet = quiet,
		refused = state.refused,
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

/** Remember picks, save types. */
internal fun switchEvent(mode: CardMode, on: Boolean): CardEvent =
	if (mode == CardMode.PICK) CardEvent.Remember(on) else CardEvent.Save(on)

internal fun savesTyped(request: VaultRequest.Typed, state: TypedCardState): Boolean = state.save && servesEntryAnswer(request)

internal fun mintFor(request: VaultRequest.Typed, state: TypedCardState, facts: TypedCardFacts): String? {
	val choices = secretChoices(facts.views, facts.gatewayId, answeringOf(request))
	val pick = pickOf(request, state, choices) ?: return null
	val plan = rememberPlan(request, pick, facts.policyName)
	return pick.entryId.takeIf { plan is RememberPlan.Create && rememberOn(state, plan) && it !in state.policyIds }
}

/** Null without a pick. */
internal fun approveOp(request: VaultRequest.Typed, state: TypedCardState, facts: TypedCardFacts, decision: String): ConsoleOp.VaultAnswerEntry? {
	val pick = pickOf(request, state, secretChoices(facts.views, facts.gatewayId, answeringOf(request))) ?: return null
	val plan = rememberPlan(request, pick, facts.policyName)
	val remember = if (rememberOn(state, plan)) rememberOf(plan, state.policyIds[pick.entryId]) ?: return null else null
	return entryAnswerOp(request.requestId, pick.entryId, decision, remember)
}

internal enum class BackStep { FORM_BACK, HOLD, CLOSE }

internal fun backStep(state: TypedCardState, busy: Boolean): BackStep = when {
	state.mode != CardMode.NEW_SECRET -> BackStep.CLOSE
	busy -> BackStep.HOLD
	else -> BackStep.FORM_BACK
}

/** Answer must match its card. */
internal fun ownsCard(sentFor: String, shownNow: String): Boolean = sentFor == shownNow

/** Under the app lock, only the picked secret is named. */
internal fun namesChoices(locked: Boolean, revealed: Boolean): Boolean = !locked || revealed

private fun digest(text: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))

/** Constant-time compare. */
internal fun matchingSecret(typed: String, candidates: List<Pair<String, String>>): String? {
	val wanted = digest(typed)
	var found: String? = null
	for ((id, value) in candidates) {
		if (MessageDigest.isEqual(wanted, digest(value)) && found == null) found = id
	}
	return found
}

internal sealed interface TypedSave {
	/** Presence was not given. */
	data object Declined : TypedSave

	data class Refused(val line: String) : TypedSave

	data class Matched(val entryId: String) : TypedSave

	data class Form(val seed: NewSecretSeed) : TypedSave
}

/** How an entry answer came back. */
internal sealed interface EntryAnswered {
	data class Answered(val policy: AuthorizationPolicy?) : EntryAnswered

	/** The request ended; drop it. Null says nothing. */
	data class Gone(val line: String?) : EntryAnswered

	data class Stays(val line: String) : EntryAnswered

	/** Presence declined. */
	data object Declined : EntryAnswered
}

/** The form road: the save, then the answer. */
internal sealed interface SavedAnswer {
	data class NotSaved(val line: String) : SavedAnswer

	data class Matched(val entryId: String) : SavedAnswer

	data class Saved(val entryId: String, val answered: EntryAnswered) : SavedAnswer

	data object Declined : SavedAnswer
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

internal fun takeoverOf(requestId: String, pending: List<VaultPendingRequest>): VaultPendingRequest? =
	pending.firstOrNull { (it.request as? VaultRequest.Entry)?.replaces == requestId }

/** The request a card on this id shows: itself, or what took it over. */
internal fun shownRequest(requestId: String?, pending: List<VaultPendingRequest>): VaultPendingRequest? {
	requestId ?: return null
	return pending.firstOrNull { it.requestId == requestId } ?: takeoverOf(requestId, pending)
}
