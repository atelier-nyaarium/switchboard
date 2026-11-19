package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.CarryRefusal
import com.atelier_nyaarium.switchboard.assistant.RunsIssue
import com.atelier_nyaarium.switchboard.assistant.TypeWord
import com.atelier_nyaarium.switchboard.assistant.ValueIssue
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.Protocol

// Every sentence a notice or a failed row shows lives here.

/** What was being done, for a reason's fallback. */
internal enum class Act(val doing: String) {
	SENDING("Sending the message"),
	SCHEDULING("Scheduling the message"),
	SENDING_SCHEDULED("Sending the scheduled message"),
	CANCELLING_SCHEDULED("Cancelling the scheduled message"),
	RESCHEDULING("Rescheduling the message"),
	CHECKING("Checking for new messages"),
	ADDING_GATEWAY("Adding the Gateway"),
	REVOKING("Removing it from your Domain"),
	LINKING("Linking the Domains"),
	UNLINKING("Unlinking the Domains"),
	APPROVING_DEVICE("Approving the new device"),
	TYPING_GOAL("Typing the goal into the session"),
	UPLOADING("Uploading the attachment"),
	VAULT_ANSWER("Answering the vault request"),
	ASSISTANT_ACTION("Answering the assistant's request"),
	ASSISTANT_SEND("Answering the assistant's message"),
	CLOSING("Closing the session"),
	STARTING_CONTAINER("Starting the container"),
	STOPPING_CONTAINER("Stopping the container"),
	CREATING_SESSION("Creating the session"),
	WAKING("Waking the session"),
	FORGETTING("Forgetting the session"),
	COMPACTING("Compacting the conversation"),
	SAVING_POLICY("Saving the policy"),
}

/** The owner's words for an outdated build. */
private const val GATEWAY_OUTDATED = "That Gateway is on an outdated Switchboard version."

