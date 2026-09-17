package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.AskOps
import com.atelier_nyaarium.switchboard.AskOutcome
import com.atelier_nyaarium.switchboard.AskScope
import com.atelier_nyaarium.switchboard.AskSelection
import com.atelier_nyaarium.switchboard.AskSubject
import com.atelier_nyaarium.switchboard.AskedKey
import com.atelier_nyaarium.switchboard.Include
import com.atelier_nyaarium.switchboard.RequestState
import com.atelier_nyaarium.switchboard.ScopeKey
import com.atelier_nyaarium.switchboard.ScopeState
import com.atelier_nyaarium.switchboard.askOffer
import com.atelier_nyaarium.switchboard.askOutcome
import com.atelier_nyaarium.switchboard.canSend
import com.atelier_nyaarium.switchboard.countText
import com.atelier_nyaarium.switchboard.defaultSelection
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.includeRows
import com.atelier_nyaarium.switchboard.listedScope
import com.atelier_nyaarium.switchboard.offerText
import com.atelier_nyaarium.switchboard.questionChips
import com.atelier_nyaarium.switchboard.readTarget
import com.atelier_nyaarium.switchboard.requestKey
import com.atelier_nyaarium.switchboard.scopeLabel
import com.atelier_nyaarium.switchboard.scopeNote
import com.atelier_nyaarium.switchboard.scopeRoot
import com.atelier_nyaarium.switchboard.scopeState
import com.atelier_nyaarium.switchboard.selectionForRoot
import com.atelier_nyaarium.switchboard.toggled
import kotlinx.coroutines.launch

private val SELECTION_SAVER = listSaver<AskSelection, Any?>(
	save = { listOf(it.scope.name, it.questions.toList(), it.include.map(Include::name), it.root) },
	restore = {
		AskSelection(
			scope = AskScope.valueOf(it[0] as String),
			questions = (it[1] as List<*>).filterIsInstance<String>().toSet(),
			include = (it[2] as List<*>).filterIsInstance<String>().map(Include::valueOf).toSet(),
			root = it[3] as String?,
		)
	},
)

