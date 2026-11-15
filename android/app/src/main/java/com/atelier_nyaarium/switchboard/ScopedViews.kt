package com.atelier_nyaarium.switchboard

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.board.BoardDrop
import com.atelier_nyaarium.switchboard.board.BoardRow
import com.atelier_nyaarium.switchboard.board.BoardScreen
import com.atelier_nyaarium.switchboard.board.BoardSessionList
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleScreen
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
		ScopedView.CONSOLE -> ConsoleScreen(repo, state, modifier, scope)
	}
}

/** This session, or everything. */
@Composable
internal fun FilterRow(session: String, filtered: Boolean, onFilter: (Boolean) -> Unit) {
	Column(Modifier.fillMaxWidth()) {
		Row(
			Modifier.fillMaxWidth().padding(horizontal = 12.dp),
			horizontalArrangement = Arrangement.spacedBy(8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			FilterChip(
				selected = filtered,
				onClick = hapticClick { onFilter(!filtered) },
				label = { Text(session, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis) },
				trailingIcon = {
					if (filtered) Icon(Icons.Default.Close, contentDescription = "Clear filter", Modifier.size(FilterChipDefaults.IconSize))
				},
				modifier = Modifier.weight(1f, fill = false),
			)
			FilterChip(selected = !filtered, onClick = hapticClick { onFilter(false) }, label = { Text("Everything") })
		}
		HorizontalDivider()
	}
}
