package com.atelier_nyaarium.switchboard.vault

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.EXACT_KEYBOARD
import com.atelier_nyaarium.switchboard.PickMenu
import com.atelier_nyaarium.switchboard.gatewayOf
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.hostActivity
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.runIsolated
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the overlay supplies that the app's sheet does not. */
class VaultPromptExits(
	val goToSession: () -> Unit,
	/** The presence gate, which the overlay has no activity to prompt on. */
	val confirmPresence: suspend () -> Boolean,
)

/** The app's dialog around [VaultRequestCard]. */
@Composable
fun VaultRequestSheet(
	repo: ChatRepository,
	state: ChatState,
	requestId: String,
	onClose: () -> Unit,
) {
	val pending by repo.vault.pending.collectAsState()
	val request = shownRequest(requestId, pending)
	// A request settled elsewhere closes the sheet after this frame.
	LaunchedEffect(request == null) { if (request == null) onClose() }
	if (request == null) return
	Dialog(
		onDismissRequest = onClose,
		properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
	) {
		VaultRequestCard(repo, state, request, onClose)
	}
}

/**
 * What is asked for, who asks, and the command; the owner picks how long the approval holds. The
 * app's sheet and the overlay both draw this, so neither can drift from the other.
 */
@Composable
fun VaultRequestCard(
	repo: ChatRepository,
	state: ChatState,
	request: VaultPendingRequest,
	onClose: () -> Unit,
	modifier: Modifier = Modifier,
	/** Only the head and one line of the command. */
	collapsed: Boolean = false,
	exits: VaultPromptExits? = null,
) {
	val requestId = request.requestId
	val activity = hostActivity()
	val scope = rememberCoroutineScope()
	val revision by repo.vault.revision
	val entry = remember(revision, request.entryId) { request.entryId?.let { repo.vaultOps.view(it) } }
	// Deny opens the steering field; the second Deny sends it, empty or not.
	var steering by remember(requestId) { mutableStateOf(false) }
	var note by remember(requestId) { mutableStateOf("") }
	var shown by remember(requestId) { mutableStateOf(false) }
	val steerFocus = remember { FocusRequester() }
	val secretFocus = remember { FocusRequester() }
	var busy by remember(requestId) { mutableStateOf(false) }
	var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
	// The ticker also retires the request once its deadline passes.
	LaunchedEffect(requestId) {
		val deadlineAt = request.deadlineAt
		while (true) {
			delay(if (deadlineAt - now < EXPIRY_SECONDS_BELOW_MS) 1_000 else 15_000)
			now = System.currentTimeMillis()
			repo.vault.sweepRequests(now)
		}
	}
	val typedRequest = request.request as? VaultRequest.Typed
	val expired = request.deadlineAt <= now
	val expiry = expiresIn(request.deadlineAt, now)

	val gatewayId = remember(request.team) { runIsolated { gatewayOf(request.team) }.getOrNull() ?: "" }
	val grants by repo.vault.grants
	val everyPending by repo.vault.pending.collectAsState()
	val views = remember(revision) { repo.vaultOps.views() }
	val facts = TypedCardFacts(gatewayId, views, grants[gatewayId].orEmpty(), everyPending, policyNameOf(state.gateways, gatewayId))
	var card by remember(requestId) {
		mutableStateOf(typedRequest?.let { typedCardStart(it, secretChoices(views, gatewayId, it.answering)) })
	}
	val held = card
	val view = if (typedRequest != null && held != null) typedCardView(typedRequest, held, facts) else null
	fun on(event: CardEvent) {
		card = card?.let { typedCardAfter(it, event) }
	}
	LaunchedEffect(requestId) {
		if (typedRequest != null && servesEntryAnswer(typedRequest)) {
			repo.command {
				policyOps.refresh(gatewayId)
				vaultOps.refreshGrantsNow(gatewayId)
			}
		}
	}

	suspend fun present(): Boolean = exits?.confirmPresence?.invoke() ?: repo.vaultOps.ownerPresent(activity)

	fun answer(decision: String) {
		busy = true
		scope.launch {
			val approving = decision != VAULT_DECISION_DENY
			// A typed value never prompts: typing it is the owner's act.
			if (approving && typedRequest == null && !present()) {
				busy = false
				return@launch
			}
			val value = if (approving && typedRequest != null) held?.typed else null
			val ok = repo.vaultOps.answer(request, decision, value, if (approving) null else note)
			busy = false
			if (ok) onClose()
		}
	}

	fun withEntry(op: ConsoleOp.VaultAnswerEntry) {
		busy = true
		scope.launch {
			if (!present()) {
				busy = false
				return@launch
			}
			val outcome = repo.vaultOps.answerWithEntry(request, op)
			busy = false
			if (outcome !is EntryAnswered.Stays) onClose()
		}
	}

	fun act(decision: String) {
		val typed = typedRequest ?: return answer(decision)
		val state = card ?: return
		when (state.mode) {
			CardMode.PICK -> approveOp(typed, state, facts, decision, repo.vaultOps::newPolicyId)?.let(::withEntry)
			CardMode.TYPE, CardMode.NEW_SECRET -> {
				val matchOf = { value: String -> repo.vaultOps.matchFor(value, gatewayId) }
				when (val step = sendStep(typed, state, facts, matchOf, repo.vaultOps::newPolicyId)) {
					is SendStep.Typed -> answer(VAULT_DECISION_ONCE)
					is SendStep.WithEntry -> withEntry(step.op)
					is SendStep.OpenForm -> on(CardEvent.OpenForm(step.seed))
				}
			}
		}
	}

	suspend fun saveFromForm(draft: VaultDraft): String? {
		if (!present()) return null
		return when (val saved = repo.vaultOps.saveAndAnswer(request, draft)) {
			is SavedAnswer.NotSaved -> saved.line
			is SavedAnswer.Saved -> {
				when (saved.answered) {
					is EntryAnswered.Stays -> on(CardEvent.Saved(saved.entryId))
					is EntryAnswered.Answered, is EntryAnswered.Gone -> onClose()
				}
				null
			}
		}
	}

	Surface(shape = RoundedCornerShape(28.dp), tonalElevation = 6.dp, modifier = modifier.fillMaxWidth(0.95f)) {
		val seed = held?.seed
		if (!collapsed && held?.mode == CardMode.NEW_SECRET && seed != null) {
			VaultEntryForm(
				repo = repo,
				state = state,
				existing = null,
				seed = seed,
				onClose = { on(CardEvent.FormBack) },
				saveDraft = ::saveFromForm,
				closeLabel = "Back",
			)
			return@Surface
		}
		Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
			Column(
				Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
				verticalArrangement = Arrangement.spacedBy(12.dp),
			) {
				Row(verticalAlignment = Alignment.CenterVertically) {
					Text(
						requestTitle(request, entry?.title),
						style = MaterialTheme.typography.titleMedium,
						modifier = Modifier.weight(1f),
					)
					Text(
						expiry.text,
						style = MaterialTheme.typography.labelSmall,
						color = if (expiry.urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				Text(requester(state, request), style = MaterialTheme.typography.titleSmall)
				Text(
					request.operation,
					style = MaterialTheme.typography.bodyMedium,
					fontFamily = FontFamily.Monospace,
					maxLines = if (collapsed) 1 else Int.MAX_VALUE,
					overflow = TextOverflow.Ellipsis,
				)
				if (collapsed) return@Column
				view?.whyLine?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
				view?.warning?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
				}
				windowCovers(request)?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
				repeatNotice(request)?.let {
					Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
				}
				if (steering) {
					OutlinedTextField(
						value = note,
						onValueChange = { note = it },
						minLines = 2,
						label = { Text("Steer") },
						modifier = Modifier.fillMaxWidth().focusRequester(steerFocus),
					)
					LaunchedEffect(Unit) { steerFocus.requestFocus() }
				} else if (view != null) {
					view.choices?.let { choices ->
						PickMenu(
							label = "Secret",
							choices = choices,
							picked = view.picked,
							labelOf = { it.title },
							onPick = { on(CardEvent.Picked(it.entryId)) },
							enabled = !busy,
						)
					}
					if (view.field) {
						OutlinedTextField(
							value = held?.typed.orEmpty(),
							onValueChange = { on(CardEvent.Typed(it)) },
							singleLine = true,
							label = { Text("Password") },
							keyboardOptions = EXACT_KEYBOARD,
							visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
							trailingIcon = { TextButton(onClick = { shown = !shown }) { Text(if (shown) "Hide" else "Show") } },
							modifier = Modifier.fillMaxWidth().focusRequester(secretFocus),
						)
						LaunchedEffect(requestId) { secretFocus.requestFocus() }
					}
					view.switch?.let { switch ->
						Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
							Column(Modifier.weight(1f)) {
								Text(switch.label, style = MaterialTheme.typography.bodyMedium)
								switch.sub?.let {
									Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
								}
							}
							Switch(
								checked = switch.on,
								enabled = switch.enabled && !busy,
								onCheckedChange = { checked -> held?.let { on(switchEvent(it, checked)) } },
							)
						}
					}
				}
			}
			if (collapsed) return@Column
			if (steering) {
				Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
					TextButton(onClick = hapticClick { steering = false }, enabled = !busy) { Text("Back") }
					Spacer(Modifier.weight(1f))
					Button(
						onClick = hapticClick { answer(VAULT_DECISION_DENY) },
						enabled = !busy,
						colors = ButtonDefaults.buttonColors(
							containerColor = MaterialTheme.colorScheme.error,
							contentColor = MaterialTheme.colorScheme.onError,
						),
					) { Text("Deny") }
				}
				return@Column
			}
			Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
				TextButton(onClick = hapticClick { steering = true }, enabled = !busy) { Text("Deny") }
				exits?.let { TextButton(onClick = hapticClick(it.goToSession), enabled = !busy) { Text("Go to session") } }
				if (view?.typeButton == true) TextButton(onClick = hapticClick { on(CardEvent.TypeInstead) }, enabled = !busy) { Text("Type") }
				if (view?.pickButton == true) TextButton(onClick = hapticClick { on(CardEvent.PickInstead) }, enabled = !busy) { Text("Pick") }
				Spacer(Modifier.weight(1f))
				if (view != null) {
					SplitAnswer(
						label = view.mainLabel,
						enabled = !busy && !expired && view.mainEnabled,
						onMain = { act(view.tiers.first()) },
						more = view.tiers.drop(1).map { decision -> tierLabel(decision) to { act(decision) } },
					)
				} else {
					SplitAnswer(
						label = "Approve",
						enabled = !busy && !expired,
						onMain = { answer(VAULT_DECISION_ONCE) },
						more = listOf(
							tierLabel(VAULT_DECISION_WINDOW) to { answer(VAULT_DECISION_WINDOW) },
							tierLabel(VAULT_DECISION_SESSION) to { answer(VAULT_DECISION_SESSION) },
						),
					)
				}
			}
		}
	}
}

