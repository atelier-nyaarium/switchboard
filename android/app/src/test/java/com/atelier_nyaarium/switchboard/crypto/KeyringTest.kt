package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Admission
import com.atelier_nyaarium.switchboard.proto.DomainSnapshot
import com.atelier_nyaarium.switchboard.proto.Revocation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The device-side trust rule: the Console resolves a Gateway only through an
 * owner-signed, non-revoked admission. A forged admission (signed by anyone but the
 * pinned owner) and a revoked one both fail to resolve, so a compromised relay can
 * never hand the Console a Gateway key it did not owner-admit.
 */
class KeyringTest {
	private val owner = Crypto.generateIdentity()
	private val gatewayA = Crypto.generateIdentity()

	private fun admit(id: Crypto.Identity, gatewayId: String, issuedAt: Long, ownerKey: Crypto.Identity = owner) =
		AdmissionCrypto.signAdmission(
			Admission("gateway", id.sign.pub, id.box.pub, gatewayId, issuedAt, "n-$issuedAt"),
			ownerKey.sign.priv,
			ownerKey.sign.pub,
		)

	@Test
	fun resolvesAnOwnerAdmittedGateway() {
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admit(gatewayA, "sakura", 1000L)), emptyList()))
		val resolved = keyring.resolveGateway("sakura")
		assertEquals(gatewayA.box.pub, resolved?.boxPub)
		assertEquals(gatewayA.sign.pub, resolved?.signPub)
	}

	@Test
	fun rejectsAForgedAdmission() {
		// Signed by an attacker key, not the pinned owner: must not resolve.
		val attacker = Crypto.generateIdentity()
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admit(gatewayA, "sakura", 1000L, attacker)), emptyList()))
		assertNull(keyring.resolveGateway("sakura"))
	}

	@Test
	fun rejectsARevokedGateway() {
		val revocation = AdmissionCrypto.signRevocation(
			Revocation(gatewayA.sign.pub, 2000L, "rev"),
			owner.sign.priv,
			owner.sign.pub,
		)
		val keyring = Keyring(DomainSnapshot(owner.sign.pub, listOf(admit(gatewayA, "sakura", 1000L)), listOf(revocation)))
		assertNull(keyring.resolveGateway("sakura"))
	}

	@Test
	fun selfRevocationRetiresOnlyAGateway() {
		val console = Crypto.generateIdentity()
		val consoleAdmission = AdmissionCrypto.signAdmission(
			Admission("console", console.sign.pub, console.box.pub, null, 1000L, "console"),
			owner.sign.priv,
			owner.sign.pub,
		)
		val gatewayRevocation = AdmissionCrypto.signSelfRevocation(Revocation(gatewayA.sign.pub, 2000L, "gateway"), "sakura", gatewayA.sign.priv)
		val consoleRevocation = AdmissionCrypto.signSelfRevocation(Revocation(console.sign.pub, 2000L, "console-revoke"), "console", console.sign.priv)
		val keyring = Keyring(
			DomainSnapshot(owner.sign.pub, listOf(admit(gatewayA, "sakura", 1000L), consoleAdmission), listOf(gatewayRevocation, consoleRevocation)),
		)
		assertNull(keyring.resolveGateway("sakura"))
		assertEquals(console.sign.pub, keyring.resolveAdmittedConsole(console.sign.pub)?.signPub)
	}

	@Test
	fun selfRevocationDoesNotCrossGatewayIds() {
		val a = AdmissionCrypto.signAdmission(Admission("gateway", gatewayA.sign.pub, gatewayA.box.pub, "a", 1000L, "a"), owner.sign.priv, owner.sign.pub)
		val b = AdmissionCrypto.signAdmission(Admission("gateway", gatewayA.sign.pub, gatewayA.box.pub, "b", 1000L, "b"), owner.sign.priv, owner.sign.pub)
		val revocation = AdmissionCrypto.signSelfRevocation(Revocation(gatewayA.sign.pub, 2000L, "retire"), "a", gatewayA.sign.priv)
		assertNull(Keyring(DomainSnapshot(owner.sign.pub, listOf(a), listOf(revocation))).resolveGateway("a"))
		assertEquals(gatewayA.sign.pub, Keyring(DomainSnapshot(owner.sign.pub, listOf(b), listOf(revocation))).resolveGateway("b")?.signPub)
	}

	@Test
	fun newestAdmissionWins() {
		val rotated = Crypto.generateIdentity()
		val keyring = Keyring(
			DomainSnapshot(
				owner.sign.pub,
				listOf(admit(gatewayA, "sakura", 1000L), admit(rotated, "sakura", 3000L)),
				emptyList(),
			),
		)
		assertEquals(rotated.box.pub, keyring.resolveGateway("sakura")?.boxPub)
	}
}