/** A fixed sentence: what it says, when, and what it replaced. */
internal enum class Line(val text: String, val situation: String, val replaces: String) {
	BACKGROUND("Something went wrong in the background.", "Any background task stopped unexpectedly.", "Something went wrong: <class name>"),
	NO_ADDRESS("That session no longer exists.", "You scheduled a message for a session that is gone.", "That session has no address to send to."),
	TIME_PASSED("That time has passed.", "You scheduled or rescheduled for a time already gone.", "That time has already passed - try scheduling again."),
	TOO_FAR("Schedule at most 30 days ahead.", "You picked a time more than 30 days out.", "Can't schedule more than 30 days out."),
	SCHEDULE_UNREACHED(
		"The Router could not be reached. It will retry.",
		"You scheduled, rescheduled or cancelled with no connection to the Router.",
		"(nothing; it failed silently)",
	),
	TEXT_BACK("Its text is back in the composer.", "Appended when a scheduled message is handed back to the composer.", "(none)"),
	CHANGED_ELSEWHERE(
		"Changed on another device. Schedule it again.",
		"You scheduled a message while another device changed that session's schedule.",
		"Scheduled send: conflict",
	),
	ANOTHER_SCHEDULED(
		"This session already has a scheduled message.",
		"You scheduled a message while one from another device was already waiting.",
		"Scheduled send: another send is already scheduled",
	),
	CANCELLED_ELSEWHERE("Cancelled on another device.", "Your scheduled message was cancelled from another device.", "Scheduled send: cancelled elsewhere"),
	ALREADY_SENT("Already sent.", "You cancelled or rescheduled a message that had already gone out.", "Scheduled send: already sent / conflict"),
	ALREADY_CANCELLED("Already cancelled.", "You cancelled or rescheduled a message already cancelled elsewhere.", "Scheduled send: conflict"),
	ALREADY_FAILED("Already sent, but not delivered.", "You cancelled or rescheduled a message that had already failed.", "Scheduled send: conflict"),
	SENDING_NOW("Sending right now.", "You cancelled or rescheduled a message at the moment it was going out.", "Scheduled send: conflict"),
	PICK_LATER("Pick a time at least a minute from now.", "In the schedule dialog, you picked a time too soon.", "Pick a time at least a minute from now."),
	PICK_SOONER("Pick a time within 30 days.", "In the schedule dialog, you picked a time too far ahead.", "Pick a time no more than 30 days out."),
	NO_GOAL_CLI("That session's CLI cannot take a goal.", "You set a goal on a session whose CLI has no goal command.", "That session's CLI takes no goal."),
	GOAL_EMPTY("Type the goal first.", "You set an empty goal.", "Type what the goal is before setting one."),
	GOAL_UNSENT("The message did not send. No goal was set.", "The message carrying a goal failed.", "That message did not send, so no goal was set."),
	KEYS_REFUSED(
		"This device's keys could not be installed. Approve it again.",
		"A new device was approved, but its keys were refused.",
		"content key installation refused",
	),
	SETUP_CODE_UNREADABLE("That setup code could not be read.", "You scanned or pasted a setup code that is damaged or wrong.", "Invalid provisioning blob: <parser text>"),
	ENTER_HOST("Enter a domain or IP.", "You saved a Router address with the host blank.", "Enter a domain or IP."),
	BAD_FINGERPRINT(
		"The fingerprint must be 64 hex characters.",
		"You saved a Router address with a malformed certificate fingerprint.",
		"Fingerprint must be 64 hex characters (SHA-256).",
	),
	BAD_ENDPOINT("That address is not valid.", "You saved a Router address that does not parse.", "Invalid endpoint: <parser text>"),
	RENAME_DEVICE_FAILED("This device could not be renamed.", "Renaming this device in settings failed.", "<parser text> / Invalid provisioning blob"),
	ATTACHMENTS_GONE("Its attachments are no longer on this device.", "You retried a message whose attachments were all deleted.", "Attachments are no longer on this device; cannot retry."),
	SOME_ATTACHMENTS_GONE(
		"Some attachments are gone from this device. The rest were resent.",
		"You retried a message and some of its attachments were deleted.",
		"Some attachments are no longer on this device; resending the rest.",
	),
	CUT_OFF("Interrupted before it was confirmed.", "The app closed while a message from an older version was sending.", "failed"),
	CONNECT_FIRST("Connect before adding attachments.", "You attached a file before the phone connected.", "Connect before adding attachments"),
	VAULT_NOT_CONNECTED("Not connected. Your vault answer was not sent.", "You answered a vault request while offline.", "Vault: not connected"),
	VAULT_NO_KEY(
		"This phone has no key yet. Your vault answer was not sent.",
		"You typed a value for a vault request before this phone had its keys.",
		"Vault: no content key to seal the value",
	),
	VAULT_NO_GATEWAY("That vault request names no Gateway.", "You answered a malformed vault request.", "Vault: the request names no gateway"),
	VAULT_UNREACHABLE(
		"The Gateway could not be reached. Your vault answer was not sent.",
		"You answered a vault request and its Gateway was down.",
		"Vault: the gateway could not be reached",
	),
	VAULT_UNREADABLE("The Gateway's reply could not be read.", "You answered a vault request and the reply was garbled.", "Vault: the answer could not be read"),
	POLICY_NONE("Add a command first.", "You saved a policy with no command.", "a policy names no selector"),
	POLICY_MOVED("Changed on another device.", "You saved a policy someone changed meanwhile.", "revision 3 is stored; this edits 2"),
	POLICY_GONE("That policy no longer exists.", "You saved or deleted a policy removed meanwhile.", "no policy <id>"),
	POLICY_DELETED("That policy was deleted. Save it as a new one.", "You saved a policy deleted meanwhile.", "revision <n> was deleted"),
	POLICY_SPENT("That policy cannot be changed again. Save it as a new one.", "You saved a policy with no revision left.", "no revision left"),
	POLICY_UNWRITTEN("The Gateway could not save it. Try again.", "The Gateway failed to write the policy.", "could not be written"),
	POLICY_COMMAND_TOO_LONG("That command is too long.", "You saved a policy with a command past the length a policy keeps.", "(new)"),
	POLICY_INVALID("The Gateway could not save it.", "The Gateway found the policy malformed.", "(new)"),
	POLICY_NOT_STORED("This Gateway holds a different copy.", "An older Gateway refused a policy save and said nothing.", "This Gateway holds a different copy"),
	POLICY_KEPT("This Gateway kept it.", "An older Gateway refused a policy delete and said nothing.", "This Gateway kept it"),
	TASKS_BACKLOG(
		GATEWAY_OUTDATED,
		"You forgot a session and asked to keep its tasks, on an older Gateway; the tasks went back to the backlog.",
		"Gateway needs an update; that session's tasks went back to the backlog.",
	),
}

/** A wire token, read as a sentence. */
internal data class Reason(val token: String, val sentence: String, val situation: String)

