export const meta = {
	name: "mock-build-loop",
	description: "Implementer and tester pair loop until the mock build passes, then a verifier checks VERSION",
	phases: [
		{ title: "Implement", detail: "implementer builds, tester runs the tests, repeat until green" },
		{ title: "Verify", detail: "one verifier confirms VERSION is 5" },
	],
};

const DIR = args.dir;
const MAX_ROUNDS = 8;

const TEST_SCHEMA = {
	type: "object",
	properties: {
		pass: { type: "boolean" },
		version: { type: "integer" },
		failure: { type: ["string", "null"] },
	},
	required: ["pass", "version", "failure"],
	additionalProperties: false,
};

const VERIFY_SCHEMA = {
	type: "object",
	properties: {
		version: { type: "integer" },
		isFive: { type: "boolean" },
	},
	required: ["version", "isFive"],
	additionalProperties: false,
};

phase("Implement");
let lastFailure = null;
let round = 0;
let green = false;

while (!green && round < MAX_ROUNDS) {
	round += 1;
	await agent(
		`
Mock implementer, round ${round}. Working directory: ${DIR}.
${lastFailure ? `The tester reported: ${lastFailure}` : "First round."}
Run \`node build.mjs\` once, then end your turn replying only: Mock edit and build.
Don't edit any file yourself.
		`.trim(),
		{ thread: "implementer", label: `implement:${round}`, phase: "Implement" },
	);

	const report = await agent(
		`
Mock tester. Working directory: ${DIR}.
Run \`node test.mjs\` once and report what it printed. Don't edit any file.
		`.trim(),
		{ schema: TEST_SCHEMA, label: `test:${round}`, phase: "Implement" },
	);

	if (report === null) {
		log(`round ${round}: tester gave no valid report`);
		lastFailure = "the tester could not report";
		continue;
	}
	log(`round ${round}: v${report.version} ${report.pass ? "pass" : report.failure}`);
	green = report.pass;
	lastFailure = report.failure;
}

if (!green) return { ok: false, rounds: round, lastFailure };

phase("Verify");
const verdict = await agent(
	`
Mock verifier. Working directory: ${DIR}.
Read the VERSION file and report its number, and whether it is 5. Don't edit any file.
	`.trim(),
	{ schema: VERIFY_SCHEMA, label: "verify", phase: "Verify" },
);

return { ok: verdict?.isFive === true, rounds: round, version: verdict?.version ?? null };
