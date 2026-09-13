package com.atelier_nyaarium.switchboard.crypto

import com.atelier_nyaarium.switchboard.proto.Revocation
import com.atelier_nyaarium.switchboard.proto.SignedRevocation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SelfRevocationVectorsTest {
	@Test
	fun reproducesTheNodeVector() {
		val root = Json.parseToJsonElement(
			javaClass.classLoader!!.getResourceAsStream("self-revocation/vectors.json")!!.bufferedReader().readText(),
		).jsonObject
		val value = root["revocation"]!!.jsonObject
		val revocation = Revocation(
			value["signPub"]!!.jsonPrimitive.content,
			value["issuedAt"]!!.jsonPrimitive.long,
			value["nonce"]!!.jsonPrimitive.content,
		)
		val gatewayId = root["gatewayId"]!!.jsonPrimitive.content
		assertEquals(root["signingBytes"]!!.jsonPrimitive.content, AdmissionCrypto.selfRevocationSigningBytes(revocation, gatewayId).toString(Charsets.UTF_8))
		assertTrue(
			AdmissionCrypto.verifySelfRevocation(
				SignedRevocation(revocation, root["signer"]!!.jsonObject["pub"]!!.jsonPrimitive.content, root["signature"]!!.jsonPrimitive.content),
				gatewayId,
			),
		)
	}
}
