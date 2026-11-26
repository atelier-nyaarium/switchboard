package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

internal const val NOTICES_MAX = 5

/** A dismissible failure; `team` names its conversation. */
data class Notice(val id: Long, val text: String, val key: String? = null, val team: String? = null)

/** A held key, or the same unkeyed line, is replaced; past the cap the oldest goes. */
internal fun raiseNotice(held: List<Notice>, text: String, key: String? = null, team: String? = null): List<Notice> {
	val id = (held.maxOfOrNull { it.id } ?: 0L) + 1
	val kept = held.filterNot { if (key == null) it.key == null && it.text == text && it.team == team else it.key == key }
	return (kept + Notice(id, text, key, team)).takeLast(NOTICES_MAX)
}

internal fun ChatState.withNotice(text: String, key: String? = null, team: String? = null): ChatState =
	copy(notices = raiseNotice(notices, text, key, team))

/** A later success of the same act. */
internal fun ChatState.withoutNoticeKey(key: String): ChatState =
	if (notices.none { it.key == key }) this else copy(notices = notices.filterNot { it.key == key })

internal fun ChatState.withoutNotice(id: Long): ChatState = copy(notices = notices.filterNot { it.id == id })

private const val PRESENCE_FAULT_KEY = "presence"

/** A prompt the phone could not show is told; one that passes clears it. */
internal fun ChatState.presenceFault(fault: Boolean): ChatState =
	if (fault) withNotice(Line.PRESENCE_FAULT.text, PRESENCE_FAULT_KEY) else withoutNoticeKey(PRESENCE_FAULT_KEY)

/** Only a prompt that was shown and passed clears it. */
internal fun ChatState.promptAnswered(answer: OwnerPrompt): ChatState = when (answer) {
	OwnerPrompt.PASSED -> presenceFault(false)
	OwnerPrompt.COULD_NOT_ASK -> presenceFault(true)
	OwnerPrompt.REFUSED, OwnerPrompt.NO_SCREEN_LOCK -> this
}

/** A cardless caller's prompt. Null: nothing asked. */
internal suspend fun MutableStateFlow<ChatState>.asked(ask: suspend () -> OwnerPrompt?): Boolean {
	val answer = ask() ?: return true
	update { it.promptAnswered(answer) }
	return passes(answer)
}

internal data class NoticeLine(val id: Long, val text: String)

/** Elsewhere a notice names its session. */
internal fun noticeLines(notices: List<Notice>, here: String?, labelOf: (String) -> String): List<NoticeLine> =
	notices.map { notice ->
		val team = notice.team
		NoticeLine(notice.id, if (team == null || team == here) notice.text else "${labelOf(team)}: ${notice.text}")
	}

internal fun showsClearAll(count: Int): Boolean = count > 2

/** Which surface draws the notices. */
enum class NoticeHost { THREAD, SHELL, NONE }

internal fun noticeHost(drawn: Drawn, editorShown: Boolean): NoticeHost = when (drawn) {
	Drawn.Lock -> NoticeHost.NONE
	is Drawn.Conversation -> if (drawn.view == ConversationView.CHAT && !editorShown) NoticeHost.THREAD else NoticeHost.SHELL
	Drawn.Boot, Drawn.Overlay, is Drawn.Settings, is Drawn.Page, is Drawn.Root -> NoticeHost.SHELL
}

/** The conversation a shell host sits over. */
internal fun noticeHere(drawn: Drawn): String? = (drawn as? Drawn.Conversation)?.team

/** Where the drawn screen wants its notices, and the conversation it is. */
data class NoticeAt(val host: NoticeHost, val here: String?) {
	companion object {
		val NONE = NoticeAt(NoticeHost.NONE, null)
	}
}

internal fun noticeAt(drawn: Drawn, editorShown: Boolean): NoticeAt = NoticeAt(noticeHost(drawn, editorShown), noticeHere(drawn))

/** The shell's strip; empty draws no strip. */
internal fun shellNoticeLines(notices: List<Notice>, at: NoticeAt, labelOf: (String) -> String): List<NoticeLine> =
	if (at.host == NoticeHost.SHELL) noticeLines(notices, at.here, labelOf) else emptyList()

internal fun ChatRepository.dismissNotice(id: Long) = _state.update { it.withoutNotice(id) }

internal fun ChatRepository.clearNotices() = _state.update { it.copy(notices = emptyList()) }
