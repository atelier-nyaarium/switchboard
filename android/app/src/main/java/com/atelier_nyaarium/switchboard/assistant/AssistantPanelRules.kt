package com.atelier_nyaarium.switchboard.assistant

import android.text.InputType
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.SummonLanding
import com.atelier_nyaarium.switchboard.assistantGateway
import com.atelier_nyaarium.switchboard.assistantRoot
import com.atelier_nyaarium.switchboard.summonLanding

////////////////////////////////
//  Showing

/** What a press of the assistant key does when the panel is the assistant. */
internal sealed interface PanelShow {
	/** Today's summon in the app: nothing draws over the keyguard or the app lock. */
	data object HandOff : PanelShow

	data class Show(val team: String) : PanelShow
}

internal fun panelShow(keyguardLocked: Boolean, appLockAsks: Boolean, team: String?): PanelShow = when {
	keyguardLocked || appLockAsks || team == null -> PanelShow.HandOff
	else -> PanelShow.Show(team)
}

/** The conversation the app's summon would land on; null hands off. */
internal fun panelTeam(state: ChatState): String? =
	(summonLanding(state, assistantRoot(state), assistantGateway(state)) as? SummonLanding.At)?.team

////////////////////////////////
//  Share screen

internal enum class ScreenChip { NONE, OFFER, ATTACHED }

/** No chip when the system shared nothing, as for `FLAG_SECURE` or the settings off. */
internal fun screenChip(hasScreenshot: Boolean, hasText: Boolean, attached: Boolean): ScreenChip = when {
	!hasScreenshot && !hasText -> ScreenChip.NONE
	attached -> ScreenChip.ATTACHED
	else -> ScreenChip.OFFER
}

/** A plain projection of an `AssistStructure` node, so the rules run on the JVM. */
internal data class AssistNode(
	val text: String? = null,
	/** Read off the full text, which [text] may hold only part of. */
	val textPresent: Boolean = !text.isNullOrBlank(),
	val hint: Boolean = false,
	val contentDescription: Boolean = false,
	val idEntry: Boolean = false,
	val className: Boolean = false,
	val autofillHints: Boolean = false,
	val autofillValue: Boolean = false,
	val webDomain: Boolean = false,
	val htmlInfo: Boolean = false,
	val password: Boolean = false,
	val children: List<AssistNode> = emptyList(),
)

internal data class AssistWindow(val titled: Boolean, val root: AssistNode)

internal const val SCREEN_TEXT_MAX_CHARS = 50_000

/** The text another app showed, in tree order, password fields left out. */
internal fun screenText(windows: List<AssistWindow>): String {
	val lines = mutableListOf<String>()
	fun walk(node: AssistNode) {
		if (!node.password) node.text?.trim()?.takeIf { it.isNotEmpty() && it != lines.lastOrNull() }?.let(lines::add)
		node.children.forEach(::walk)
	}
	windows.forEach { walk(it.root) }
	return lines.joinToString("\n").take(SCREEN_TEXT_MAX_CHARS)
}

internal fun isPasswordInput(inputType: Int): Boolean {
	val variation = inputType and InputType.TYPE_MASK_VARIATION
	return when (inputType and InputType.TYPE_MASK_CLASS) {
		InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
			variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
			variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
		InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
		else -> false
	}
}

////////////////////////////////
//  Probe

/** Counts only: no text, package, activity or key leaves the phone. */
internal data class StructureShape(
	val windows: Int,
	val titledWindows: Int,
	val nodes: Int,
	val withText: Int,
	val withHint: Int,
	val withContentDescription: Int,
	val withIdEntry: Int,
	val withClassName: Int,
	val withAutofillHints: Int,
	val withAutofillValue: Int,
	val withWebDomain: Int,
	val withHtmlInfo: Int,
	val passwords: Int,
	val passwordsWithText: Int,
)

internal fun structureShape(windows: List<AssistWindow>): StructureShape {
	val all = mutableListOf<AssistNode>()
	fun walk(node: AssistNode) {
		all += node
		node.children.forEach(::walk)
	}
	windows.forEach { walk(it.root) }
	return StructureShape(
		windows = windows.size,
		titledWindows = windows.count { it.titled },
		nodes = all.size,
		withText = all.count { it.textPresent },
		withHint = all.count { it.hint },
		withContentDescription = all.count { it.contentDescription },
		withIdEntry = all.count { it.idEntry },
		withClassName = all.count { it.className },
		withAutofillHints = all.count { it.autofillHints },
		withAutofillValue = all.count { it.autofillValue },
		withWebDomain = all.count { it.webDomain },
		withHtmlInfo = all.count { it.htmlInfo },
		passwords = all.count { it.password },
		passwordsWithText = all.count { it.password && it.textPresent },
	)
}

/** What one assist delivered, in counts and booleans only. */
internal data class AssistContentFacts(
	val webUri: Boolean,
	val intent: Boolean,
	val structuredData: Boolean,
	val clipData: Boolean,
	val bundleKeys: Int,
)

internal fun assistFacts(windows: List<AssistWindow>, content: AssistContentFacts): Map<String, Any> =
	structureShape(windows).facts() + windowFacts(windows) + linkedMapOf(
		"webUri" to content.webUri,
		"intent" to content.intent,
		"structuredData" to content.structuredData,
		"clipData" to content.clipData,
		"bundleKeys" to content.bundleKeys,
	)

/** Per window, up to [PROBED_WINDOWS]: its title's presence and its node count. */
internal fun windowFacts(windows: List<AssistWindow>): Map<String, Any> = buildMap {
	windows.take(PROBED_WINDOWS).forEachIndexed { i, window ->
		put("window${i}Titled", window.titled)
		put("window${i}Nodes", nodeCount(window.root))
	}
}

internal const val PROBED_WINDOWS = 8

private fun nodeCount(node: AssistNode): Int = 1 + node.children.sumOf(::nodeCount)

/** One ingest line: allowlisted names, each a count, a boolean or a setting state. */
internal fun probeLine(kind: String, facts: Map<String, Any>): String =
	"$kind " + facts.entries.joinToString(" ") { (name, value) -> "$name=$value" }

internal fun StructureShape.facts(): Map<String, Any> = linkedMapOf(
	"windows" to windows,
	"titledWindows" to titledWindows,
	"nodes" to nodes,
	"text" to withText,
	"hint" to withHint,
	"contentDescription" to withContentDescription,
	"idEntry" to withIdEntry,
	"className" to withClassName,
	"autofillHints" to withAutofillHints,
	"autofillValue" to withAutofillValue,
	"webDomain" to withWebDomain,
	"htmlInfo" to withHtmlInfo,
	"passwords" to passwords,
	"passwordsWithText" to passwordsWithText,
)
