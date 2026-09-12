package com.atelier_nyaarium.switchboard.workspace

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atelier_nyaarium.switchboard.CodeLine
import com.atelier_nyaarium.switchboard.WindowOps
import com.atelier_nyaarium.switchboard.WorkspaceAnswer
import com.atelier_nyaarium.switchboard.WorkspaceTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceReadAnswer

/** Lexicon has no part in this road, which is the point of it. */
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
		Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
			CodeLines(
				file.text.split("\n").mapIndexed { i, text -> CodeLine(i + 1, text) },
				Modifier.fillMaxWidth().padding(vertical = 8.dp),
			)
		}
	}
}
