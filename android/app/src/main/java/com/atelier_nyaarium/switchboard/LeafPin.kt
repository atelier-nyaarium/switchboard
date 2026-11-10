package com.atelier_nyaarium.switchboard

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate

/** Throws unless the leaf's SHA-256 fingerprint equals [expectedFpHex]. The pin is the trust: a
 * self-signed leaf has no CA chain for the platform to check. */
internal fun checkPinnedLeaf(chain: Array<X509Certificate>, expectedFpHex: String) {
	val leaf = chain.firstOrNull() ?: throw CertificateException("empty certificate chain")
	val fp = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
	if (!MessageDigest.isEqual(fp.toByteArray(), expectedFpHex.lowercase().toByteArray())) {
		throw CertificateException("pinned certificate fingerprint mismatch")
	}
}
