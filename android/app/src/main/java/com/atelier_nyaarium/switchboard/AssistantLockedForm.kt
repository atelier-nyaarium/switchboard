package com.atelier_nyaarium.switchboard

/** Generic safe line. */
internal const val ASSISTANT_GENERIC_LINE = "Assistant update"

/** Locked assistant rows speak LOCKED. */
internal fun spokenTier(assistant: Boolean, locked: Boolean, requested: SttsPlayer.Tier): SttsPlayer.Tier =
	if (assistant && locked) SttsPlayer.Tier.LOCKED else requested

/** Locked surfaces show title, count, or generic text only. */
internal fun lockedLine(msg: Message): String {
	msg.record?.let { record ->
		val count = record.threads.size
		return "Assistant finished $count ${if (count == 1) "item" else "items"}"
	}
	if (msg.fromMe || msg.isPeer) return ASSISTANT_GENERIC_LINE
	return oneLine(msg.title) ?: ASSISTANT_GENERIC_LINE
}