internal val REASONS: List<Reason> = listOf(
	// A scheduled message the Gateway did not deliver.
	Reason(Protocol.Wire.ScheduledFailureReason.MALFORMED_BODY, "The Gateway could not read it.", "Not delivered: the Gateway could not read the message."),
	Reason(Protocol.Wire.ScheduledFailureReason.BAD_TAG, "The Gateway could not decrypt it. Try again.", "Not delivered: the message's seal did not match."),
	Reason(Protocol.Wire.ScheduledFailureReason.DELIVERY_UNAVAILABLE, "The Gateway was not ready.", "Not delivered: the Gateway was offline or busy."),
	Reason(Protocol.Wire.ScheduledFailureReason.TARGET_MISMATCH, "That session moved. Resend.", "Not delivered: the session was replaced."),
	Reason(Protocol.Wire.ScheduledFailureReason.DELIVERY_REFUSED, "The Gateway refused it.", "Not delivered: the Gateway refused it."),
	Reason(Protocol.Wire.ScheduledFailureReason.DELIVERY_FAILED, "The session did not take it.", "Not delivered: the session did not take it."),
	Reason(Protocol.Wire.SCHEDULE_REFUSED_TOO_MANY_FILES, scheduleFilesLine(Protocol.CHANNEL_FILES_MAX), "You scheduled a message with too many attachments."),
	// An ordinary send.
	Reason("send timed out", "No answer in time. It may still have arrived.", "Not delivered: the Router never confirmed the send."),
	Reason("transport", "The Router could not be reached.", "Not delivered: no connection."),
	Reason("lost", "The session restarted mid-delivery.", "Not delivered: the session restarted mid-delivery."),
	Reason("delivery op kind is not allowed", "That Gateway does not accept this kind of message.", "Not delivered: the Gateway refused the message type."),
	Reason(Protocol.Wire.OP_REASON_NOT_SERVED, GATEWAY_OUTDATED, "An older Gateway does not know the request."),
	// The Router's refusals.
	Reason("domain", "This device is not part of that Domain.", "The Router refused a request for another Domain."),
	Reason("row", "The Router could not read it.", "The Router refused a malformed request."),
	Reason("malformed", "The Router could not read it.", "The Router refused a malformed request."),
	Reason("unsupported", "The Router is on an outdated Switchboard version.", "An older Router does not know the request."),
	Reason("signature", "The Router could not verify this device.", "The Router refused this device's signature."),
	Reason("address", "The Router does not know that session.", "The Router does not know the session."),
	Reason("no_holder", "That session's Gateway is offline.", "Not delivered: the session's Gateway is offline."),
	Reason("inbox capacity", "That session's inbox is full.", "Not delivered: the session's inbox is full."),
	Reason("blob_missing", "An attachment did not upload. Try again.", "Not delivered: an attachment's upload was lost."),
	Reason(Protocol.Wire.OP_REASON_NOT_ADMITTED, "This device is not enrolled.", "The Router does not admit this device."),
	Reason(Protocol.Wire.OP_REASON_CLOCK_SKEW, "This phone's clock is off. Sync it to network time.", "The Router refused a request stamped at the wrong time."),
	Reason("replay", "The Router already has this request.", "The Router refused a repeated request."),
	Reason("migrating", "The Router is migrating. Try again shortly.", "The Router is mid-migration."),
	Reason("owner operation refused", "The Router refused it.", "The Router refused without a reason."),
	Reason("durability_failure", "The Router could not save it. Try again.", "The Router's disk write failed."),
	Reason("durability_uncertain", "The Router may not have saved it. Check before retrying.", "The Router's disk write may not have landed."),
	Reason("unavailable", "The Router could not be reached.", "The Router is down."),
)

private val REASON_SENTENCES: Map<String, String> = REASONS.associate { it.token to it.sentence }

/** A known token's sentence, else what failed and the token. */
internal fun reasonSentence(act: Act, reason: String?): String {
	val token = reason?.trim()?.takeIf { it.isNotEmpty() } ?: return "${act.doing} failed."
	return REASON_SENTENCES[token] ?: "${act.doing} failed. ($token)"
}

/** A thrown call; never a class name. */
internal fun thrownSentence(act: Act, e: Throwable): String =
	if (e is OwnerOpFailure) reasonSentence(act, e.reason) else linkCause(e) ?: reasonSentence(act, e.message?.take(120))

/** A cancel or reschedule over a finished record; no state is an older Router's sent. */
internal fun settledSentence(state: String?): String = when (state) {
	"cancelled" -> Line.ALREADY_CANCELLED.text
	"error" -> Line.ALREADY_FAILED.text
	else -> Line.ALREADY_SENT.text
}

