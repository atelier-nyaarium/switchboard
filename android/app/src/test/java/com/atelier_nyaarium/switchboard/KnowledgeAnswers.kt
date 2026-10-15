package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeFacts
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeNote

private val NO_FACTS = WorkspaceKnowledgeFacts(
	members = 0,
	references = 0,
	fanIn = 0,
	fanOut = 0,
	supertypes = 0,
	subtypes = 0,
	comments = 0,
)

internal fun knowledgeOf(
	symbolId: String,
	name: String = "known",
	note: WorkspaceKnowledgeNote? = null,
	documentation: String? = null,
) = WorkspaceKnowledgeAnswer(
	symbolId = symbolId,
	name = name,
	symbolKind = "function",
	module = "src/a.ts",
	note = note,
	facts = NO_FACTS,
	documentation = documentation,
)
