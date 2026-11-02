package com.atelier_nyaarium.switchboard

import java.net.URLEncoder

private val GSM_7_BASIC =
	"@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ " +
		"!\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
		"ÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"

internal fun phoneNumberOf(raw: String): String? {
	val value = raw.trim()
	if (value.isEmpty() || value.length > 40) return null
	val number = StringBuilder(value.length)
	for (character in value) {
		when {
			character in '0'..'9' -> number.append(character)
			character == '+' && number.isEmpty() -> number.append(character)
			character == ' ' || character == '-' || character == '.' ||
				character == '(' || character == ')' -> Unit
			else -> return null
		}
	}
	return number.toString().takeIf { it.isNotEmpty() && it != "+" && it.length <= 40 }
}

internal fun smsUri(number: String): String = "smsto:$number"

internal fun telUri(number: String): String = "tel:" + URLEncoder.encode(number, "UTF-8")

internal fun smsBodyOf(body: String?): String? =
	body?.trim()?.take(1000)?.takeIf { it.isNotEmpty() }

/** Two septets each. */
private val GSM_7_EXTENSION = "^{}\\[]~|€" + Char(0x0c)

internal fun smsParts(body: String): Int {
	val gsm7 = body.all { it in GSM_7_BASIC || it in GSM_7_EXTENSION }
	var units = 0
	for (character in body) units += if (gsm7 && character in GSM_7_EXTENSION) 2 else 1
	val singlePart = if (gsm7) 160 else 70
	val multipart = if (gsm7) 153 else 67
	return if (units <= singlePart) 1 else 1 + (units - 1) / multipart
}
