package com.atelier_nyaarium.switchboard.policies

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.PolicyBinding

/** Mirrors the schema bounds. */
private val ID_RE = Regex("^[^/\r\n]+$")
private const val MAX_ID_LEN = 64
private const val MAX_NAME_LEN = 128
private const val MAX_SELECTOR_LEN = 512
private const val MAX_SELECTORS = 64

/** Examples typed in; keys read back. */
internal data class PolicyDraft(
	val id: String,
	val name: String = "",
	val entryId: String = "",
	val examples: List<String> = emptyList(),
	val enabled: Boolean = true,
	/** What was read, so a save says which record it edits. Zero means nothing was stored. */
	val revision: Long = 0L,
) {
	fun nameRefusal(): String? = when {
		name.isBlank() -> "A name"
		name.length > MAX_NAME_LEN -> "At most $MAX_NAME_LEN characters"
		else -> null
	}

	fun bindingRefusal(): String? = if (entryId.isBlank()) "A secret" else null

	fun commandsRefusal(): String? = when {
		examples.isEmpty() -> "A command"
		examples.any { it.isBlank() } -> "A command is blank"
		examples.size > MAX_SELECTORS -> "At most $MAX_SELECTORS commands"
		examples.any { it.length > MAX_SELECTOR_LEN } -> "A command is longer than $MAX_SELECTOR_LEN"
		else -> null
	}

	fun refusal(): String? = when {
		!ID_RE.matches(id) || id.length > MAX_ID_LEN -> "The id cannot hold a slash"
		else -> nameRefusal() ?: bindingRefusal() ?: commandsRefusal()
	}

	/** Rebased onto the revision a refusal named, so a save over it is an owner tap. */
	fun over(held: Long): PolicyDraft? = if (held > revision) copy(revision = held) else null

	/** Trimmed, once; blank adds nothing. */
	fun withExample(typed: String): PolicyDraft {
		val example = typed.trim()
		return if (example.isEmpty() || example in examples) this else copy(examples = examples + example)
	}

	fun toPolicy(): AuthorizationPolicy? {
		if (refusal() != null) return null
		return AuthorizationPolicy(
			id = id,
			name = name.trim(),
			binding = PolicyBinding(kind = "entry", entryId = entryId),
			selectorKeys = examples.map { it.trim() },
			enabled = enabled,
			// The gateway names it.
			revision = revision.coerceAtLeast(1L),
		)
	}

	companion object {
		/** A new record's id; the gateway keeps whatever the phone sends. */
		fun fresh(): PolicyDraft = PolicyDraft(id = "policy-${java.util.UUID.randomUUID().toString().take(8)}")

		fun of(policy: AuthorizationPolicy): PolicyDraft = PolicyDraft(
			id = policy.id,
			name = policy.name,
			entryId = policy.binding.entryId,
			examples = policy.selectorKeys,
			enabled = policy.enabled,
			revision = policy.revision,
		)
	}
}
