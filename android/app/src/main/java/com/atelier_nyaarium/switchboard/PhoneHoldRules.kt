package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.PhoneHold
import com.atelier_nyaarium.switchboard.proto.Protocol

internal val PHONE_HOLD_PLANE: String = Protocol.Wire.PHONE_HOLD_PLANE
internal val PHONE_HOLD_WINDOW_MS: Long = Protocol.Wire.PHONE_HOLD_WINDOW_MS.toLong()

@JvmInline
internal value class HoldSelf private constructor(private val key: String) {
	fun holds(holder: String?): Boolean = holder == key

	companion object {
		internal fun of(identity: Crypto.Identity): HoldSelf = HoldSelf(identity.sign.pub)
	}
}

internal enum class HoldStanding { NONE, HELD, LAPSED }

internal fun holdLapseAt(hold: PhoneHold?): Long? = hold?.claimedAt?.plus(PHONE_HOLD_WINDOW_MS)

internal fun holdStanding(hold: PhoneHold?, now: Long, windowMs: Long = PHONE_HOLD_WINDOW_MS): HoldStanding = when {
	hold == null -> HoldStanding.NONE
	now - hold.claimedAt < windowMs -> HoldStanding.HELD
	else -> HoldStanding.LAPSED
}

internal fun isLapsed(hold: PhoneHold?, now: Long, windowMs: Long = PHONE_HOLD_WINDOW_MS): Boolean =
	holdStanding(hold, now, windowMs) == HoldStanding.LAPSED

internal fun isCurrentPhoneHolder(hold: PhoneHold?, self: HoldSelf?, now: Long): Boolean =
	holdStanding(hold, now) == HoldStanding.HELD && self?.holds(hold?.holder) == true

internal fun isHeldByAnother(hold: PhoneHold?, self: HoldSelf?, now: Long): Boolean =
	holdStanding(hold, now) == HoldStanding.HELD && self?.holds(hold?.holder) != true

internal fun speaksFor(
	hold: PhoneHold?,
	self: HoldSelf?,
	now: Long,
	todayRule: Boolean,
	windowMs: Long = PHONE_HOLD_WINDOW_MS,
): Boolean = when (holdStanding(hold, now, windowMs)) {
	HoldStanding.NONE, HoldStanding.LAPSED -> todayRule
	HoldStanding.HELD -> self?.holds(hold?.holder) == true
}

internal fun alertsFor(
	hold: PhoneHold?,
	self: HoldSelf?,
	now: Long,
	visible: Boolean,
	todayRule: Boolean,
	windowMs: Long = PHONE_HOLD_WINDOW_MS,
): Boolean = when (holdStanding(hold, now, windowMs)) {
	HoldStanding.NONE, HoldStanding.LAPSED -> todayRule
	HoldStanding.HELD -> self?.holds(hold?.holder) == true && !visible
}