/**
 * One Ask, whatever it covers: the scope, the questions, and what to include. The counts are what
 * the owner checks, so there is no preview of the message they send.
 *
 * No back handler: the sheet dismisses through its own window.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AskSheet(ops: AskOps, subject: AskSubject, openedOn: String?, onClose: () -> Unit) {
	val scope = rememberCoroutineScope()
	val views by ops.scopeViews.collectAsState()
	val sends by ops.store.sends.collectAsState()
	val requests by ops.requestStates.collectAsState()
	var selection by rememberSaveable(openedOn, stateSaver = SELECTION_SAVER) {
		mutableStateOf(defaultSelection(openedOn))
	}
	var notice by remember { mutableStateOf<String?>(null) }

	val membersKey = remember(subject) { ScopeKey(subject.target, readTarget(subject, AskScope.MEMBERS), false) }
	val fileKey = remember(subject) { ScopeKey(subject.target, readTarget(subject, AskScope.FILE), false) }
	val selectedKey = remember(subject, selection.scope, selection.include) {
		ScopeKey(subject.target, readTarget(subject, selection.scope), Include.LOCALS in selection.include)
	}
	LaunchedEffect(membersKey) { ops.keepScope(membersKey) }
	LaunchedEffect(fileKey) { ops.keepScope(fileKey) }
	LaunchedEffect(selectedKey) { ops.keepScope(selectedKey) }
	LaunchedEffect(selection) { notice = null }

	val members = listedScope(views, membersKey)
	val file = listedScope(views, fileKey)
	val selectedState = scopeState(views[selectedKey]?.read?.answer)
	val selected = (selectedState as? ScopeState.Listed)?.answer
	LaunchedEffect(members?.root, file?.root, selection.scope) {
		scopeRoot(members?.root, file?.root, selection.scope)?.let { selection = selectionForRoot(selection, it) }
	}
	val offer = remember(members, file, selected, selection, sends) {
		askOffer(members, file, selected, subject, selection) { id, question ->
			selection.root?.let { ops.store.outstanding(AskedKey(subject.target.address, it, id, question)) } == true
		}
	}
	val sending = selection.root?.let { requests[requestKey(subject, it, selection.scope)] } == RequestState.SENDING
	val notRead = (selectedState as? ScopeState.NotRead)?.state

	// Half open clips the button away.
	ModalBottomSheet(onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(true)) {
		Column(
			Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Column {
				Text("Ask", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
				Text(
					subject.name,
					style = MaterialTheme.typography.labelSmall,
					fontFamily = FontFamily.Monospace,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			if (notRead != null) {
				FacetNotice(notRead)
			} else {
				// The summary and the button are what a send is checked against, so they never scroll away.
				Column(
					Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
					verticalArrangement = Arrangement.spacedBy(12.dp),
				) {
					SheetLabel("Scope")
					SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
						AskScope.entries.forEachIndexed { index, option ->
							SegmentedButton(
								selected = selection.scope == option,
								onClick = hapticClick { selection = selection.copy(scope = option) },
								shape = SegmentedButtonDefaults.itemShape(index = index, count = AskScope.entries.size),
								icon = {},
							) {
								Column(horizontalAlignment = Alignment.CenterHorizontally) {
									Text(scopeLabel(option), style = MaterialTheme.typography.labelMedium, maxLines = 1)
									scopeNote(offer.counts.scopeSymbols[option])?.let {
										Text(
											it,
											style = MaterialTheme.typography.labelSmall,
											color = MaterialTheme.colorScheme.onSurfaceVariant,
											maxLines = 1,
										)
									}
								}
							}
						}
					}
					SheetLabel("Questions")
					FlowRow(
						horizontalArrangement = Arrangement.spacedBy(6.dp),
						verticalArrangement = Arrangement.spacedBy(6.dp),
					) {
						for (chip in questionChips(offer.counts, selection)) {
							FilterChip(
								selected = chip.on,
								onClick = hapticClick {
									selection = selection.copy(questions = toggled(selection.questions, chip.question))
								},
								label = { Text(chip.label, maxLines = 1, softWrap = false) },
							)
						}
					}
					SheetLabel("Include")
					for (row in includeRows(offer.counts, selection)) {
						Row(
							Modifier.fillMaxWidth()
								.clickable(onClick = hapticClick { selection = selection.copy(include = toggled(selection.include, row.include)) }),
							horizontalArrangement = Arrangement.spacedBy(10.dp),
							verticalAlignment = Alignment.CenterVertically,
						) {
							Checkbox(checked = row.on, onCheckedChange = null)
							Text(row.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
							Text(
								countText(row.count),
								style = MaterialTheme.typography.labelMedium,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
							)
						}
					}
				}
				OutlinedCard(Modifier.fillMaxWidth()) {
					Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
						Text(offerText(offer), style = MaterialTheme.typography.titleSmall)
						offer.order?.let {
							Text(
								it,
								style = MaterialTheme.typography.labelSmall,
								fontFamily = FontFamily.Monospace,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
								maxLines = 2,
								overflow = TextOverflow.Ellipsis,
							)
						}
					}
				}
			}
			notice?.let {
				Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
			}
			Button(
				onClick = hapticClick {
					scope.launch {
						when (val outcome = askOutcome(ops.send(subject, selection, offer.pairs))) {
							AskOutcome.Close -> onClose()
							is AskOutcome.Said -> notice = outcome.notice
							// The read that refused landed on this sheet's own showing, which already draws it.
							is AskOutcome.NotRead -> Unit
						}
					}
				},
				modifier = Modifier.fillMaxWidth(),
				enabled = canSend(offer, sending),
			) {
				Text("Send to session")
			}
		}
	}
}

@Composable
private fun SheetLabel(title: String) {
	Text(
		title.uppercase(),
		style = MaterialTheme.typography.labelSmall,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
	)
}
