import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE_SLICE } from "../federation-server/casMutation.js";
import { EnrollmentCoordinator } from "../federation-server/enrollmentCoordinator.js";
import type { EnrollmentState, FederationSecret } from "../federation-server/federationSecret.js";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import { ConflictError, type SecretIO } from "../federation-server/secretIO.js";
import { signAdmission } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";
import { PostRenameSyncError } from "../shared/write-result.js";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "switchboard-federation-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rooted(ownerSignPub: string, extra: Partial<EnrollmentState> = {}): EnrollmentState {
	return { ownerSignPub, ownerBoxPub: null, admissions: [], revocations: [], ...extra };
}

function fakeIO(initial?: FederationSecret) {
	let stored = initial ?? null;
	let version = initial ? 1 : 0;
	const io: SecretIO = {
		read: async () => (stored ? { value: stored, resourceVersion: String(version) } : null),
		write: async (value) => {
			stored = value;
			version++;
		},
	};
	return { io, get: () => stored };
}

describe("FileSecretStore", () => {
	it("mints and persists identity on first boot", async () => {
		const dir = tempDir();
		const store = new FileSecretStore(dir);
		const identity = await store.init();
		const persisted = JSON.parse(readFileSync(path.join(dir, "federation.json"), "utf8")) as FederationSecret;
		expect(persisted.schema).toBe(2);
		expect(persisted.identity.sign.pub).toBe(identity.sign.pub);
		expect(persisted.enrollment).toEqual({});
	});

	it("loads the same identity and domain after a second boot", async () => {
		const dir = tempDir();
		const first = new FileSecretStore(dir);
		const identity = await first.init();
		first.saveDomain("alice", rooted("owner"));
		await first.flushDomain("alice");
		const second = new FileSecretStore(dir);
		const loaded = await second.init();
		expect(loaded.sign.priv).toBe(identity.sign.priv);
		expect(second.loadDomain("alice")?.ownerSignPub).toBe("owner");
	});

	it("publishes only after a write lands", async () => {
		const { io } = fakeIO();
		const store = new FileSecretStore(tempDir(), io);
		await store.init();
		store.saveDomain("alice", rooted("owner"));
		await store.flushDomain("alice");
		expect(store.loadDomain("alice")?.ownerSignPub).toBe("owner");
	});

	it("returns a copy of the loaded domain", async () => {
		const { io } = fakeIO({
			schema: 2,
			identity: generateIdentity(),
			enrollment: { alice: rooted("owner") },
		});
		const store = new FileSecretStore(tempDir(), io);
		await store.init();

		const loaded = store.loadDomain("alice");
		if (!loaded) throw new Error();
		loaded.ownerSignPub = "changed";
		expect(store.loadDomain("alice")?.ownerSignPub).toBe("owner");
	});

	it("runs a domain mutation queued behind a save that failed", async () => {
		const { io } = fakeIO();
		const write = io.write;
		let failNext = false;
		io.write = async (value, version) => {
			if (failNext) {
				failNext = false;
				throw new Error("disk full");
			}
			await write(value, version);
		};
		const store = new FileSecretStore(tempDir(), io);
		await store.init();

		failNext = true;
		store.saveDomain("alice", rooted("owner"));
		const mutated = store.mutateDomain("bob", () => ({ commit: true, next: rooted("friend"), value: "ok" }));

		await expect(store.flushDomain("alice")).rejects.toThrow();
		await expect(mutated).resolves.toBe("ok");
		expect(store.loadDomain("bob")?.ownerSignPub).toBe("friend");
	});

	it("flushes a successful retry after a failed domain save", async () => {
		const { io } = fakeIO();
		const write = io.write;
		let fail = false;
		io.write = async (value, version) => {
			if (fail) {
				fail = false;
				throw new Error();
			}
			await write(value, version);
		};
		const store = new FileSecretStore(tempDir(), io);
		await store.init();
		fail = true;
		store.saveDomain("alice", rooted("first"));
		const retry = store.mutateDomain("alice", () => ({ commit: true, next: rooted("retry"), value: true }));

		await expect(retry).resolves.toBe(true);
		await expect(store.flushDomain("alice")).resolves.toBeUndefined();
		expect(store.loadDomain("alice")?.ownerSignPub).toBe("retry");
	});

	it("preserves domains and resolves the marked admin", async () => {
		const { io } = fakeIO({
			schema: 2,
			identity: generateIdentity(),
			enrollment: { admin: rooted("a", { isAdminDomain: true }), guest: rooted("g") },
		});
		const store = new FileSecretStore(tempDir(), io);
		await store.init();
		expect(store.listDomains().map((entry) => entry.domainId)).toEqual(["admin", "guest"]);
		expect(store.adminDomainId()).toBe("admin");
	});

	it("fails closed for multiple admin domains", async () => {
		const { io } = fakeIO({
			schema: 2,
			identity: generateIdentity(),
			enrollment: { zeta: rooted("z", { isAdminDomain: true }), alpha: rooted("a", { isAdminDomain: true }) },
		});
		const store = new FileSecretStore(tempDir(), io);
		await store.init();
		expect(store.adminDomainId()).toBeNull();
	});

	it("re-reads and re-applies a domain mutation after conflict", async () => {
		const identity = generateIdentity();
		let stored: FederationSecret = { schema: 2, identity, enrollment: { alice: rooted("a") } };
		let version = 1;
		let conflict = true;
		const io: SecretIO = {
			read: async () => ({ value: stored, resourceVersion: String(version) }),
			write: async (value) => {
				if (conflict) {
					conflict = false;
					stored = { ...stored, enrollment: { ...stored.enrollment, winner: rooted("w") } };
					version++;
					throw new ConflictError("conflict");
				}
				stored = value;
				version++;
			},
		};
		const store = new FileSecretStore(tempDir(), io);
		await store.init();
		await store.mutateDomain("alice", (current) => ({
			commit: true,
			next: { ...current!, displayName: "Alice" },
			value: true,
		}));
		expect(stored.enrollment.winner.ownerSignPub).toBe("w");
		expect(stored.enrollment.alice.displayName).toBe("Alice");
	});

	it("mutates and deletes a domain slice", async () => {
		const { io } = fakeIO();
		const store = new FileSecretStore(tempDir(), io);
		await store.init();
		await store.mutateDomain("alice", () => ({ commit: true, next: rooted("a"), value: "created" }));
		expect(store.loadDomain("alice")?.ownerSignPub).toBe("a");
		await store.mutateDomain("alice", () => ({ commit: true, next: DELETE_SLICE, value: undefined }));
		expect(store.loadDomain("alice")).toBeNull();
	});

	it("commits the whole-secret admin nonce ledger atomically", async () => {
		const { io } = fakeIO();
		const store = new FileSecretStore(tempDir(), io);
		await store.init();
		await store.mutateSecret(({ enrollment }) => ({
			commit: true,
			enrollment: { ...enrollment, guest: rooted("guest") },
			seenAdminNonces: [{ nonce: "admin-op", at: 1000 }],
			value: "recorded",
		}));
		expect(store.loadDomain("guest")?.ownerSignPub).toBe("guest");
		expect(store.loadSeenAdminNonces()).toEqual([{ nonce: "admin-op", at: 1000 }]);
	});

	it("rewrites a duplicate admission after a directory sync failure", async () => {
		const dir = tempDir();
		const store = new FileSecretStore(dir);
		await store.init();
		const owner = generateIdentity();
		const subject = generateIdentity();
		store.saveDomain("alice", rooted(owner.sign.pub));
		await store.flushDomain("alice");
		const coordinator = new EnrollmentCoordinator(
			store.persistedIdentity,
			store.domainStore("alice"),
			"alice",
			processAmbient(),
		);
		const admission = signAdmission(
			{
				kind: "gateway",
				signPub: subject.sign.pub,
				boxPub: subject.box.pub,
				gatewayId: "laptop",
				issuedAt: Date.now(),
				nonce: "durable-admission",
			},
			owner.sign.priv,
			owner.sign.pub,
		);
		const original = fs.fsyncSync;
		let directorySyncs = 0;
		let failDirectorySync = true;
		const sync = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor: number) => {
			if (fs.fstatSync(descriptor).isDirectory()) {
				directorySyncs += 1;
				if (failDirectorySync) {
					failDirectorySync = false;
					throw new Error();
				}
			}
			return original(descriptor);
		});
		try {
			await expect(coordinator.admit(admission)).rejects.toBeInstanceOf(PostRenameSyncError);
			const onDisk = JSON.parse(readFileSync(path.join(dir, "federation.json"), "utf8")) as FederationSecret;
			expect(onDisk.enrollment.alice?.admissions).toEqual([admission]);
			await expect(coordinator.admit(admission)).resolves.toBeNull();
			expect(directorySyncs).toBe(2);
			expect(store.loadDomain("alice")?.admissions).toEqual([admission]);
		} finally {
			sync.mockRestore();
		}
	});
});
