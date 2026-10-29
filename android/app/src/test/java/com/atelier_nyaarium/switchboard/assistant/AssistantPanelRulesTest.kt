package com.atelier_nyaarium.switchboard.assistant

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantPanelRulesTest {
	@Test
	fun anythingThatWouldAskFirstHandsOffToTheApp() {
		assertEquals(PanelShow.HandOff, panelShow(keyguardLocked = true, appLockAsks = false, team = "t"))
		assertEquals(PanelShow.HandOff, panelShow(keyguardLocked = false, appLockAsks = true, team = "t"))
		assertEquals(PanelShow.HandOff, panelShow(keyguardLocked = false, appLockAsks = false, team = null))
		assertEquals(PanelShow.Show("t"), panelShow(keyguardLocked = false, appLockAsks = false, team = "t"))
	}

	@Test
	fun theAppLockAsksOnlyWhenSetAndNotYetAnswered() {
		val locked = com.atelier_nyaarium.switchboard.ChatState(provisioned = true, biometricLock = true)

		assertTrue(com.atelier_nyaarium.switchboard.appLockAsks(locked, unlocked = false))
		assertFalse(com.atelier_nyaarium.switchboard.appLockAsks(locked, unlocked = true))
		assertFalse(com.atelier_nyaarium.switchboard.appLockAsks(locked.copy(biometricLock = false), unlocked = false))
		assertFalse(com.atelier_nyaarium.switchboard.appLockAsks(locked.copy(provisioned = false), unlocked = false))
	}

	@Test
	fun theChipOffersOnlyWhatTheSystemShared() {
		assertEquals(ScreenChip.NONE, screenChip(hasScreenshot = false, hasText = false, attached = true))
		assertEquals(ScreenChip.OFFER, screenChip(hasScreenshot = true, hasText = false, attached = false))
		assertEquals(ScreenChip.ATTACHED, screenChip(hasScreenshot = false, hasText = true, attached = true))
	}

	private val page = listOf(
		AssistWindow(
			titled = true,
			root = AssistNode(
				children = listOf(
					AssistNode(text = "Sign in", className = true),
					AssistNode(text = "Sign in"),
					AssistNode(text = "hunter2", password = true),
					AssistNode(text = "  ", hint = true, children = listOf(AssistNode(text = "Forgot?", webDomain = true))),
				),
			),
		),
		AssistWindow(titled = false, root = AssistNode(text = "Toast")),
	)

	@Test
	fun screenTextLeavesOutPasswordsAndRepeats() {
		assertEquals("Sign in\nForgot?\nToast", screenText(page))
		val long = AssistWindow(false, AssistNode(text = "x".repeat(SCREEN_TEXT_MAX_CHARS + 10)))
		assertEquals(SCREEN_TEXT_MAX_CHARS, screenText(listOf(long)).length)
	}

	@Test
	fun theShapeCountsNodesWithoutTheirText() {
		val shape = structureShape(page)

		assertEquals(2, shape.windows)
		assertEquals(1, shape.titledWindows)
		assertEquals(7, shape.nodes)
		assertEquals(5, shape.withText)
		assertEquals(1, shape.passwordsWithText)
		assertEquals(1, shape.withWebDomain)
	}

	@Test
	fun theAssistReportNamesOnlyAllowlistedCountsAndBooleans() {
		val facts = assistFacts(page, AssistContentFacts(webUri = false, intent = true, structuredData = false, clipData = false, bundleKeys = 3))
		val allowed = setOf(
			"windows", "titledWindows", "nodes", "text", "hint", "contentDescription", "idEntry", "className",
			"autofillHints", "autofillValue", "webDomain", "htmlInfo", "passwords", "passwordsWithText",
			"window0Titled", "window0Nodes", "window1Titled", "window1Nodes",
			"webUri", "intent", "structuredData", "clipData", "bundleKeys",
		)

		assertEquals(allowed, facts.keys)
		assertTrue(facts.values.all { it is Int || it is Boolean })
		assertEquals(6, facts["window0Nodes"])
	}

	@Test
	fun passwordInputsAreRecognizedByTheirVariation() {
		assertTrue(isPasswordInput(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD))
		assertTrue(isPasswordInput(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD))
		assertTrue(isPasswordInput(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD))
		assertFalse(isPasswordInput(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS))
	}
}
