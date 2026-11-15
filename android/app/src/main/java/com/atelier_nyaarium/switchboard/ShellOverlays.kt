package com.atelier_nyaarium.switchboard

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import com.atelier_nyaarium.switchboard.assistant.AssistantActSheet
import com.atelier_nyaarium.switchboard.assistant.AssistantSendSheet
import com.atelier_nyaarium.switchboard.assistant.AutomationEditorPage
import com.atelier_nyaarium.switchboard.board.BoardEntryDialog
import com.atelier_nyaarium.switchboard.policies.PolicyEditor
import com.atelier_nyaarium.switchboard.routines.RoutineEditor
import com.atelier_nyaarium.switchboard.runbooks.RunbookEditor
import com.atelier_nyaarium.switchboard.runbooks.RunbookFireSheet
import com.atelier_nyaarium.switchboard.vault.VaultEntryDialog
import com.atelier_nyaarium.switchboard.vault.VaultRequestSheet

internal sealed interface VaultModal {
	data class Entry(val id: String?) : VaultModal

	data class Request(val id: String) : VaultModal
}

internal data class RunbookFire(val gatewayId: String, val id: String, val into: String?)

// Not saved: an entry can name key material.
internal data class Modals(
	val board: String? = null,
	val vault: VaultModal? = null,
	val send: Pair<String, String>? = null,
	val act: Pair<String, String>? = null,
	val fire: RunbookFire? = null,
	val forget: ForgetAsking? = null,
) {
	/** Closes each named one only while it is still the one open: a late close leaves its successor. */
	fun without(
		board: String? = null,
		vault: VaultModal? = null,
		send: Pair<String, String>? = null,
		act: Pair<String, String>? = null,
		fire: RunbookFire? = null,
		forget: ForgetAsking? = null,
	): Modals = copy(
		board = this.board.takeUnless { it == board },
		vault = this.vault.takeUnless { it == vault },
		send = this.send.takeUnless { it == send },
		act = this.act.takeUnless { it == act },
		fire = this.fire.takeUnless { it == fire },
		forget = this.forget.takeUnless { it == forget },
	)
}

internal class OverlayRequests(
	val viewer: MutableState<OpenAttachment?>,
	val linkMenu: MutableState<Pair<String, String>?>,
	val linkMenuNote: MutableState<String?>,
	val rowPress: MutableState<RowPress?>,
	val queue: MutableState<Boolean>,
	val revealAt: MutableState<Pair<String, Long>?>,
	val openTeam: MutableState<String?>,
) {
	fun close() {
		viewer.value = null
		linkMenu.value = null
		linkMenuNote.value = null
		rowPress.value = null
		queue.value = false
	}
}

// Nothing draws over the lock.
@Composable
internal fun ShellOverlays(
	locked: Boolean,
	repo: ChatRepository,
	state: ChatState,
	modals: Modals,
	/** Applied to the modals as they stand when it runs, never to a captured copy. */
	onModals: ((Modals) -> Modals) -> Unit,
	editor: ShownEditor?,
	requests: OverlayRequests,
	rendererPool: ThreadRendererPool,
	forgetSession: SessionForget,
	claimsOf: (team: String, rows: List<Message>, left: List<Message>) -> List<CutClaim>,
) {
	if (locked) return
	if (state.wipeUnconfirmed) {
		val close = { repo.domainAdmin.wipeNoticed() }
		AlertDialog(
			onDismissRequest = close,
			title = { Text("Couldn't reach the servers") },
			text = { Text("This device was wiped, but we couldn't confirm the purge. Ask the admin to purge it if it survived.") },
			confirmButton = { TextButton(onClick = hapticClick(close)) { Text("OK") } },
		)
	}
	QueueOverlay(repo, requests.queue, requests.revealAt, requests.openTeam)
	AttachmentViewerOverlay(requests.viewer, rendererPool)
	LinkMenuDialog(requests.linkMenu, requests.linkMenuNote)
	RowMenuDialog(repo, requests.rowPress, claimsOf)
	modals.forget?.let { asking ->
		val close = { onModals { it.without(forget = asking) } }
		ForgetAskDialog(
			ask = asking.ask,
			onStart = { container ->
				forgetSession.startThenForget(asking.team, container, asking.cancelTasks)
				close()
			},
			onForgetAnyway = {
				forgetSession.forget(asking.team, asking.cancelTasks)
				close()
			},
			onDismiss = close,
		)
	}
	modals.board?.let { entryId -> BoardEntryDialog(state, repo, entryId) { onModals { it.without(board = entryId) } } }
	when (val modal = modals.vault) {
		is VaultModal.Entry -> VaultEntryDialog(repo, state, modal.id) { onModals { it.without(vault = modal) } }
		is VaultModal.Request -> VaultRequestSheet(repo, state, modal.id) { onModals { it.without(vault = modal) } }
		null -> {}
	}
	modals.send?.let { request ->
		AssistantSendSheet(repo, request.first, request.second) { onModals { it.without(send = request) } }
	}
	modals.act?.let { request ->
		AssistantActSheet(repo, request.first, request.second) { onModals { it.without(act = request) } }
	}
	modals.fire?.let { fire ->
		RunbookFireSheet(repo, state, fire.gatewayId, fire.id, fire.into) { onModals { it.without(fire = fire) } }
	}
	when (editor) {
		is ShownEditor.Runbook -> RunbookEditor(repo, editor.key.gatewayId, editor.key.id)
		is ShownEditor.Routine -> RoutineEditor(repo, state, editor.key.gatewayId, editor.key.id)
		is ShownEditor.Policy -> PolicyEditor(repo, state, editor.key.gatewayId, editor.key.id)
		is ShownEditor.Automation ->
			AutomationEditorPage(repo, state, editor.key.gatewayId, editor.key.slot) { repo.editors.askLeave() }
		null -> {}
	}
}
