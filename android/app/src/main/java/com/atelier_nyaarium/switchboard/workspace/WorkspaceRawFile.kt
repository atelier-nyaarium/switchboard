package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.fileLines
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer

/** Lexicon has no part in this road. */
@Composable
internal fun WorkspaceRawFile(
	ops: WindowOps,
	target: WorkspaceTarget,
	path: String,
	modifier: Modifier = Modifier,
) {
	var answer by remember(target.key, path) { mutableStateOf<WorkspaceAnswer<WorkspaceReadAnswer>?>(null) }
	LaunchedEffect(target.key, path) { answer = ops.file(target, path) }

	WorkspaceAnswerBox(answer, modifier) { file ->
		// Lazy, or a long file builds one composable per line before anything is drawn.
		val lines = remember(file) { fileLines(file.text) }
		LazyColumn(Modifier.fillMaxSize().padding(vertical = 8.dp)) {
			items(lines.size, key = { lines[it].number }) { CodeLineRow(lines[it]) }
		}
	}
}
