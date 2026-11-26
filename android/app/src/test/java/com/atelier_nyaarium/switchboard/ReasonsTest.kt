package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.CarryRefusal
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.PolicyRefusal
import com.atelier_nyaarium.switchboard.proto.Protocol
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReasonsTest {
	@Test
	fun knownTokensReadAsTheirOwnSentence() {
		for (reason in REASONS) {
			assertEquals(reason.token, reason.sentence, reasonSentence(Act.SENDING, reason.token))
		}
	}

	@Test
	fun anUnknownTokenNamesTheActAndKeepsTheToken() {
		assertEquals("Sending the message failed. (gremlins)", reasonSentence(Act.SENDING, "gremlins"))
		assertEquals("Sending the message failed.", reasonSentence(Act.SENDING, null))
		assertEquals("Sending the message failed.", reasonSentence(Act.SENDING, " "))
	}

	@Test
	fun aThrownCallNeverNamesItsClass() {
		val owner = OwnerOpFailure("refused", "deliver failed: no_holder", reason = "no_holder")
		assertEquals(reasonSentence(Act.SENDING, "no_holder"), thrownSentence(Act.SENDING, owner))
		assertEquals(missLine(Miss.NO_NETWORK), thrownSentence(Act.SENDING, java.net.UnknownHostException("router")))
		assertEquals(refusalLine(Refusal.TOKEN_REJECTED), thrownSentence(Act.SENDING, RouterStatus(401, "Unauthorized")))
		assertEquals("Sending the message failed.", thrownSentence(Act.SENDING, IllegalStateException()))
		assertTrue(thrownSentence(Act.SENDING, IllegalStateException("poll failed")).contains("poll failed"))
	}

	@Test
	fun aFinishedSendSaysHowItFinished() {
		assertEquals(Line.ALREADY_SENT.text, settledSentence("fired"))
		assertEquals(Line.ALREADY_SENT.text, settledSentence(null))
		assertEquals(Line.ALREADY_CANCELLED.text, settledSentence("cancelled"))
		assertEquals(Line.ALREADY_FAILED.text, settledSentence("error"))
	}

	@Test
	fun aPolicyRefusalReadsAsItsCodesSentence() {
		val prose = "the Gateway's own line"
		fun line(code: String, example: String? = null, key: String? = null, policy: String? = null, max: Long? = null) =
			policyRefusalLine(PolicyRefusal(code, example, key, policy, max), prose)

		assertEquals(sameCommandLine("sudo apt mark", "sudo apt"), line("same_command", example = "sudo apt mark", key = "sudo apt"))
		assertEquals(takenLine("sudo apt", "Sakura Sudo"), line("taken", key = "sudo apt", policy = "Sakura Sudo"))
		assertEquals(noCommandLine("x"), line("no_command", example = "x"))
		assertEquals(policiesFullLine(256), line("full", max = 256))
		assertEquals(commandsFullLine(64), line("too_many_commands", max = 64))
		assertEquals(Line.POLICY_COMMAND_TOO_LONG.text, line("command_too_long", max = 200))
		assertEquals(Line.POLICY_INVALID.text, line("invalid"))
		assertEquals(Line.POLICY_NONE.text, line("none"))
		assertEquals(Line.POLICY_MOVED.text, line("moved"))
		assertEquals(Line.POLICY_GONE.text, line("gone"))
		assertEquals(Line.POLICY_DELETED.text, line("deleted"))
		assertEquals(Line.POLICY_SPENT.text, line("spent"))
		assertEquals(Line.POLICY_UNWRITTEN.text, line("unwritten"))
		// Falls back to prose.
		assertEquals(prose, line("same_command", example = "sudo apt mark"))
		assertEquals(prose, line("not_yet_known"))
		assertEquals(prose, policyRefusalLine(null, prose))

		assertEquals("sudo apt mark", policyRefusalMarks(PolicyRefusal("same_command", example = "sudo apt mark", key = "sudo apt")))
		assertEquals("x", policyRefusalMarks(PolicyRefusal("no_command", example = "x")))
		assertEquals(null, policyRefusalMarks(PolicyRefusal("taken", key = "sudo apt", policy = "Sakura Sudo")))
	}

	@Test
	fun aFullSaveNamesTheCapItHit() {
		fun line(kind: String?, max: Long?) =
			automationSaveLine(Protocol.Wire.AutomationSaveRefusalCode.FULL, AutomationSaveRefusal(code = "full", kind = kind, max = max))
		val lines = listOf(line(null, null), line("function", 32), line("automation", 32), line(null, 64))
		assertEquals(lines.size, lines.toSet().size)
		assertTrue(line(null, 64).contains("64"))
	}

	@Test
	fun aSaveRefusalReadsTheFactsItCarries() {
		fun unfit(vararg names: String) = automationSaveLine(
			Protocol.Wire.AutomationSaveRefusalCode.UNFIT,
			AutomationSaveRefusal(code = "unfit", automations = names.toList()),
			"mine",
		)
		assertTrue(unfit("mine") != unfit("hall"))
		assertEquals(unfit("hall"), unfit("mine", "hall"))
		assertTrue(unfit("mine", "hall", "room").contains("2"))

		fun invalid(path: String? = null, record: String? = null, id: String? = null, line: String? = null) = automationSaveLine(
			Protocol.Wire.AutomationSaveRefusalCode.INVALID,
			AutomationSaveRefusal(code = "invalid", record = record, path = path, id = id, line = line),
		)
		val generic = invalid(path = "revision")
		val each = listOf(invalid(path = "values.lamp"), invalid(path = "steps.1"), invalid(record = "automation", id = "mine"), invalid(path = "name", record = "function"), generic)
		assertEquals(each.size, each.toSet().size)
		assertEquals(listOf(generic, generic), listOf(invalid(path = "id"), invalid(path = "label")))
		assertEquals("no rule fits", invalid(path = "steps.0.device", record = "function", line = "no rule fits"))
		assertEquals("no rule fits", invalid(record = "automation", line = "no rule fits"))

		assertTrue(carryRefusalLine(CarryRefusal.StepNotServed("tell_assistant", "Tell the assistant")).contains("Tell the assistant"))
		assertTrue(!carryRefusalLine(CarryRefusal.StepNotServed("tell_assistant")).contains("tell_assistant"))
	}

	/** The owner's review list, from the mapping itself: `build/reports/error-prose.md`. */
	@Test
	fun writesTheProseTable() {
		val rows = mutableListOf<Triple<String, String, String>>()
		REASONS.forEach { rows += Triple(it.sentence, it.situation, it.token) }
		Line.entries.forEach { rows += Triple(it.text, it.situation, it.replaces) }
		Act.entries.forEach { rows += Triple(reasonSentence(it, "token"), "${it.doing} failed with a reason the phone does not know.", "<raw reason>") }
		listOf("fired", "cancelled", "error", null).forEach {
			rows += Triple(settledSentence(it), "You cancelled or rescheduled; the Router said the send had finished as ${it ?: "(an older Router)"}.", "settled")
		}
		rows += Triple(handedBack(Line.CHANGED_ELSEWHERE.text), "A scheduled message handed back, with its reason first.", "Scheduled send: <reason>")
		rows += Triple(keyEpochLine(3), "A message arrived sealed with a key this phone does not hold yet.", "Content key epoch 3 remains unavailable")
		rows += Triple(cursorLine(7), "The Router moved and old messages could not be mapped.", "Cursor translation is unavailable for epoch 7")
		rows += Triple(renameLine("notes"), "You renamed a session and the Gateway refused.", "Could not rename to \"notes\"")
		rows += Triple(labelLine("my session!"), "You created a session with characters a name cannot hold.", "...has unsupported characters; the session was created using its id...")
		rows += Triple(lostFilesLine(1), "A scheduled message came back to the composer without one of its attachments.", "1 attachment(s) could not be fetched back")
		rows += Triple(lostFilesLine(2), "A scheduled message came back to the composer without some of its attachments.", "2 attachment(s) could not be fetched back")
		rows += Triple(boardCapLine(10), "You attached too many files to a task.", "An entry holds at most 10 attachments")
		rows += Triple(sameCommandLine("sudo apt mark", "sudo apt"), "You saved a policy with two commands that share a key.", "a selector is named twice")
		rows += Triple(takenLine("sudo apt", "Sakura Sudo"), "You saved a policy whose command another enabled policy answers.", "sudo apt is already answered by Sakura Sudo")
		rows += Triple(noCommandLine("x"), "You saved a policy with a command that is not a command.", "<prose>")
		rows += Triple(policiesFullLine(256), "You saved a policy on a Gateway that holds the most it can.", "<prose>")
		rows += Triple(commandsFullLine(64), "You saved a policy with more commands than one holds.", "(new)")
		rows += Triple(noPolicyLine("sudo apt-mark"), "A sudo card, when no policy names the command.", "(nothing said why)")
		rows += Triple(policyOffLine("sudo apt-mark", "Sakura Old"), "A sudo card, when only a policy that is off names it.", "(nothing said why)")
		Protocol.Wire.VaultUnusableCode.entries.forEach {
			rows += Triple(unusableLine("Sakura Sudo", "Old Pass", it, "sakura"), "A sudo card, when the policy's secret cannot be used (${it.wire}).", "(nothing said why)")
		}
		rows += Triple(noSecretFitsLine("sakura"), "A sudo card, when no saved secret is allowed on that Gateway.", "(new)")
		rows += Triple(runsAnythingLine("sudo bash"), "A sudo card for a command that runs anything.", "(new)")
		rows += Triple(addsToLine("Sakura Sudo") + " " + endsApprovalsLine(1), "Under Remember, adding to a policy that holds an approval.", "(new)")
		rows += Triple(newPolicyLine("Sakura Nyaarium"), "Under Remember, when no policy uses that secret yet.", "(new)")
		rows += Triple(PICK_SECRET_FIRST, "Under Remember, before a secret is picked.", "(new)")
		Protocol.Wire.VaultAnswerRefusalCode.entries.forEach {
			rows += Triple(entryRefusalLine(it, null), "You answered a sudo card with a secret and the Gateway refused (${it.wire}).", "(new)")
		}
		rows += Triple(ENTRY_REFUSED, "You answered a sudo card with a secret and the Gateway refused for a reason this phone does not know.", "(new)")
		rows += Triple(scheduleFilesLine(10), "In the schedule dialog, the message holds more than 10 files.", "(nothing; the Router refused it)")
		rows += Triple(goalDroppedLine("its terminal never took it"), "A goal waited too long for its session.", "Goal dropped: its terminal never took one.")
		Refusal.entries.forEach { rows += Triple(refusalLine(it), "The Router refused this phone (link status).", OLD_REFUSALS.getValue(it)) }
		Miss.entries.forEach { rows += Triple(missLine(it), "The Router could not be reached (link status).", OLD_MISSES.getValue(it)) }
		val table = buildString {
			appendLine("| Sentence | When | Replaces |")
			appendLine("|---|---|---|")
			rows.forEach { (said, situation, was) -> appendLine("| ${cell(said)} | ${cell(situation)} | ${cell(was)} |") }
		}
		File("build/reports").mkdirs()
		File("build/reports/error-prose.md").writeText(table)
		assertTrue(rows.none { it.first.isBlank() })
	}

	private fun cell(text: String) = text.replace("|", "\\|")

	@Test
	fun linkLinesAreSentencesWithNoDashJoins() {
		val lines = Refusal.entries.map(::refusalLine) + Miss.entries.map(::missLine)
		assertTrue(lines.none { it.contains(" - ") })
		assertTrue(lines.all { it.endsWith(".") })
	}

	private companion object {
		// What the review table names as replaced.
		val OLD_REFUSALS = mapOf(
			Refusal.CERT_CHANGED to "Server certificate changed - re-run setup.sh",
			Refusal.TOKEN_REJECTED to "Sign-in rejected - re-run setup.sh and re-import the setup blob",
			Refusal.OUT_OF_DATE to "App is out of date - update the app, or re-run setup.sh",
			Refusal.NOT_SET_UP to "Server not set up - run setup.sh on the server",
			Refusal.NOT_ADMITTED to "Not enrolled - re-run setup.sh and re-import the setup blob",
			Refusal.CLOCK_SKEW to "Your device clock is off - sync the time",
		)
		val OLD_MISSES = mapOf(
			Miss.NO_NETWORK to "Offline - no network",
			Miss.UNREACHABLE to "Can't reach the server - retrying",
			Miss.INTERRUPTED to "Secure connection interrupted - retrying",
			Miss.SERVER_FAULT to "Server error - retrying",
		)
	}
}