/** A scheduled message handed back to the composer. */
internal fun handedBack(sentence: String): String = "$sentence ${Line.TEXT_BACK.text}"

internal fun keyEpochLine(epoch: Int): String = "Some messages are waiting for this device's keys. (key $epoch)"

internal fun cursorLine(epoch: Long): String = "Messages from before the Router migrated were not found. (epoch $epoch)"

internal fun renameLine(name: String): String = "Could not rename it to \"$name\"."

internal fun labelLine(label: String): String = "\"$label\" is not a valid name. The session uses its id."

internal fun lostFilesLine(lost: Int): String =
	if (lost == 1) "1 attachment could not be restored." else "$lost attachments could not be restored."

internal fun boardCapLine(max: Int): String = "A task holds at most $max attachments."

/** `reason` is a clause, capitalised here. */
internal fun goalDroppedLine(reason: String): String = "The goal was dropped. ${reason.replaceFirstChar { it.uppercase() }}."

internal fun scheduleFilesLine(max: Int): String = "A scheduled message carries at most $max files."

internal fun sameCommandLine(example: String, key: String): String = "\"$example\" is already covered by \"$key\"."

internal fun takenLine(key: String, policy: String): String = "\"$key\" is already answered by $policy."

internal fun noCommandLine(example: String): String = "\"$example\" is not a command."

internal fun policiesFullLine(max: Long): String = "This Gateway holds $max policies already."

internal fun commandsFullLine(max: Long): String = "A policy holds at most $max commands."

// Sudo request card.

internal fun noPolicyLine(key: String): String = "No policy covers \"$key\"."

internal fun policyOffLine(key: String, policy: String?): String =
	if (policy != null) "\"$key\" is in $policy, which is off." else "\"$key\" is in a policy that is off."

/** Why its secret fails. */
internal fun unusableLine(policy: String?, secret: String?, unusable: Protocol.Wire.VaultUnusableCode?, gateway: String): String {
	val holder = policy ?: "A policy"
	val named = secret ?: "its secret"
	return when (unusable) {
		Protocol.Wire.VaultUnusableCode.MISSING -> "$holder has this, but its secret is gone."
		Protocol.Wire.VaultUnusableCode.EMPTY -> "$holder has this, but $named holds no value."
		Protocol.Wire.VaultUnusableCode.NOT_ALLOWED -> "$holder has this, but $named is not allowed on $gateway."
		null -> "$holder has this, but its secret cannot be used."
	}
}

internal fun noSecretFitsLine(gateway: String): String = "No saved secret works on $gateway."

internal fun runsAnythingLine(key: String): String = "\"$key\" runs anything."

internal fun rememberLabel(key: String): String = "Remember for \"$key\""

internal fun saveForLabel(key: String): String = "Save for \"$key\""

internal fun saveForSub(gateway: String): String = "New secret and policy on $gateway."

internal fun addsToLine(policy: String?): String = if (policy != null) "Adds to $policy." else "Adds to its policy."

internal fun newPolicyLine(name: String): String = "New policy $name."

internal fun endsApprovalsLine(count: Int): String = if (count == 1) "Ends 1 approval." else "Ends $count approvals."

internal const val PICK_SECRET_FIRST = "Pick a secret first."

/** A refused entry answer. */
internal fun entryRefusalLine(code: Protocol.Wire.VaultAnswerRefusalCode, unusable: Protocol.Wire.VaultUnusableCode?): String =
	when (code) {
		Protocol.Wire.VaultAnswerRefusalCode.EXPIRED -> "That request expired."
		Protocol.Wire.VaultAnswerRefusalCode.ANSWERED -> "That request was already answered."
		Protocol.Wire.VaultAnswerRefusalCode.NOT_TYPED -> "That request changed. Answer the new one."
		Protocol.Wire.VaultAnswerRefusalCode.UNREADY -> "The Gateway is not ready. Try again."
		Protocol.Wire.VaultAnswerRefusalCode.UNUSABLE -> when (unusable) {
			Protocol.Wire.VaultUnusableCode.MISSING -> "That secret is gone."
			Protocol.Wire.VaultUnusableCode.EMPTY -> "That secret holds no value."
			Protocol.Wire.VaultUnusableCode.NOT_ALLOWED -> "That secret is not allowed on this Gateway."
			null -> "That secret cannot be used here."
		}
		Protocol.Wire.VaultAnswerRefusalCode.BOUND_ELSEWHERE -> "That policy uses another secret."
		Protocol.Wire.VaultAnswerRefusalCode.TARGET_OFF -> "That policy is off."
		Protocol.Wire.VaultAnswerRefusalCode.CANNOT_REMEMBER -> "This command cannot be remembered."
	}

