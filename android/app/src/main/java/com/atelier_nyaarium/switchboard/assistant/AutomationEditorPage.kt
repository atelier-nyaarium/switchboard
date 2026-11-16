package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.atelier_nyaarium.switchboard.AutomationDraftKey
import com.atelier_nyaarium.switchboard.AutomationOps
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.EditorScaffold
import com.atelier_nyaarium.switchboard.Lookup
import com.atelier_nyaarium.switchboard.MirroredDraft
import com.atelier_nyaarium.switchboard.RemoveMenu
import com.atelier_nyaarium.switchboard.assistantGateway
import com.atelier_nyaarium.switchboard.homeDisplayUnit
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.rememberEdit
import kotlinx.coroutines.delay

private const val PREVIEW_DEBOUNCE_MS = 400L

/** Debounced trigger read. */
@Composable
internal fun previewRead(ops: AutomationOps, gatewayId: String, trigger: AutomationTrigger?, text: String?): PreviewRead {
	var read by remember(gatewayId) { mutableStateOf(PreviewRead()) }
	LaunchedEffect(gatewayId, trigger, text) {
		read = PreviewRead()
		val asked = trigger ?: return@LaunchedEffect
		delay(PREVIEW_DEBOUNCE_MS)
		val answer = ops.preview(gatewayId, asked, text)
		read = PreviewRead(answer, failed = answer == null)
	}
	return read
}

/** Drafts outlive this page. */
@Composable
internal fun AutomationEditorPage(
	repo: ChatRepository,
	state: ChatState,
	gatewayId: String,
	slot: AutomationSlot,
	onBack: () -> Unit,
) {
	val ops = repo.automationOps
	val key = AutomationDraftKey(gatewayId, slot)
	val home = assistantGateway(state)
	val context = automationContext(state.gateways, state.assistantHome, gatewayId)
	val display = homeDisplayUnit(state.gateways, home)
	val zone = remember { java.time.ZoneId.systemDefault().id }
	val held = slot as? AutomationSlot.Held
	val lookup = held?.let { state.gateways.automationOn(gatewayId, it.id) }
	val minted = context.minted()
	// Unit read at mint only.
	val opened = remember(key, lookup, minted, display) { minted?.let { openedDraft(slot, lookup, it, display, zone) } }
	// Restart drops served state.
	LaunchedEffect(gatewayId, state.gateways.entry(gatewayId)?.incarnation) { ops.refresh(gatewayId) }
	LaunchedEffect(home) { home?.let { repo.assistantOps.refresh(it) } }
	val open = rememberEdit(ops.edits, key, automationStanding(context, lookup), opened) { standing ->
		AssistantPageScaffold("Automation", onBack) {
			unopenedLine(slot, standing)?.let { Text(it, style = MaterialTheme.typography.bodyLarge) } ?: CircularProgressIndicator()
		}
	} ?: return
	val session = open.session
	// Rebase or Back replaces typing.
	val typed = remember(key, open.opening, session.draft.revision, session.draft.text) {
		MirroredDraft(session.draft) { next -> ops.edits.edit(key, open.opening) { next } }
	}
	var draft by typed
	val heard = context.over(draft.context)
	val offer = heard.offer
	val sources = heard.sources

	val fields = fieldsOf(draft, sources)
	val gone = lookup == Lookup.Gone
	val busy = session.busy
	val can = automationEditing(slot, draft, fields, triggerOffered(draft, sources, offer), busy, gone, offer)
	val trigger = askedTrigger(draft, fields, sources, offer)
	val triggerRead = previewRead(ops, gatewayId, trigger, null)
	var confirmingDelete by remember(key) { mutableStateOf(false) }
	var asking by remember(key) { mutableStateOf<AutomationSaid.Confirm?>(null) }
	LaunchedEffect(busy, session.said) { asking = (session.said as? AutomationSaid.Confirm)?.takeUnless { busy } }

	fun save(confirmed: Boolean) = repo.command { automationOps.commit(key, open.opening, confirmed) }

	val edit: ((AutomationDraft) -> AutomationDraft) -> Unit = { change -> draft = change(draft) }

	val ref = draft.text
	val textOf = ref?.let { textParam(draft, it, offer) }
	val shownText = ref?.let { textAt(draft, it, offer) }
	if (ref != null && textOf != null && shownText != null) {
		val consoles by repo.liveConsoleOps.state.collectAsState()
		val console = consoles[gatewayId]
		LaunchedEffect(gatewayId) { repo.command { liveConsoleOps.open(gatewayId) } }
		val names = namesHere(offer, draft.trigger.kind, triggerRead.answer?.names)
		HoleTextEditor(
			title = textOf.label,
			value = shownText,
			max = textOf.max ?: Int.MAX_VALUE,
			names = names,
			preview = textPreviewOf(shownText, trigger != null, previewRead(ops, gatewayId, trigger.takeIf { hasHole(shownText) }, previewText(shownText))),
			refused = refusedHole(session.said, ref.action, ref.param, shownText),
			description = console?.description,
			ids = console?.ids,
			shapes = nameShapes(names, fields.fields),
			enabled = can.edit,
			onChange = { text -> edit { it.withAction(ref.action) { held -> withValue(held, ref.param, text) } } },
			onBack = { edit { it.copy(text = null) } },
		)
		return
	}

	EditorScaffold(
		title = if (gone) "Deleted elsewhere" else "Automation",
		saving = busy,
		canSave = can.save,
		onSave = { save(confirmed = false) },
		onBack = onBack,
		leaving = open.leaving,
		menu = { if (slot is AutomationSlot.Held) RemoveMenu("Delete automation", enabled = can.delete) { confirmingDelete = true } },
	) {
		Text("When", style = MaterialTheme.typography.labelLarge)
		TriggerSection(draft, offer, sources, fields, zone, can.edit, triggerRead, edit)

		HorizontalDivider()
		Text("Do", style = MaterialTheme.typography.labelLarge)
		ActionsSection(
			draft = draft,
			offer = offer,
			enabled = can.edit,
			said = session.said,
			textRead = { text -> previewRead(ops, gatewayId, trigger.takeIf { text != null }, text) },
			asked = trigger != null,
			edit = edit,
		)
		generalLine(session.said, draft, offer)?.let {
			Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
	}

	if (confirmingDelete) {
		ConfirmDialog(
			title = "Delete this automation?",
			body = null,
			confirmText = "Delete",
			onConfirm = {
				confirmingDelete = false
				repo.command { automationOps.remove(key, open.opening) }
			},
			onDismiss = { confirmingDelete = false },
		)
	}
	asking?.let { confirm ->
		ConfirmDialog(
			title = "Run without asking?",
			body = confirmBody(confirm.labels),
			confirmText = "Save",
			onConfirm = {
				asking = null
				save(confirmed = true)
			},
			onDismiss = { asking = null },
		)
	}
}
