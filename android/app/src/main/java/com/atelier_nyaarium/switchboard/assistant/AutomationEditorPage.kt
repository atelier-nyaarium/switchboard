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
import com.atelier_nyaarium.switchboard.AutomationSaved
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.EditStanding
import com.atelier_nyaarium.switchboard.EditorScaffold
import com.atelier_nyaarium.switchboard.Lookup
import com.atelier_nyaarium.switchboard.MirroredDraft
import com.atelier_nyaarium.switchboard.RemoveMenu
import com.atelier_nyaarium.switchboard.assistantGateway
import com.atelier_nyaarium.switchboard.displayUnitOf
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.rememberEdit
import com.atelier_nyaarium.switchboard.waitingLine
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
	val sources = editorSources(state.gateways, gatewayId, home)
	val offer = offerOn(state.gateways.entry(gatewayId), away = gatewayId != home)
	val display = displayUnitOf(home?.let { state.gateways.assistantOn(it) })
	val zone = remember { java.time.ZoneId.systemDefault().id }
	val held = slot as? AutomationSlot.Held
	val lookup = held?.let { state.gateways.automationOn(gatewayId, it.id) }
	val row = lookup?.found()
	val opened = remember(key, row, sources.isEmpty(), offer) { openedDraft(slot, row, sources, offer, display, zone) }
	LaunchedEffect(gatewayId) { ops.refresh(gatewayId) }
	val open = rememberEdit(ops.edits, key, automationStanding(state.gateways, gatewayId, home, lookup), opened) { standing ->
		AssistantPageScaffold("Automation", onBack) {
			val line = when {
				slot == AutomationSlot.New -> "This Gateway has nothing an automation could start from."
				standing == EditStanding.READY -> "This automation is not edited here."
				else -> waitingLine(standing)
			}
			line?.let { Text(it, style = MaterialTheme.typography.bodyLarge) } ?: CircularProgressIndicator()
		}
	} ?: return
	val session = open.session
	// Rebase or Back replaces typing.
	val typed = remember(key, open.opening, session.draft.revision, session.draft.text) {
		MirroredDraft(session.draft) { next -> ops.edits.edit(key, open.opening) { next } }
	}
	var draft by typed

	val fields = SourceFields(sources.find { it.id == draft.source }?.fieldSpecs.orEmpty())
	val gone = lookup == Lookup.Gone
	val busy = session.busy
	val can = automationEditing(slot, draft, fields, triggerOffered(draft, sources, offer), busy, gone, offer, display)
	val trigger = askedTrigger(draft, fields, sources, offer, display)
	val triggerRead = previewRead(ops, gatewayId, trigger, null)
	var confirmingDelete by remember(key) { mutableStateOf(false) }
	var asking by remember(key) { mutableStateOf<AutomationSaid.Confirm?>(null) }
	LaunchedEffect(busy, session.said) { asking = (session.said as? AutomationSaid.Confirm)?.takeUnless { busy } }

	fun send(deleting: Boolean, op: suspend (AutomationDraft) -> AutomationSaved) {
		repo.command { automationOps.send(key, open.opening, deleting, op) }
	}

	fun save(confirmed: Boolean) = send(deleting = false) { sent ->
		fittingAutomation(sent, fields, offer, display)?.let { ops.save(gatewayId, sent.id, it, sent.revision, confirmed) }
			?: AutomationSaved.Refused("Not a complete automation")
	}

	val edit: ((AutomationDraft) -> AutomationDraft) -> Unit = { change -> draft = change(draft) }

	val ref = draft.text
	val shownText = ref?.let { textAt(draft, it) }
	if (ref != null && shownText != null) {
		val consoles by repo.liveConsoleOps.state.collectAsState()
		val console = consoles[gatewayId]
		LaunchedEffect(gatewayId) { repo.command { liveConsoleOps.open(gatewayId) } }
		val names = triggerRead.answer?.names.orEmpty()
		HoleTextEditor(
			title = textLabel(ref),
			value = shownText,
			max = textMax(ref),
			names = names,
			preview = textPreviewOf(shownText, trigger != null, previewRead(ops, gatewayId, trigger.takeIf { hasHole(shownText) }, previewText(shownText))),
			refused = refusedHole(session.said, ref.action, ref.param),
			description = console?.description,
			ids = console?.ids,
			shapes = nameShapes(names, fields.fields),
			enabled = can.edit,
			onChange = { text -> edit { it.withAction(ref.action) { held -> withText(held, ref.param, text) } } },
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
		TriggerSection(draft, offer, sources, fields, display, zone, can.edit, triggerRead, edit)

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
		session.said?.takeIf { it !is AutomationSaid.Hole }?.let {
			Text(it.line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
		}
	}

	if (confirmingDelete) {
		ConfirmDialog(
			title = "Delete this automation?",
			body = null,
			confirmText = "Delete",
			onConfirm = {
				confirmingDelete = false
				send(deleting = true) { sent -> ops.delete(gatewayId, sent.id, sent.revision, moves = sent.trigger is TriggerDraft.Event) }
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
