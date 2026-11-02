import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
		const expected = PHONE_CAPABILITY_KEYS.filter((key) => PHONE_CAPABILITIES[key].where === "phone").map((key) => {
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
		for (const key of PHONE_CAPABILITY_KEYS.filter(
			(candidate) => PHONE_CAPABILITIES[candidate].where === "phone",
		)) {
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

	it("bounds notification reads and guarded replies", () => {
		const recent = PHONE_CAPABILITIES.notifications_recent;
		const reply = PHONE_CAPABILITIES.notification_reply;
		const notification = {
			id: "listener-key",
			app: "Mail",
			package: "org.example.mail",
			postedAt: "2026-11-01T12:00:00-07:00",
			replyable: true,
		};

		expect(recent.request.safeParse({ app: "Mail", limit: 30 }).success).toBe(true);
		expect(recent.request.safeParse({ app: "", limit: 31 }).success).toBe(false);
		expect(recent.answer.safeParse({ notifications: [notification] }).success).toBe(true);
		expect(recent.answer.safeParse({ notifications: Array(31).fill(notification) }).success).toBe(false);
		expect(reply.request.safeParse({ id: "listener-key", text: "Thanks" }).success).toBe(true);
		expect(reply.request.safeParse({ id: "", text: "" }).success).toBe(false);
		expect(reply.request.safeParse({ id: "listener-key", text: "x".repeat(1001) }).success).toBe(false);
	});
});
