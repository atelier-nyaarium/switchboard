package com.atelier_nyaarium.switchboard.assistant

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.ChatRepository
import com.atelier_nyaarium.switchboard.hapticClick
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun AssistantActSheet(repo: ChatRepository, gatewayId: String, requestId: String, onClose: () -> Unit) {
	val pending by repo.assistantActOps.pending.collectAsState()
	val request = pending.firstOrNull { it.gatewayId == gatewayId && it.request.requestId == requestId }
	LaunchedEffect(request == null) { if (request == null) onClose() }
	if (request == null) return
	val activity = LocalContext.current as? FragmentActivity
	val scope = rememberCoroutineScope()
	var steering by remember(gatewayId, requestId) { mutableStateOf(false) }
	var note by remember(gatewayId, requestId) { mutableStateOf("") }
	var busy by remember(gatewayId, requestId) { mutableStateOf(false) }
	var line by remember(gatewayId, requestId) { mutableStateOf<String?>(null) }
	var now by remember(gatewayId, requestId) { mutableLongStateOf(System.currentTimeMillis()) }
	val card = remember(request, now) { assistantActCardText(request.request, now) }
	LaunchedEffect(gatewayId, requestId) {
		while (true) {
			val left = request.request.deadlineAt - System.currentTimeMillis()
			if (left <= 0L) break
			delay(left.coerceAtMost(1_000L))
			now = System.currentTimeMillis()
		}
		repo.assistantActOps.sweepRequests(now)
	}
	val expired = repo.assistantActOps.isExpired(request, now)

	fun answer(decision: String) {
		busy = true
		line = null
		scope.launch {
			when (val result = repo.assistantActOps.answer(request, decision, note, activity)) {
				AssistantActAnswer.Answered, AssistantActAnswer.Expired -> onClose()
				AssistantActAnswer.NeedsOwner -> Unit
				AssistantActAnswer.Unreachable -> line = AssistantActWords.UNREACHABLE
				is AssistantActAnswer.Refused -> line = result.reason
			}
			busy = false
		}
	}

	Dialog(
		onDismissRequest = onClose,
		properties = DialogProperties(dismissOnClickOutside = false, usePlatformDefaultWidth = false),
	) {
		Surface(shape = RoundedCornerShape(28.dp), tonalElevation = 6.dp, modifier = Modifier.fillMaxWidth(0.95f)) {
			Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
				Text(card.title, style = MaterialTheme.typography.titleMedium)
				Text(card.key, style = MaterialTheme.typography.labelLarge)
				Text(card.summary, style = MaterialTheme.typography.bodyMedium)
				Text(
					card.expiry.text,
					style = MaterialTheme.typography.bodySmall,
					color = if (card.expiry.urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
				)
				line?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
				if (steering) {
					OutlinedTextField(value = note, onValueChange = { note = it }, minLines = 2, label = { Text(AssistantActWords.NOTE) })
				}
				if (steering) {
					Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
						TextButton(onClick = hapticClick { steering = false }, enabled = !busy) { Text(AssistantActWords.BACK) }
						Spacer(Modifier.weight(1f))
						Button(onClick = hapticClick { answer("deny") }, enabled = !busy && !expired) { Text(AssistantActWords.DENY) }
					}
				} else {
					Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
						TextButton(onClick = hapticClick { steering = true }, enabled = !busy && !expired) { Text(AssistantActWords.DENY) }
						Spacer(Modifier.weight(1f))
						Button(onClick = hapticClick { answer("approve") }, enabled = !busy && !expired) { Text(AssistantActWords.APPROVE) }
					}
				}
			}
		}
	}
}
