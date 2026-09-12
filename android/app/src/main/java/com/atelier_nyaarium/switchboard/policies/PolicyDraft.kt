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
	/** Rebased onto the revision a refusal named, so a save over it is an owner tap. */
	fun over(held: Long): PolicyDraft? = if (held > revision) copy(revision = held) else null

	/** A flip writes at once only while nothing else is edited. */
	fun flipsAtOnce(held: AuthorizationPolicy?): Boolean = held != null && this == of(held)

	/** Trimmed, once; blank adds nothing. */
	fun withExample(typed: String): PolicyDraft {
		val example = typed.trim()
		return if (example.isEmpty() || example in examples) this else copy(examples = examples + example)
	}

	/** In place, so order holds. Blank or a duplicate elsewhere changes nothing. */
	fun replaceExample(original: String, typed: String): PolicyDraft {
		val example = typed.trim()
		val at = examples.indexOf(original)
		if (example.isEmpty() || at < 0) return this
		if (example != original && example in examples) return this
		return copy(examples = examples.toMutableList().also { it[at] = example })
	}

	/** Null until Save has what it needs. The empty field is the only thing that says so. */
	fun toPolicy(): AuthorizationPolicy? {
		if (!ID_RE.matches(id) || id.length > MAX_ID_LEN) return null
		if (name.isBlank() || name.length > MAX_NAME_LEN) return null
		if (entryId.isBlank()) return null
		if (examples.isEmpty() || examples.size > MAX_SELECTORS) return null
		if (examples.any { it.isBlank() || it.length > MAX_SELECTOR_LEN }) return null
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
