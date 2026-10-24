package com.atelier_nyaarium.switchboard

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** Keyguard dismissal state. */
internal enum class Dismissal { NONE, WAITING, FAILED, SUCCEEDED, CANCELLED }

/** One-shot summon composer focus. */
internal enum class SummonFocus { HELD, ARMED, SPENT }

/** Assistant-key press. */
internal data class Summon(
	val id: Long,
	/** A credential was asked for, so it stands for the app lock. */
	val challenged: Boolean,
	val dismissal: Dismissal,
	val retried: Boolean = false,
	val routed: Boolean = false,
	val focus: SummonFocus,
	val lockTaken: Boolean = false,
) {
	fun dismissed(): Summon = copy(dismissal = Dismissal.SUCCEEDED, focus = armedFrom(focus))

	/** Cancellation ends held focus. */
	fun cancelled(): Summon = copy(dismissal = Dismissal.CANCELLED, focus = spentFrom(focus))

	/** Retry once, then cancel. */
	fun failed(): Summon = if (retried) cancelled() else copy(dismissal = Dismissal.FAILED)

	/** Null when unchanged. Re-reads the challenge, since Smart Lock may trust the device by now. */
	fun retried(keyguardShowing: Boolean, deviceLocked: Boolean): Summon? = when {
		dismissal != Dismissal.FAILED -> null
		keyguardShowing -> copy(dismissal = Dismissal.WAITING, retried = true, challenged = challenged && deviceLocked)
		else -> copy(dismissal = Dismissal.NONE, challenged = false, focus = spentFrom(focus))
	}

	fun routedNow(): Summon = copy(routed = true)

	/** A newer open request wins: no late landing, no late keyboard. */
	fun superseded(): Summon = copy(routed = true, focus = SummonFocus.SPENT)

	fun focusSpent(): Summon = copy(focus = SummonFocus.SPENT)

	fun lockTakenNow(): Summon = copy(lockTaken = true)
}

private fun armedFrom(focus: SummonFocus) = if (focus == SummonFocus.HELD) SummonFocus.ARMED else focus

private fun spentFrom(focus: SummonFocus) = if (focus == SummonFocus.HELD) SummonFocus.SPENT else focus

/** Ignore restored/history launches. */
internal fun isFreshSummon(action: String?, restored: Boolean, flags: Int): Boolean =
	action == Intent.ACTION_ASSIST && !restored && flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0

internal fun summoned(id: Long, keyguardShowing: Boolean, deviceLocked: Boolean): Summon = Summon(
	id = id,
	challenged = keyguardShowing && deviceLocked,
	dismissal = if (keyguardShowing) Dismissal.WAITING else Dismissal.NONE,
	focus = if (keyguardShowing) SummonFocus.HELD else SummonFocus.ARMED,
)

/** Only while the keyguard shows. */
internal fun requestsDismissal(summon: Summon): Boolean = summon.dismissal == Dismissal.WAITING

/** Route after boot and resume. */
internal fun routesNow(summon: Summon?, booted: Boolean, resumed: Boolean): Boolean =
	summon != null && !summon.routed && booted && resumed

internal fun satisfiesAppLock(summon: Summon?): Boolean =
	summon != null && summon.challenged && summon.dismissal == Dismissal.SUCCEEDED && !summon.lockTaken

/** Prevent duplicate lock prompts. */
internal fun promptsAppLock(locked: Boolean, windowFocused: Boolean, prompted: Boolean, summon: Summon?): Boolean =
	locked && windowFocused && !prompted && summon?.dismissal != Dismissal.WAITING && !satisfiesAppLock(summon)

internal sealed interface SummonLanding {
	data class At(val team: String) : SummonLanding

	data object Root : SummonLanding

	data object Configure : SummonLanding
}

/** Resume latest assistant when unanswered. */
internal fun summonLanding(state: ChatState, root: AssistantRoot, preferred: String?): SummonLanding = when (root) {
	is AssistantRoot.Placed -> SummonLanding.At(root.team)
	AssistantRoot.Unplaced -> SummonLanding.Configure
	AssistantRoot.Loading, is AssistantRoot.Unavailable ->
		lastAssistant(state, preferred)?.let { SummonLanding.At(it) } ?: SummonLanding.Root
}

