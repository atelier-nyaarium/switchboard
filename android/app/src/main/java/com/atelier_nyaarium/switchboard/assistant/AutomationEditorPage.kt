package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.ScrollState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.atelier_nyaarium.switchboard.AutomationDraftKey
import com.atelier_nyaarium.switchboard.AutomationOps
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConfirmDialog
import com.atelier_nyaarium.switchboard.EditorScaffold
import com.atelier_nyaarium.switchboard.Lookup
import com.atelier_nyaarium.switchboard.MirroredDraft
import com.atelier_nyaarium.switchboard.MenuAction
import com.atelier_nyaarium.switchboard.RemoveMenu
import com.atelier_nyaarium.switchboard.RunKey
import com.atelier_nyaarium.switchboard.assistantGateway
import com.atelier_nyaarium.switchboard.deleteTakesLine
import com.atelier_nyaarium.switchboard.foundRow
import com.atelier_nyaarium.switchboard.homeDisplayUnit
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.rememberEdit
import kotlinx.coroutines.delay

private const val PREVIEW_DEBOUNCE_MS = 400L

/** Debounced preview. */
@Composable
internal fun previewRead(ops: AutomationOps, gatewayId: String, ask: ConsoleOp.AutomationPreview?): PreviewRead {
	var read by remember(gatewayId) { mutableStateOf(PreviewRead()) }
	LaunchedEffect(gatewayId, ask) {
		read = PreviewRead()
		val asked = ask ?: return@LaunchedEffect
		delay(PREVIEW_DEBOUNCE_MS)
		val answer = ops.preview(gatewayId, asked)
		read = PreviewRead(answer, failed = answer == null)
	}
	return read
}