internal const val ENTRY_REFUSED = "The Gateway refused the answer."

/** A vault write that did not land. */
internal fun vaultSaveLine(outcome: com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome): String? = when (outcome) {
	is com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome.Applied -> null
	com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome.Conflict -> "Changed elsewhere since you opened it. Reopen to edit the latest."
	is com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome.Refused -> "Refused: ${outcome.reason}"
	com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome.Unreachable -> "The Router could not be reached."
}

/** Unknown code falls back to the Gateway's line. */
internal fun policyRefusalLine(refusal: com.atelier_nyaarium.switchboard.proto.PolicyRefusal?, reason: String?): String {
	val fallback = reason ?: reasonSentence(Act.SAVING_POLICY, null)
	refusal ?: return fallback
	val code = Protocol.Wire.PolicyRefusalCode.entries.find { it.wire == refusal.code } ?: return fallback
	return when (code) {
		Protocol.Wire.PolicyRefusalCode.SAME_COMMAND -> {
			val example = refusal.example ?: return fallback
			sameCommandLine(example, refusal.key ?: return fallback)
		}
		Protocol.Wire.PolicyRefusalCode.TAKEN -> {
			val key = refusal.key ?: return fallback
			takenLine(key, refusal.policy ?: return fallback)
		}
		Protocol.Wire.PolicyRefusalCode.NO_COMMAND -> noCommandLine(refusal.example ?: return fallback)
		Protocol.Wire.PolicyRefusalCode.FULL -> policiesFullLine(refusal.max ?: return fallback)
		Protocol.Wire.PolicyRefusalCode.TOO_MANY_COMMANDS -> commandsFullLine(refusal.max ?: return fallback)
		Protocol.Wire.PolicyRefusalCode.COMMAND_TOO_LONG -> Line.POLICY_COMMAND_TOO_LONG.text
		Protocol.Wire.PolicyRefusalCode.INVALID -> Line.POLICY_INVALID.text
		Protocol.Wire.PolicyRefusalCode.NONE -> Line.POLICY_NONE.text
		Protocol.Wire.PolicyRefusalCode.MOVED -> Line.POLICY_MOVED.text
		Protocol.Wire.PolicyRefusalCode.GONE -> Line.POLICY_GONE.text
		Protocol.Wire.PolicyRefusalCode.DELETED -> Line.POLICY_DELETED.text
		Protocol.Wire.PolicyRefusalCode.SPENT -> Line.POLICY_SPENT.text
		Protocol.Wire.PolicyRefusalCode.UNWRITTEN -> Line.POLICY_UNWRITTEN.text
	}
}

/** Command the refusal names. */
internal fun policyRefusalMarks(refusal: com.atelier_nyaarium.switchboard.proto.PolicyRefusal?): String? = when (
	refusal?.code?.let { code -> Protocol.Wire.PolicyRefusalCode.entries.find { it.wire == code } }
) {
	Protocol.Wire.PolicyRefusalCode.SAME_COMMAND, Protocol.Wire.PolicyRefusalCode.NO_COMMAND -> refusal?.example
	else -> null
}

// Functions.

