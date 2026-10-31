import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ASSISTANT_ONLY_TOOLS, ASSISTANT_SWITCHBOARD_TOOLS } from "../shared/assistant-session.js";
import { ASSISTANT_ACTION_KEYS } from "../shared/schemasAssistantActions.js";
import { PHONE_CAPABILITIES, PHONE_CAPABILITY_KEYS } from "../shared/schemasPhoneCapabilities.js";

const FIXTURE = path.join(import.meta.dirname, "../../tests/fixtures/phone-capabilities/registry.json");
const registry = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Array<{
	key: string;
	kind: string;
	where: string;
	needs: string[];
	requestId: string;
	answerId: string;
	describeHash: string;
}>;

describe("phone capability registry fixture", () => {
	it("matches the registry in order", () => {
		const expected = PHONE_CAPABILITY_KEYS.map((key) => {
			const capability = PHONE_CAPABILITIES[key];
			return {
				key,
				kind: capability.kind,
				where: capability.where,
				needs: [...capability.needs],
				requestId: capability.request.meta()?.id,
				answerId: capability.answer.meta()?.id,
				describeHash: createHash("sha256").update(capability.describe, "utf8").digest("hex"),
			};
		});
		expect(registry).toEqual(expected);
	});

	it("keeps request roots strict and identified", () => {
		for (const key of PHONE_CAPABILITY_KEYS) {
			const capability = PHONE_CAPABILITIES[key];
			const requestId = capability.request.meta()?.id;
			const jsonSchema = capability.request.toJSONSchema() as { $defs?: Record<string, unknown> };
			expect(capability.request).toBeInstanceOf(z.ZodObject);
			expect(requestId).toEqual(expect.any(String));
			expect(jsonSchema.$defs?.[requestId ?? ""]).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
			expect(capability.answer.meta()?.id).toEqual(expect.any(String));
		}
	});

	it("keeps capability tools in the assistant scope", () => {
		for (const key of PHONE_CAPABILITY_KEYS) {
			expect(ASSISTANT_ACTION_KEYS).not.toContain(key);
			expect(ASSISTANT_SWITCHBOARD_TOOLS).toContain(key);
			expect(ASSISTANT_ONLY_TOOLS).toContain(key);
		}
	});
});