/** Debounced check; retain answer. */
@Composable
internal fun checkRead(ops: AutomationOps, key: AutomationDraftKey, op: ConsoleOp.AutomationSave?): CheckRead {
	var read by remember(key) { mutableStateOf(CheckRead()) }
	LaunchedEffect(key, op) {
		val asked = op ?: return@LaunchedEffect
		delay(PREVIEW_DEBOUNCE_MS)
		read = checkAfter(read, asked, ops.check(key.gatewayId, asked))
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
	val runStates by ops.runs.collectAsState()
	val runState = held?.let { runStates[RunKey(gatewayId, it.id)] }
	// Rebase or Back replaces typing.
	val typed = remember(key, open.opening, mirrorKey(session.draft), ops.edits.page(session.draft)) {
		MirroredDraft(session.draft) { next -> ops.edits.edit(key, open.opening) { next } }
	}
	var draft by typed
	val editorScroll = remember(key, open.opening) { ScrollState(0) }
	val heard = context.over(draft.context)
	val offer = heard.offer
	val sources = heard.sources

	val fields = fieldsOf(draft, sources)
	val gone = lookup == Lookup.Gone
	val busy = session.busy
	val rows = automationGroups(state.gateways, state.assistantHome).firstOrNull { it.gatewayId == gatewayId }?.rows.orEmpty()
	val checkOp = functionSaveOf(draft, fields, offer, confirmed = true)?.takeUnless { errorsRefused(draft, offer) }
	val check = checkRead(ops, key, checkOp)
	val checkSaid = checkSaidOf(checkedFor(check, checkOp), draft, heard)
	val drawn = checkIssuesOf(check, checkOp, draft, offer)
	val said = checkSaid ?: session.said
	val can = automationEditing(
		slot,
		draft,
		fields,
		triggerOffered(draft, sources, offer),
		busy,
		gone,
		offer,
		checkSaid = checkSaid,
		said = session.said,
	)
	val trigger = askedTrigger(draft, fields, sources, offer)
	val pointing = draft.runsDraft() as? RunsDraft.Pointing
	val previewScope = functionPreviewScopeOf(draft.runsDraft())
	val triggerRead = previewRead(ops, gatewayId, previewAsk(trigger, null, previewScope))
	var confirmingDelete by remember(key) { mutableStateOf(false) }
	var asking by remember(key) { mutableStateOf<AutomationSaid.Confirm?>(null) }
	var askingErrors by remember(key) { mutableStateOf<ErrorsAsk?>(null) }
	LaunchedEffect(busy, session.said) { asking = (session.said as? AutomationSaid.Confirm)?.takeUnless { busy } }

	fun save(confirmed: Boolean) = repo.command { automationOps.commit(key, open.opening, confirmed) }

	val edit: ((AutomationDraft) -> AutomationDraft) -> Unit = { change -> draft = change(draft) }

	ScriptParses(ops, gatewayId, draft, offer, edit)
	val functions = offer.functions
	if (draft.picking && functions != null) {
		val pointed = (draft.runs as? RunsHead.Points)?.pointing?.functionId
		FunctionPicker(
			subtitle = pickerSubtitle(draft.trigger, session.opened.trigger, lookup?.let(::foundRow)?.sentence),
			choices = pickerChoices(givenOf(draft, fields), functions.rows, measureOf(draft), current = pointed),
			onBack = { edit { it.copy(picking = false) } },
			onFresh = { edit { it.freshBody() } },
			onPick = { choice -> edit { it.pointedTo(choice.function, offer) } },
		)
		return
	}
	val runs = runsView(draft, fields, offer, rows, said, check, drawn)

	val ref = draft.text
	val textOf = ref?.let { textParam(draft, it, offer) }
	val shownText = ref?.let { textAt(draft, it, offer) }
	val shownCondition = ref?.let { conditionAt(draft, it) }
	val shownExpression = ref?.let { expressionAt(draft, it) }
	if (ref != null && (shownCondition != null || shownExpression != null || (textOf != null && shownText != null))) {
		val consoles by repo.liveConsoleOps.state.collectAsState()
		val console = consoles[gatewayId]
		LaunchedEffect(gatewayId) { repo.command { liveConsoleOps.open(gatewayId) } }
		val pageScope = scopeAt(draft, ref.key)
		val names = namesAt(draft, offer, ref.key, triggerRead.answer?.names)
		val cards = draft.stepsOf(draft.treeHolding(ref.key))
		if (shownCondition != null) {
			val here = names + variablesHere(cards, ref.key)
			val read = previewRead(ops, gatewayId, conditionAsk(trigger, shownCondition, pageScope, cards))
			val shown = conditionSaidOf(shownCondition, trigger != null, read)
			val refused = refusedPlaceholder(said, ref.key, CONDITION, shownCondition)
			TextPageEditor(
				title = "Condition",
				value = shownCondition,
				max = Protocol.Wire.STEP_TEXT_MAX,
				names = here,
				mode = TextMode.EXPRESSION,
				issueOf = { text -> conditionSpan(text, shown, refused) },
				description = console?.description,
				ids = console?.ids,
				shapes = nameShapes(here, fields.fields),
				enabled = can.edit,
				onChange = { text -> edit { it.withStep(ref.key) { held -> (held as? StepDraft.If)?.copy(condition = text) ?: held } } },
				onBack = { edit { it.copy(text = null) } },
			) { text -> ConditionSaidBlock(text, shown, refused) }
			return
		}
		if (shownExpression != null) {
			val here = names + variablesHere(cards, ref.key)
			val refused = refusedPlaceholder(said, ref.key, ref.param, shownExpression.text)
			TextPageEditor(
				title = shownExpression.title,
				value = shownExpression.text,
				max = Protocol.Wire.STEP_TEXT_MAX,
				names = here,
				mode = TextMode.EXPRESSION,
				issueOf = { text -> expressionSpan(text, refused) },
				description = console?.description,
				ids = console?.ids,
				shapes = nameShapes(here, fields.fields),
				enabled = can.edit,
				onChange = { text -> edit { it.withExpression(ref, text) } },
				onBack = { edit { it.copy(text = null) } },
			) { text -> IssueLine(refused?.let { placeholderLine(text, it.line, it.start, it.end) }) }
			return
		}
		if (textOf != null && shownText != null) {
			val read = previewRead(ops, gatewayId, previewAsk(trigger.takeIf { hasPlaceholder(shownText) }, previewText(shownText), pageScope))
			val preview = textPreviewOf(shownText, trigger != null, read)
			val refused = refusedPlaceholder(said, ref.key, ref.param, shownText)
			TextPageEditor(
				title = textOf.label,
				value = shownText,
				max = textOf.max ?: Int.MAX_VALUE,
				names = names,
				mode = TextMode.TEMPLATE,
				issueOf = { text -> refusedSpan(text, preview, refused) },
				description = console?.description,
				ids = console?.ids,
				shapes = nameShapes(names, fields.fields),
				enabled = can.edit,
				onChange = { text -> edit { it.withAction(ref.key) { held -> withValue(held, ref.param, text) } } },
				onBack = { edit { it.copy(text = null) } },
			) { text -> TextPreviewBlock(text, preview, refused) }
			return
		}
	}

	draft.scriptPage?.let { page ->
		val consoles by repo.liveConsoleOps.state.collectAsState()
		LaunchedEffect(gatewayId) { repo.command { liveConsoleOps.open(gatewayId) } }
		ScriptEditorPage(ops, gatewayId, draft, page.tree, offer, can.edit, consoles[gatewayId]?.ids, edit)
		return
	}

	val textRead: @Composable (String?) -> PreviewRead = { text -> previewRead(ops, gatewayId, previewAsk(trigger.takeIf { text != null }, text, previewScope)) }
	val conditionRead: @Composable (String) -> PreviewRead = { condition ->
		previewRead(ops, gatewayId, conditionAsk(trigger, condition, previewScope, draft.steps))
	}
	val reload: (String) -> Unit = { id -> repo.command { automationOps.reloadFunction(key, open.opening, id) } }
	draft.inside.lastOrNull()?.let { draft.callees[it] }?.let { callee ->
		// Arguments arrive at run time.
		val scope = calleePreviewScope(callee)
		CalleePage(
			callee,
			draft,
			offer,
			fields,
			can.edit,
			said,
			textRead = { text -> previewRead(ops, gatewayId, previewAsk(trigger.takeIf { text != null }, text, scope)) },
			conditionRead = { condition -> previewRead(ops, gatewayId, conditionAsk(trigger, condition, scope, callee.steps)) },
			asked = trigger != null,
			edit = edit,
			reload = reload,
			rows = rows,
			scriptOnly = scriptOnlyCards(ops, gatewayId, draft, callee.id, offer, edit),
			issues = drawn,
		) { ScriptSection(ops, gatewayId, draft, callee.id, offer, can.edit, null, edit) }
		return
	}

	EditorScaffold(
		title = if (gone) "Deleted elsewhere." else "Automation",
		saving = busy,
		canSave = can.save,
		onSave = { errorsAsk(draft, offer, rows)?.let { askingErrors = it } ?: save(confirmed = false) },
		onBack = onBack,
		leaving = open.leaving,
		menu = {
			if (slot is AutomationSlot.Held) {
				val run = MenuAction("Run now", runOffered(slot, gone, draft, session.opened, busy, runState)) {
					repo.command { automationOps.run(gatewayId, slot.id, open.opening) }
				}
				RemoveMenu("Delete automation", enabled = can.delete, actions = listOf(run)) { confirmingDelete = true }
			}
		},
		scrollState = editorScroll,
	) {
		Text("When", style = MaterialTheme.typography.labelLarge)
		TriggerSection(draft, offer, sources, fields, zone, can.edit, triggerRead, edit)

		HorizontalDivider()
		Text("Do", style = MaterialTheme.typography.labelLarge)
		runShown(runState, open.opening)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
		droppedLine(droppedEdits(draft, offer))?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
		runs?.let {
			RunsBlock(it, offer, can.edit, edit) { reloadable(draft.runsDraft())?.let(reload) }
		}
		if (holdsUnserved(draft.steps, offer)) {
			Text("This Gateway cannot run some of these steps.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
		}
		if (runs?.unlisted != true) {
			val lastRun = lastRunShown(draft, session.opened, lookup?.let(::foundRow), offer.functions)
			ScriptSwitch(draft, null, offer, can.edit, edit)
			if (showsScript(draft, null, offer)) {
				ScriptSection(ops, gatewayId, draft, null, offer, can.edit, lastRun, edit)
			} else {
				val scriptOnly = scriptOnlyCards(ops, gatewayId, draft, null, offer, edit)
				CardsSection(
					draft = draft,
					offer = offer,
					fields = fields,
					enabled = can.edit,
					said = said,
					textRead = textRead,
					conditionRead = conditionRead,
					asked = trigger != null,
					lastRun = lastRun,
					edit = edit,
					reload = reload,
					scriptLines = scriptOnly.lines,
					onScriptAt = scriptOnly.open,
					issues = drawn,
				)
			}
		}
		HorizontalDivider()
		OutlinedTextField(
			value = draft.retryForMin,
			onValueChange = { typed -> edit { it.copy(retryForMin = typed) } },
			label = { Text("Retry for") },
			placeholder = { Text("${Protocol.Wire.RETRY_FOR_MIN_DEFAULT}") },
			suffix = { Text("min") },
			singleLine = true,
			enabled = can.edit,
			keyboardOptions = NUMBER_KEYS,
			modifier = Modifier.fillMaxWidth(),
		)
		IssueLine(settingsIssue(draft))
		generalLine(said, draft, offer)?.let {
			val color = if (saidRefuses(said)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
			Text(it, style = MaterialTheme.typography.bodySmall, color = color)
		}
	}

	if (confirmingDelete) {
		ConfirmDialog(
			title = "Delete this automation?",
			body = lookup?.let(::foundRow)?.let { automationDeleteTakes(it, functions?.rows) }?.let(::deleteTakesLine),
			confirmText = "Delete",
			onConfirm = {
				confirmingDelete = false
				repo.command { automationOps.remove(key, open.opening) }
			},
			onDismiss = { confirmingDelete = false },
		)
	}
	askingErrors?.let { ask ->
		ConfirmDialog(
			title = "Save with errors?",
			body = errorsLine(ask),
			confirmText = "Save anyway",
			onConfirm = {
				askingErrors = null
				save(confirmed = false)
			},
			onDismiss = { askingErrors = null },
		)
	}
	asking?.let { confirm ->
		ConfirmDialog(
			title = "Confirm what it does",
			body = confirmBody(confirm.labels),
			confirmText = "Allow",
			onConfirm = {
				asking = null
				save(confirmed = true)
			},
			onDismiss = { asking = null },
		)
	}
}
