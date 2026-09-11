import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/residue.js";

const ANDROID_SRC = path.join(import.meta.dirname, "..", "..", "android", "app", "src");
const TS_SRC = path.join(import.meta.dirname, "..");

/** The words of the era when one Gateway was the phone's, and the sentinel for its Domain. */
const RETIRED =
	/\b(?:homeGateway|homeGatewayId|KEY_GATEWAY_ID|blobGateway|fromGateway|requesterGatewayId|LOCAL_DOMAIN_SENTINEL)\b|\bAddress\.local\b/;

/** The Gateway-to-Gateway presence road; the Router's `linked` projection is the one cross-Domain presence. */
const RETIRED_TS =
	/\b(?:crossDomainPresence(?:Consumer|Source|Pusher|Reconciler)|presenceExchange|routesFederationPresence|presenceForDomain|pullPresenceFromDomain|pushPresenceToDomain|landCrossDomainPresence|stopPresencePushes|ListTeamsRelayResult|ConsoleListTeamsResult|presence_push|list_teams)\b/;

/** Comments go; strings stay, since a wire key is one. */
function code(file: string): string {
	return fs
		.readFileSync(file, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ");
}

describe("home gateway residue", () => {
	it("no phone source names the home Gateway", () => {
		const files = filesUnder(ANDROID_SRC, ".kt").filter((f) => !f.includes(`${path.sep}build${path.sep}`));
		expect(files.length).toBeGreaterThan(100);
		const offenders = files.filter((f) => RETIRED.test(code(f))).map((f) => path.relative(ANDROID_SRC, f));
		expect(offenders).toEqual([]);
	});

	it("no gateway or Router source names the home Gateway or the Gateway-to-Gateway presence road", () => {
		const self = path.join(TS_SRC, "__tests__", "home-gateway-residue.test.ts");
		const files = filesUnder(TS_SRC, ".ts").filter((f) => f !== self);
		expect(files.length).toBeGreaterThan(100);
		const offenders = files
			.filter((f) => RETIRED.test(code(f)) || RETIRED_TS.test(code(f)))
			.map((f) => path.relative(TS_SRC, f));
		expect(offenders).toEqual([]);
	});
});