/** A refused `automation_save`; `code` null for one this build does not know. */
internal fun automationSaveLine(
	code: Protocol.Wire.AutomationSaveRefusalCode?,
	refusal: AutomationSaveRefusal?,
): String {
	val function = refusal?.record == Protocol.Wire.AutomationSaveRecord.FUNCTION.wire
	return when (code) {
		Protocol.Wire.AutomationSaveRefusalCode.MOVED ->
			if (function) "Its function changed on another device. Reopen it to edit the latest." else "Changed on another device."
		Protocol.Wire.AutomationSaveRefusalCode.GONE ->
			if (function) "That function no longer exists." else "That automation no longer exists."
		Protocol.Wire.AutomationSaveRefusalCode.FULL -> {
			val functions = refusal?.kind == Protocol.Wire.AutomationSaveRecord.FUNCTION.wire
			val max = refusal?.max
			when {
				max == null -> "This Gateway holds as many as it can."
				functions -> "This Gateway holds $max functions already."
				else -> "This Gateway holds $max automations already."
			}
		}
		Protocol.Wire.AutomationSaveRefusalCode.INVALID -> "The Gateway could not save it."
		Protocol.Wire.AutomationSaveRefusalCode.HOLE -> "That text cannot be filled here."
		Protocol.Wire.AutomationSaveRefusalCode.UNFIT -> when (val count = refusal?.automations?.size ?: 0) {
			0, 1 -> "Another automation would stop fitting it."
			else -> "$count automations would stop fitting it."
		}
		Protocol.Wire.AutomationSaveRefusalCode.UNKNOWN_FUNCTION -> "That function no longer exists."
		Protocol.Wire.AutomationSaveRefusalCode.MIXED -> "A function runs alone."
		Protocol.Wire.AutomationSaveRefusalCode.NEWER_APP -> "Edit this in the newer app."
		Protocol.Wire.AutomationSaveRefusalCode.NOT_HOME -> "Only the assistant's Gateway can save this."
		Protocol.Wire.AutomationSaveRefusalCode.CONFIRM -> "It needs your go-ahead."
		Protocol.Wire.AutomationSaveRefusalCode.COOL_DOWN_TWICE -> "Its trigger cools down already."
		Protocol.Wire.AutomationSaveRefusalCode.NEWER_FUNCTION -> "Its function needs a newer Gateway."
		Protocol.Wire.AutomationSaveRefusalCode.NO_KEY -> "This Gateway cannot make a copy right now."
		Protocol.Wire.AutomationSaveRefusalCode.UNWRITTEN -> "The Gateway could not save it. Try again."
		null -> "The Gateway refused it."
	}
}

/** How a value's type reads. */
internal fun typeWordText(word: TypeWord): String = when (word) {
	is TypeWord.Measure -> word.measure.replaceFirstChar { it.uppercase() }
	is TypeWord.Given -> when (word.type) {
		Protocol.Wire.GivenType.EVENT -> "Event"
		Protocol.Wire.GivenType.TEXT -> "Text"
		Protocol.Wire.GivenType.NUMBER -> "Number"
		Protocol.Wire.GivenType.DEVICE -> "Device"
		Protocol.Wire.GivenType.TIME -> "Time"
	}
	is TypeWord.Declared -> when (word.type) {
		Protocol.Wire.FunctionParamType.DEVICE.wire -> "Device"
		Protocol.Wire.FunctionParamType.TEXT.wire -> "Text"
		Protocol.Wire.FunctionParamType.NUMBER.wire -> "Number"
		else -> word.type
	}
}

/** What blocks Save in the Runs block. */
internal fun runsIssueLine(issue: RunsIssue): String = when (issue) {
	RunsIssue.NoSteps -> "Add a step first."
	is RunsIssue.Step -> issue.line
	is RunsIssue.NotAStep -> "Step ${issue.index + 1} cannot run in a function."
	is RunsIssue.Unset -> "Set a value for ${issue.name}."
	is RunsIssue.BadValue -> when (issue.issue) {
		ValueIssue.UNKNOWN_DEVICE -> "Pick a device for ${issue.name} again."
		ValueIssue.NOT_A_NUMBER -> "${issue.name} is a number."
	}
	is RunsIssue.Unfit -> when {
		issue.fit.hidden -> "It reads another source's event."
		issue.fit.requires.isNotEmpty() -> "Requires ${issue.fit.requires.joinToString(", ")}."
		else -> issue.fit.wrong.joinToString(" ") { "This trigger gives ${it.name} as ${it.gets.wire}." }
	}
	is RunsIssue.SharedName -> "Used by ${issue.users}. Make unique first."
}

internal fun usedByLine(count: Int): String = "Used by $count"

internal const val REACHES_HEADER = "Changes here also apply to:"

internal const val UNIQUE_LINE = "Saving makes this automation's own copy."

internal const val FUNCTION_UNLISTED = "Its function is not listed here."

internal fun deleteTakesLine(function: String): String = "This also deletes its function, $function."

/** A destination that cannot take the carried functions. */
internal fun carryRefusalLine(refusal: CarryRefusal): String = when (refusal) {
	CarryRefusal.NoFunctions -> "That Gateway cannot hold functions."
	is CarryRefusal.StepNotServed -> "That Gateway cannot run ${refusal.kind} in a function."
	CarryRefusal.Reading -> "Still reading that Gateway. Try again in a moment."
	CarryRefusal.TooLarge -> "The assistant's settings are too large to move."
	CarryRefusal.Unreachable -> "That Gateway could not be read. Try again once it answers."
}
