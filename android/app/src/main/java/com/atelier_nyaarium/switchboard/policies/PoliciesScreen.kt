package com.atelier_nyaarium.switchboard.policies

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.NewOnGatewayFab
import com.atelier_nyaarium.switchboard.hapticClick
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import kotlinx.coroutines.launch

@Composable
fun PoliciesScreen(
	repo: ChatRepository,
	state: ChatState,
	onEdit: (String, String?) -> Unit,
	modifier: Modifier = Modifier,
) {
	LaunchedEffect(state.gateways.incarnations()) { repo.policyOps.refreshAll() }
	val scope = rememberCoroutineScope()
	val groups = state.gateways.gateways.filter { it.policies != null }
	val named = groups.size > 1
	val toggleRefusals by repo.policyOps.toggleRefusals
	val vaultRevision by repo.vault.revision
	val entries = remember(vaultRevision) { repo.vaultOps.views() }

	Box(modifier.fillMaxSize()) {
		if (groups.all { it.policies.orEmpty().isEmpty() }) {
			Column(
				Modifier.fillMaxSize().padding(24.dp),
				verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
				horizontalAlignment = Alignment.CenterHorizontally,
			) {
				// Refused is hidden, so empty is not broken.
				Text(
					if (state.gateways.loaded) "No policies" else "No roster yet",
					style = MaterialTheme.typography.titleMedium,
				)
			}
		} else {
			LazyColumn(
				modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
				verticalArrangement = Arrangement.spacedBy(10.dp),
				contentPadding = PaddingValues(top = 12.dp, bottom = 88.dp),
			) {
				for (group in groups) {
					// Named only with several gateways.
					if (named) {
						item(key = "gateway:${group.id}") {
							Text(
								group.id,
								style = MaterialTheme.typography.labelLarge,
								modifier = Modifier.padding(top = 6.dp),
							)
						}
					}
					for (policy in group.policies.orEmpty()) {
						item(key = "policy:${group.id}:${policy.id}") {
							PolicyRow(
								policy = policy,
								binding = bindingLine(policy, entries, group.id),
								toggleRefusal = toggleRefusals[group.id to policy.id],
								onEdit = { onEdit(group.id, policy.id) },
								onEnable = { on ->
									scope.launch {
										repo.policyOps.setEnabled(policy.id, on, policy.revision, group.id)
									}
								},
							)
						}
					}
				}
			}
		}
		NewOnGatewayFab(
			registry = state.gateways,
			description = "New policy",
			onNew = { onEdit(it, null) },
			modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
		)
	}
}

/** The bound secret, and whether usable here. */
internal fun bindingLine(policy: AuthorizationPolicy, entries: List<VaultEntryView>, gatewayId: String): String {
	val entry = entries.firstOrNull { it.id == policy.binding.entryId }
		?: return "${policy.binding.entryId} is not in the vault"
	if (!entry.allowedOn(gatewayId)) return "${entry.title} is not allowed on $gatewayId"
	return entry.title
}

@Composable
private fun PolicyRow(
	policy: AuthorizationPolicy,
	binding: String,
	toggleRefusal: String?,
	onEdit: () -> Unit,
	onEnable: (Boolean) -> Unit,
) {
	Card(Modifier.fillMaxWidth().clickable(onClick = hapticClick(onEdit))) {
		Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
			Row(
				Modifier.fillMaxWidth(),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Column(Modifier.weight(1f)) {
					Text(policy.name, style = MaterialTheme.typography.titleMedium)
					Text(
						binding,
						style = MaterialTheme.typography.bodySmall,
						maxLines = 1,
						overflow = TextOverflow.Ellipsis,
					)
				}
				Switch(checked = policy.enabled, onCheckedChange = onEnable)
			}
			Text(
				policy.selectorKeys.joinToString("   "),
				style = MaterialTheme.typography.bodySmall,
				fontFamily = FontFamily.Monospace,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 2,
				overflow = TextOverflow.Ellipsis,
			)
			toggleRefusal?.let {
				OutlinedCard(Modifier.fillMaxWidth()) {
					Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall)
				}
			}
		}
	}
}
