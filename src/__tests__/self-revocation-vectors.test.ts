import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selfRevocationSigningBytes, verifySelfRevocation } from "../shared/admission.js";

const vector = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "../../tests/fixtures/self-revocation/vectors.json"), "utf8"),
);

describe("self revocation vectors", () => {
	it("reproduces the self-signed vector", () => {
		const bytes = selfRevocationSigningBytes(vector.revocation, vector.gatewayId);
		expect(bytes.toString("utf8")).toBe(vector.signingBytes);
		expect(bytes.toString("hex")).toBe(vector.signingBytesHex);
		expect(
			verifySelfRevocation(
				{
					revocation: vector.revocation,
					ownerSignPub: vector.signer.pub,
					signature: vector.signature,
				},
				vector.gatewayId,
			),
		).toBe(true);
	});
});
