import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PHONE_CAPABILITIES, PHONE_CAPABILITY_KEYS } from "../src/shared/schemasPhoneCapabilities.js";

const output = path.resolve(import.meta.dirname, "../tests/fixtures/phone-capabilities/registry.json");
const rows = PHONE_CAPABILITY_KEYS.map((key) => {
	const capability = PHONE_CAPABILITIES[key];
	const requestId = capability.request.meta()?.id;
	const answerId = capability.answer.meta()?.id;
	if (!requestId || !answerId) throw new Error(`${key} schemas need root ids`);

	return {
		key,
		kind: capability.kind,
		where: capability.where,
		needs: capability.needs,
		requestId,
		answerId,
		describeHash: createHash("sha256").update(capability.describe, "utf8").digest("hex"),
	};
});

fs.mkdirSync(path.dirname(output), { recursive: true });
const rendered = rows.map((row) => {
	const fields = Object.entries(row).map(([key, value], index, all) => {
		const comma = index < all.length - 1 ? "," : "";
		return `\t\t"${key}": ${JSON.stringify(value)}${comma}`;
	});
	return `\t{\n${fields.join("\n")}\n\t}`;
});
fs.writeFileSync(output, `[\n${rendered.join(",\n")}\n]\n`);