private fun tierLabel(decision: String): String = when (decision) {
	VAULT_DECISION_WINDOW -> "30 min"
	VAULT_DECISION_SESSION -> "This session"
	else -> "Once"
}

/** The usual answer as the button; the rest behind the arrow. */
@Composable
private fun SplitAnswer(label: String, enabled: Boolean, onMain: () -> Unit, more: List<Pair<String, () -> Unit>>) {
	if (more.isEmpty()) {
		Button(onClick = hapticClick(onMain), enabled = enabled) { Text(label) }
		return
	}
	var open by remember { mutableStateOf(false) }
	Row(verticalAlignment = Alignment.CenterVertically) {
		Button(
			onClick = hapticClick(onMain),
			enabled = enabled,
			shape = RoundedCornerShape(topStartPercent = 50, topEndPercent = 15, bottomEndPercent = 15, bottomStartPercent = 50),
		) { Text(label) }
		Spacer(Modifier.width(2.dp))
		Box {
			Button(
				onClick = hapticClick { open = true },
				enabled = enabled,
				shape = RoundedCornerShape(topStartPercent = 15, topEndPercent = 50, bottomEndPercent = 50, bottomStartPercent = 15),
				contentPadding = PaddingValues(horizontal = 10.dp),
			) { Icon(Icons.Default.ArrowDropDown, contentDescription = "More") }
			DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
				for ((text, act) in more) {
					DropdownMenuItem(text = { Text(text) }, onClick = {
						open = false
						act()
					})
				}
			}
		}
	}
}
