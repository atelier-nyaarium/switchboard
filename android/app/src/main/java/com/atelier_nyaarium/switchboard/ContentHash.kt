package com.atelier_nyaarium.switchboard

import java.security.MessageDigest

/** Lexicon's `hashContent`: sha256 of the UTF-8 text, its first 32 hex characters. */
internal fun hashContent(text: String): String =
	MessageDigest.getInstance("SHA-256")
		.digest(text.toByteArray(Charsets.UTF_8))
		.joinToString("") { "%02x".format(it) }
		.take(32)
