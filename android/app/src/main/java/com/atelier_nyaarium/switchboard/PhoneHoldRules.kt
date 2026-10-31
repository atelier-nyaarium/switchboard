package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PhoneHold
import com.atelier_nyaarium.switchboard.proto.Protocol

internal val PHONE_HOLD_PLANE: String = Protocol.Wire.PHONE_HOLD_PLANE
internal val PHONE_HOLD_WINDOW_MS: Long = Protocol.Wire.PHONE_HOLD_WINDOW_MS.toLong()

internal enum class HoldStanding { NONE, HELD, LAPSED }

internal fun holdStanding(hold: PhoneHold?, now: Long, windowMs: Long = PHONE_HOLD_WINDOW_MS): HoldStanding = when {
	hold == null -> HoldStanding.NONE
	now - hold.claimedAt < windowMs -> HoldStanding.HELD
	else -> HoldStanding.LAPSED
}

internal fun isLapsed(hold: PhoneHold?, now: Long, windowMs: Long = PHONE_HOLD_WINDOW_MS): Boolean =
	holdStanding(hold, now, windowMs) == HoldStanding.LAPSED

internal fun isCurrentPhoneHolder(hold: PhoneHold?, self: String, now: Long): Boolean =
	holdStanding(hold, now) == HoldStanding.HELD && hold?.holder == self

internal fun speaksFor(
	hold: PhoneHold?,
	self: String,
	now: Long,
	todayRule: Boolean,
	windowMs: Long = PHONE_HOLD_WINDOW_MS,
): Boolean = when (holdStanding(hold, now, windowMs)) {
	HoldStanding.NONE, HoldStanding.LAPSED -> todayRule
	HoldStanding.HELD -> hold?.holder == self
}

internal fun alertsFor(
	hold: PhoneHold?,
	self: String,
	now: Long,
	visible: Boolean,
	todayRule: Boolean,
	windowMs: Long = PHONE_HOLD_WINDOW_MS,
): Boolean = when (holdStanding(hold, now, windowMs)) {
	HoldStanding.NONE, HoldStanding.LAPSED -> todayRule
	HoldStanding.HELD -> hold?.holder == self && !visible
}