/** Preferred Gateway's newest thread; otherwise newest overall. */
internal fun lastAssistant(state: ChatState, preferred: String?): String? {
	val known = (state.roles.filterValues { it == ASSISTANT_ROLE }.keys + assistantTeams(state)).distinct()
	val newest = { team: String -> state.threads[team]?.lastOrNull()?.at ?: Long.MIN_VALUE }
	val onPreferred = known.filter { preferred != null && gatewayOf(it) == preferred }
	return onPreferred.maxByOrNull(newest) ?: known.maxByOrNull(newest)
}

internal fun ShellNav.summonedTo(landing: SummonLanding, facts: (String) -> ArrivalFacts): ShellNav = when (landing) {
	is SummonLanding.At -> arriveAt(landing.team, assistant = true, Arrival.OUTSIDE, facts(landing.team))
	SummonLanding.Root -> copy(root = RootView.ASSISTANT, conversation = null, settings = null, assistantPage = null)
	SummonLanding.Configure ->
		copy(root = RootView.ASSISTANT, conversation = null, settings = null, assistantPage = AssistantPage.Settings)
}

internal enum class SummonShown { ASSISTANT_CHAT, WAITING, ELSEWHERE }

internal fun summonShown(
	screen: ShellScreen,
	nav: ShellNav,
	assistantOpen: Boolean,
	view: ConversationView?,
	root: AssistantRoot,
	/** Scheduled sends hide the composer. */
	composerShown: Boolean,
	/** A drawer still over the conversation. */
	covered: Boolean,
): SummonShown = when {
	screen == ShellScreen.LOCK || screen == ShellScreen.BOOT -> SummonShown.WAITING
	screen == ShellScreen.CONVERSATION && covered -> SummonShown.WAITING
	screen == ShellScreen.CONVERSATION && assistantOpen && view == ConversationView.CHAT && composerShown ->
		SummonShown.ASSISTANT_CHAT
	screen == ShellScreen.ROOT && nav.root == RootView.ASSISTANT && (root is AssistantRoot.Loading || root is AssistantRoot.Placed) ->
		SummonShown.WAITING
	else -> SummonShown.ELSEWHERE
}

internal enum class FocusStep { IDLE, WAIT, FIRE, DROP }

/** Pause preserves pending focus. */
internal fun focusStep(summon: Summon?, shown: SummonShown, windowFocused: Boolean, resumed: Boolean): FocusStep = when {
	summon == null || summon.focus == SummonFocus.SPENT || !resumed -> FocusStep.IDLE
	!summon.routed -> FocusStep.WAIT
	shown == SummonShown.ELSEWHERE -> FocusStep.DROP
	shown == SummonShown.ASSISTANT_CHAT && summon.focus == SummonFocus.ARMED && windowFocused -> FocusStep.FIRE
	else -> FocusStep.WAIT
}

/** Summons survive rotation, not process death. */
internal object SummonBus {
	private val _pending = MutableStateFlow<Summon?>(null)
	val pending: StateFlow<Summon?> = _pending
	private val ids = AtomicLong()

	fun raise(keyguardShowing: Boolean, deviceLocked: Boolean): Summon =
		summoned(ids.incrementAndGet(), keyguardShowing, deviceLocked).also { _pending.value = it }

	fun supersede() {
		_pending.update { it?.superseded() }
	}

	/** Ignore stale summon callbacks. */
	fun step(id: Long, change: (Summon) -> Summon) {
		_pending.update { held -> if (held?.id == id) change(held) else held }
	}

	fun retried(keyguardShowing: Boolean, deviceLocked: Boolean): Summon? {
		while (true) {
			val held = _pending.value ?: return null
			val next = held.retried(keyguardShowing, deviceLocked) ?: return null
			if (_pending.compareAndSet(held, next)) return next.takeIf(::requestsDismissal)
		}
	}
}

/** Unreadable role state hides setup. */
internal fun assistantRoleHeld(context: Context): Boolean = runIsolated {
	context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_ASSISTANT) != false
}.getOrDefault(true)

private val ASSISTANT_PICKERS = listOf(Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)

/** Role grants require system settings. */
internal fun openAssistantPicker(context: Context): Boolean = ASSISTANT_PICKERS.any { action ->
	runIsolated { context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
}
