package com.atelier_nyaarium.switchboard.vault

import com.atelier_nyaarium.switchboard.proto.PolicyRef
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultHolder
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import kotlinx.serialization.Serializable

/** Held until answered or past its deadline. */
@Serializable
data class VaultPendingRequest(
	/** Its gateway segment answers the request. */
	val team: String,
	val request: VaultRequest,
	val receivedAt: Long,
	/** One more than the answered asks of this command it followed within the repeat window. */
	val attempt: Int = 1,
	/** Since the latest such answer, when there was one. */
	val sinceAnswerMs: Long? = null,
) {
	val requestId: String get() = request.requestId

	val deadlineAt: Long get() = request.deadlineAt

	val operation: String get() = request.operation

	val displayShape: String get() = request.displayShape

	val coveredShapes: List<String> get() = request.coveredShapes

	val sessionTarget: String get() = request.sessionTarget

	val entryId: String? get() = (request as? VaultRequest.Entry)?.entryId
}

val VaultRequest.requestId: String
	get() = when (this) {
		is VaultRequest.Entry -> requestId
		is VaultRequest.Typed -> requestId
	}

val VaultRequest.deadlineAt: Long
	get() = when (this) {
		is VaultRequest.Entry -> deadlineAt
		is VaultRequest.Typed -> deadlineAt
	}

val VaultRequest.operation: String
	get() = when (this) {
		is VaultRequest.Entry -> operation
		is VaultRequest.Typed -> operation
	}

val VaultRequest.displayShape: String
	get() = when (this) {
		is VaultRequest.Entry -> displayShape
		is VaultRequest.Typed -> displayShape
	}

val VaultRequest.coveredShapes: List<String>
	get() = when (this) {
		is VaultRequest.Entry -> coveredShapes
		is VaultRequest.Typed -> coveredShapes
	}

val VaultRequest.sessionTarget: String
	get() = when (this) {
		is VaultRequest.Entry -> sessionTarget
		is VaultRequest.Typed -> sessionTarget
	}

/** One run of the program asking; a second ask under it followed a rejected value. */
val VaultRequest.asker: String?
	get() = when (this) {
		is VaultRequest.Entry -> asker
		is VaultRequest.Typed -> asker
	}

val VaultGrant.grantId: String
	get() = when (this) {
		is VaultGrant.Window -> grantId
		is VaultGrant.Session -> grantId
		is VaultGrant.Standing -> grantId
	}

val VaultGrant.entryId: String
	get() = when (this) {
		is VaultGrant.Window -> entryId
		is VaultGrant.Session -> entryId
		is VaultGrant.Standing -> entryId
	}

val VaultGrant.holder: VaultHolder
	get() = when (this) {
		is VaultGrant.Window -> holder
		is VaultGrant.Session -> holder
		is VaultGrant.Standing -> holder
	}

/** A standing grant dies with its routine, not a clock. */
val VaultGrant.expiresAt: Long?
	get() = when (this) {
		is VaultGrant.Window -> expiresAt
		is VaultGrant.Session -> expiresAt
		is VaultGrant.Standing -> null
	}

/** A standing grant is entry-wide and carries none. */
val VaultGrant.policy: PolicyRef?
	get() = when (this) {
		is VaultGrant.Window -> policy
		is VaultGrant.Session -> policy
		is VaultGrant.Standing -> null
	}

/** Only a window names its set. */
val VaultGrant.coveredShapes: List<String>?
	get() = (this as? VaultGrant.Window)?.coveredShapes

/** An approval the same command may come back from. */
@Serializable
data class VaultAnswered(
	val team: String,
	val operation: String,
	val answeredAt: Long,
	val attempt: Int = 1,
	val asker: String? = null,
)

@Serializable
data class VaultBlob(
	/** The vault revision the held entries reach; 0 asks for a full list. */
	val revision: Long = 0,
	/** The lineage the revision belongs to; 0 is unknown. */
	val routerEpoch: Long = 0,
	/** Sealed Router entries, tombstones included. */
	val stored: List<VaultStoredEntry> = emptyList(),
	val requests: List<VaultPendingRequest> = emptyList(),
	/** Approvals inside the repeat window, oldest first. */
	val answered: List<VaultAnswered> = emptyList(),
	val lastRouterSyncAt: Long = 0,
)

/** One entry with every field but the value opened. */
data class VaultEntryView(
	val id: String,
	val revision: Long,
	val createdBy: String,
	val createdAt: Long,
	val updatedAt: Long,
	val publicTitle: String?,
	val publicDescription: String?,
	val privateTitle: String?,
	val privateDescription: String?,
	/** Null admits every gateway. */
	val gateways: List<String>?,
	/** A sealed allowlist this phone could not open. */
	val gatewaysUnreadable: Boolean,
	val hasValue: Boolean,
) {
	val title: String get() = privateTitle ?: publicTitle ?: id

	val description: String? get() = privateDescription ?: publicDescription

	/** Searchable text, private fields included. */
	fun matches(query: String): Boolean =
		listOfNotNull(publicTitle, privateTitle, publicDescription, privateDescription)
			.any { it.contains(query, ignoreCase = true) }

	/** Whether that Gateway may use this entry: everyone, listed, or an allowlist this phone cannot read. */
	fun allowedOn(gatewayId: String): Boolean = !gatewaysUnreadable && (gateways == null || gatewayId in gateways)
}

const val VAULT_DECISION_ONCE = "once"
const val VAULT_DECISION_WINDOW = "window"
const val VAULT_DECISION_SESSION = "session"
const val VAULT_DECISION_DENY = "deny"

/** Security setting values for vault approvals. */
const val VAULT_UNLOCK_OFF = "off"
const val VAULT_UNLOCK_EVERY = "every"
const val VAULT_UNLOCK_WINDOW = "window"
const val VAULT_UNLOCK_WINDOW_MS = 30L * 60 * 1000
