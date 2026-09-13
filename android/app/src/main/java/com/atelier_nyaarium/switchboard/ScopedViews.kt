package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.board.BoardDrop
import com.atelier_nyaarium.switchboard.board.BoardRow
import com.atelier_nyaarium.switchboard.board.BoardScreen
import com.atelier_nyaarium.switchboard.board.BoardSessionList
import com.atelier_nyaarium.switchboard.policies.PoliciesScreen
import com.atelier_nyaarium.switchboard.routines.RoutinesScreen
import com.atelier_nyaarium.switchboard.runbooks.RunbooksScreen
import com.atelier_nyaarium.switchboard.vault.VaultScreen

internal class ShellActions(
	val openBoardEntry: (String) -> Unit,
	val moveBoardEntry: (BoardRow, BoardDrop) -> Unit,
	val openVaultEntry: (String?) -> Unit,
	val openVaultRequest: (String) -> Unit,
	/** Runbook fire destination. */
	val fireRunbook: (String, String, String?) -> Unit,
	val editRunbook: (String, String?) -> Unit,
	val editRoutine: (String, String?) -> Unit,
	val editPolicy: (String, String?) -> Unit,
)

@Composable
internal fun ScopedViewBody(
	view: ScopedView,
	scope: ViewScope,
	repo: ChatRepository,
	state: ChatState,
	actions: ShellActions,
	modifier: Modifier = Modifier,
	onBoardSaved: () -> Unit = {},
) {
	val into = (scope as? ViewScope.Session)?.team
	when (view) {
		ScopedView.BACKLOG -> when (scope) {
			ViewScope.Everything -> BoardScreen(
				repo = repo,
				onOpenEntry = actions.openBoardEntry,
				onMoveEntry = actions.moveBoardEntry,
				onSaved = onBoardSaved,
				modifier = modifier,
			)
			is ViewScope.Session -> {
				val revision by repo.boardOps.boardRevision
				val group = remember(scope.team, revision, state.teams) { repo.boardOps.boardGroupFor(scope.team) }
				BoardSessionList(
					group = group,
					revision = revision,
					onOpenEntry = { actions.openBoardEntry(it.entry.id) },
					onMove = actions.moveBoardEntry,
					modifier = modifier,
				)
			}
		}
		ScopedView.RUNBOOKS -> RunbooksScreen(
			repo = repo,
			state = state,
			onFire = { gatewayId, id -> actions.fireRunbook(gatewayId, id, into) },
			onEdit = actions.editRunbook,
			modifier = modifier,
			scope = scope,
		)
		ScopedView.ROUTINES -> RoutinesScreen(repo, state, actions.editRoutine, modifier, scope)
		ScopedView.POLICIES -> PoliciesScreen(repo, state, actions.editPolicy, modifier, scope)
		ScopedView.VAULT -> VaultScreen(
			repo = repo,
			state = state,
			onOpenEntry = actions.openVaultEntry,
			onOpenRequest = actions.openVaultRequest,
			modifier = modifier,
			scope = scope,
		)
	}
}

@Composable
internal fun ScopeRow(view: ScopedView, team: String, onWhole: () -> Unit) {
	val address = remember(team) { addressOf(team) }
	Column(Modifier.fillMaxWidth()) {
		Row(
			Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp),
			horizontalArrangement = Arrangement.spacedBy(8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			scopeChip(view, address)?.let { chip ->
				Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
					Text(
						chip,
						Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
						style = MaterialTheme.typography.labelMedium,
						fontFamily = FontFamily.Monospace,
					)
				}
			}
			Text(
				scopeLine(view),
				Modifier.weight(1f),
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
			TextButton(onClick = hapticClick(onWhole)) { Text(wholeLabel(view)) }
		}
		HorizontalDivider()
	}
}

private fun scopeChip(view: ScopedView, address: com.atelier_nyaarium.switchboard.proto.Address?): String? = when (view) {
	ScopedView.RUNBOOKS, ScopedView.POLICIES -> address?.gateway
	ScopedView.ROUTINES -> address?.spawn
	ScopedView.BACKLOG, ScopedView.VAULT -> null
}

private fun scopeLine(view: ScopedView): String = when (view) {
	ScopedView.BACKLOG -> "This session's tasks"
	ScopedView.RUNBOOKS -> "Fires into this session"
	ScopedView.ROUTINES -> "Starts on this spawn point"
	ScopedView.POLICIES -> "This Gateway"
	ScopedView.VAULT -> "This session's requests and grants"
}

private fun wholeLabel(view: ScopedView): String = when (view) {
	ScopedView.BACKLOG -> "Backlog"
	ScopedView.VAULT -> "All entries"
	ScopedView.RUNBOOKS, ScopedView.ROUTINES, ScopedView.POLICIES -> "All Gateways"
}
