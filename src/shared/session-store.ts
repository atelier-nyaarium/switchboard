import type { Clock } from "./ambient.js";
import { ASSISTANT_SESSION_NAME, ASSISTANT_TEAM } from "./assistant-session.js";
import {
	type CodexAgentCatalog,
	CodexAgentCatalogSchema,
	type CodexPersistedAgent,
	restoreCodexAgentCatalog,
} from "./codex-agent.js";
import {
	type CopilotAgentCatalog,
	CopilotAgentCatalogSchema,
	type CopilotPersistedAgent,
	restoreCopilotAgentCatalog,
} from "./copilot-agent.js";
import { hostSpawnIds, isHostSpawn } from "./host-spawn.js";
import {
	foldHarness,
	HARNESS,
	mintedIdOf,
	readHarness,
	type SessionHarness,
	UNPICKED_WORD,
} from "./session-harness.js";
import { composeSessionName, isComposite, isSlug, parseSessionName } from "./session-id.js";
import { LABEL_MAX, sanitizeLabel, sanitizeWorkdirPath } from "./session-sanitize.js";
import { bindingTokensEqual, randomBindToken, randomId, randomSessionUuid } from "./session-tokens.js";

export interface LiveRef {
	team: string;
	subId: string;
}

export interface SessionRecord {
	id: string;
	sessionLabel: string;
	spawn: string;
	workdirHint?: string;
	workdirPath?: string;
	claudeSessionId?: string;
	/** Fixed at create; absent only while a create waits on its place to name it. */
	harness?: SessionHarness;
	/** Minted for a CLI that takes its id. */
	mintedSessionId?: string;
	mintedFrom?: string;
	bindToken?: string;
	bindActiveAt?: number;
	liveTeam?: LiveRef;
	confirmedAt?: number;
	lastSeen: number;
}

/** The id a launch resumes under. */
export function resumeIdOf(record: SessionRecord): string | undefined {
	if (!record.harness) return undefined;
	return HARNESS[record.harness].sessionId.minted ? record.mintedSessionId : record.claudeSessionId;
}

export type PersistedSessionRecord = Omit<SessionRecord, "liveTeam" | "harness"> & {
	/** `unpicked` while a create waits on its place. */
	harness?: SessionHarness | typeof UNPICKED_WORD;
	// FIXME 2026-11-23: drop. Twin of `mintedSessionId`.
	copilotSessionId?: string;
	codexCatalog?: CodexAgentCatalog;
	copilotCatalog?: CopilotAgentCatalog;
};

export type AgentCatalogCommitResult<Catalog> =
	| { committed: true; catalog: Catalog }
	| { committed: false; reason: "owner_missing" | "revision_conflict" | "unconfirmed" };

export type AgentCatalogCheckpointResult<Catalog> =
	| { confirmed: true; catalog: Catalog }
	| { confirmed: false; reason: "owner_missing" | "revision_conflict" | "unconfirmed" };

export interface AgentCatalogWriter<Catalog, Agent> {
	commit(owner: SessionRecord, expectedRevision: number, agents: readonly Agent[]): AgentCatalogCommitResult<Catalog>;
	isDurable(owner: SessionRecord, revision: number): boolean;
	checkpoint(owner: SessionRecord, expectedRevision: number): AgentCatalogCheckpointResult<Catalog>;
}

export type CodexCatalogCommitResult = AgentCatalogCommitResult<CodexAgentCatalog>;
export type CodexCatalogCheckpointResult = AgentCatalogCheckpointResult<CodexAgentCatalog>;
export type CodexCatalogWriter = AgentCatalogWriter<CodexAgentCatalog, CodexPersistedAgent>;
export type CopilotCatalogCommitResult = AgentCatalogCommitResult<CopilotAgentCatalog>;
export type CopilotCatalogCheckpointResult = AgentCatalogCheckpointResult<CopilotAgentCatalog>;
export type CopilotCatalogWriter = AgentCatalogWriter<CopilotAgentCatalog, CopilotPersistedAgent>;

export type ClashPredicate = (id: string) => boolean;

export interface SweepCap {
	maxEntries: number;
	isLive: (team: string) => boolean;
}

export interface SweepPolicy {
	cap?: SweepCap;
	/** Neither age nor capacity takes it. */
	isReserved?: (team: string) => boolean;
}

export interface SessionStoreOptions {
	clash?: ClashPredicate;
	ambient: Clock;
	idGen?: () => string;
	tokenGen?: () => string;
	uuidGen?: () => string;
	codexCatalogPersistence?: {
		persistChecked: () => boolean | undefined;
		receiveWriter: (writer: CodexCatalogWriter) => void;
	};
	copilotCatalogPersistence?: {
		persistChecked: () => boolean | undefined;
		receiveWriter: (writer: CopilotCatalogWriter) => void;
	};
}

interface CreateOpts {
	spawn: string;
	sessionLabel?: string;
	workdirHint?: string;
	workdirPath?: string;
	claudeSessionId?: string;
	/** Absent waits on the place. */
	harness?: SessionHarness;
	mintedFrom?: string;
}

class AgentCatalogStore<Catalog extends { revision: number }, Agent> {
	private readonly catalogs = new WeakMap<SessionRecord, Catalog>();
	private readonly unconfirmed = new WeakMap<SessionRecord, number>();

	constructor(
		private readonly parseCatalog: (candidate: unknown) => Catalog,
		private readonly ownerAlive: (owner: SessionRecord) => boolean,
	) {}

	get(owner: SessionRecord): Catalog | undefined {
		if (!this.ownerAlive(owner)) return undefined;
		const catalog = this.catalogs.get(owner);
		return catalog ? this.parseCatalog(catalog) : undefined;
	}

	commit(
		owner: SessionRecord,
		expectedRevision: number,
		agents: readonly Agent[],
		persistChecked: () => boolean | undefined,
	): AgentCatalogCommitResult<Catalog> {
		if (!this.ownerAlive(owner)) return { committed: false, reason: "owner_missing" };
		const previous = this.catalogs.get(owner);
		const currentRevision = previous?.revision ?? 0;
		if (currentRevision !== expectedRevision) return { committed: false, reason: "revision_conflict" };
		const previousUnconfirmedRevision = this.unconfirmed.get(owner);
		const next = this.parseCatalog({ version: 1, revision: expectedRevision + 1, agents });
		this.catalogs.set(owner, next);
		let confirmed: boolean | undefined;
		try {
			confirmed = persistChecked();
		} catch (error) {
			if (previous) this.catalogs.set(owner, previous);
			else this.catalogs.delete(owner);
			if (previousUnconfirmedRevision === undefined) this.unconfirmed.delete(owner);
			else this.unconfirmed.set(owner, previousUnconfirmedRevision);
			throw error;
		}
		if (confirmed === false) {
			this.unconfirmed.set(owner, next.revision);
			return { committed: false, reason: "unconfirmed" };
		}
		this.unconfirmed.delete(owner);
		return { committed: true, catalog: this.parseCatalog(next) };
	}

	isDurable(owner: SessionRecord, revision: number): boolean {
		if (!this.ownerAlive(owner)) return false;
		return this.catalogs.get(owner)?.revision === revision && this.unconfirmed.get(owner) !== revision;
	}

	checkpoint(
		owner: SessionRecord,
		expectedRevision: number,
		persistChecked: () => boolean | undefined,
	): AgentCatalogCheckpointResult<Catalog> {
		if (!this.ownerAlive(owner)) return { confirmed: false, reason: "owner_missing" };
		const catalog = this.catalogs.get(owner);
		if (!catalog || catalog.revision !== expectedRevision) {
			return { confirmed: false, reason: "revision_conflict" };
		}
		const confirmed = persistChecked();
		if (confirmed === false) {
			this.unconfirmed.set(owner, catalog.revision);
			return { confirmed: false, reason: "unconfirmed" };
		}
		this.unconfirmed.delete(owner);
		return { confirmed: true, catalog: this.parseCatalog(catalog) };
	}

	install(record: SessionRecord, catalog: Catalog): void {
		this.catalogs.set(record, catalog);
		this.unconfirmed.set(record, catalog.revision);
	}
}

export class SessionStore {
	private readonly records = new Map<string, SessionRecord>();
	/** Stored entries this build cannot read, written back untouched. */
	private readonly unread = new Map<string, unknown>();
	private readonly codexCatalogStore = new AgentCatalogStore<CodexAgentCatalog, CodexPersistedAgent>(
		(candidate) => CodexAgentCatalogSchema.parse(candidate),
		(owner) => this.records.get(this.teamOf(owner)) === owner,
	);
	private readonly copilotCatalogStore = new AgentCatalogStore<CopilotAgentCatalog, CopilotPersistedAgent>(
		(candidate) => CopilotAgentCatalogSchema.parse(candidate),
		(owner) => this.records.get(this.teamOf(owner)) === owner,
	);
	private readonly labels = new Map<string, Set<string>>();
	private readonly clash: ClashPredicate;
	private readonly now: () => number;
	private readonly idGen: () => string;
	private readonly tokenGen: () => string;
	private readonly uuidGen: () => string;

	constructor(opts: SessionStoreOptions) {
		this.clash = opts.clash ?? (() => false);
		this.now = () => opts.ambient.now();
		this.idGen = opts.idGen ?? randomId;
		this.tokenGen = opts.tokenGen ?? randomBindToken;
		this.uuidGen = opts.uuidGen ?? randomSessionUuid;
		if (opts.codexCatalogPersistence) {
			const { persistChecked, receiveWriter } = opts.codexCatalogPersistence;
			receiveWriter({
				commit: (owner, expectedRevision, agents) =>
					this.codexCatalogStore.commit(owner, expectedRevision, agents, persistChecked),
				isDurable: (owner, revision) => this.codexCatalogStore.isDurable(owner, revision),
				checkpoint: (owner, expectedRevision) =>
					this.codexCatalogStore.checkpoint(owner, expectedRevision, persistChecked),
			});
		}
		if (opts.copilotCatalogPersistence) {
			const { persistChecked, receiveWriter } = opts.copilotCatalogPersistence;
			receiveWriter({
				commit: (owner, expectedRevision, agents) =>
					this.copilotCatalogStore.commit(owner, expectedRevision, agents, persistChecked),
				isDurable: (owner, revision) => this.copilotCatalogStore.isDurable(owner, revision),
				checkpoint: (owner, expectedRevision) =>
					this.copilotCatalogStore.checkpoint(owner, expectedRevision, persistChecked),
			});
		}
	}

	// Unknown or ambiguous binding tokens resolve to nothing.
	recordByBindToken(token: string): SessionRecord | undefined {
		let found: SessionRecord | undefined;
		for (const record of this.records.values()) {
			if (!record.bindToken || !bindingTokensEqual(record.bindToken, token)) continue;
			if (found) return undefined;
			found = record;
		}
		return found;
	}

	ensureBindToken(record: SessionRecord): string {
		// Mint once because reattach never reruns the launch command.
		if (!record.bindToken) record.bindToken = this.tokenGen();
		return record.bindToken;
	}

	isBindingActive(record: SessionRecord): boolean {
		// A minted token stays inert until the launch binding is armed.
		return !!record.bindToken && record.bindActiveAt !== undefined;
	}

	activateBinding(record: SessionRecord): void {
		if (record.bindToken && record.bindActiveAt === undefined) record.bindActiveAt = this.now();
	}

	get size(): number {
		return this.records.size;
	}

	list(): SessionRecord[] {
		return [...this.records.values()];
	}

	teamOf(record: SessionRecord): string {
		return composeSessionName(record.spawn, record.id);
	}

	hostWorkdirHint(record: SessionRecord): string {
		// Preserve the chosen path across label renames.
		return record.workdirPath ?? record.workdirHint ?? record.sessionLabel;
	}

	getByTeam(team: string): SessionRecord | undefined {
		return isComposite(team) ? this.records.get(team) : undefined;
	}

	codexCatalog(owner: SessionRecord): CodexAgentCatalog | undefined {
		return this.codexCatalogStore.get(owner);
	}

	listCodexAgents(owner: SessionRecord): readonly CodexPersistedAgent[] {
		return this.codexCatalogStore.get(owner)?.agents ?? [];
	}

	copilotCatalog(owner: SessionRecord): CopilotAgentCatalog | undefined {
		return this.copilotCatalogStore.get(owner);
	}

	listCopilotAgents(owner: SessionRecord): readonly CopilotPersistedAgent[] {
		return this.copilotCatalogStore.get(owner)?.agents ?? [];
	}

	/** A name held by a record, read or not. */
	private taken(team: string): boolean {
		return this.records.has(team) || this.unread.has(team);
	}

	/** Host spawn points share one tmux server. */
	private paneTaken(spawn: string, id: string): boolean {
		if (!isHostSpawn(spawn)) return this.taken(composeSessionName(spawn, id));
		if (id === ASSISTANT_SESSION_NAME && composeSessionName(spawn, id) !== ASSISTANT_TEAM) return true;
		return hostSpawnIds().some((held) => this.taken(composeSessionName(held, id)));
	}

	/** Pane held by another record, or reserved. */
	paneHeldElsewhere(team: string): boolean {
		if (!isComposite(team) || this.taken(team)) return false;
		const { project: spawn, session: id } = parseSessionName(team);
		return this.paneTaken(spawn, id);
	}

	/** A collision re-rolls. */
	mint(opts: CreateOpts): SessionRecord {
		for (let i = 0; i < 64; i++) {
			const id = this.idGen();
			if (!this.paneTaken(opts.spawn, id) && !this.clash(id)) return this.create(id, opts);
		}
		throw new Error("session id space exhausted");
	}

	/** A chosen name never re-rolls. */
	adoptById(id: string, opts: CreateOpts): SessionRecord | null {
		if (!isSlug(id) || this.clash(id)) return null;
		if (this.paneTaken(opts.spawn, id)) return null;
		return this.create(id, opts);
	}

	adoptOrReattach(id: string, opts: CreateOpts): { record: SessionRecord; created: boolean } | null {
		const created = this.adoptById(id, opts);
		if (created) return { record: created, created: true };
		const existing = this.records.get(composeSessionName(opts.spawn, id));
		return existing ? { record: existing, created: false } : null;
	}

	/** Names a pending create's CLI, once. */
	resolvePick(team: string, harness: SessionHarness): SessionRecord | null {
		const record = this.records.get(team);
		if (!record || record.harness) return record?.harness === harness ? record : null;
		const policy = HARNESS[harness].sessionId;
		record.harness = harness;
		if (policy.minted) record.mintedSessionId = policy.mint(this.uuidGen);
		return record;
	}

	mintOrReattach(opts: CreateOpts): { record: SessionRecord; created: boolean } {
		const existing = opts.mintedFrom ? this.findByMintedFrom(opts.mintedFrom, opts.spawn) : undefined;
		if (existing) return { record: existing, created: false };
		return { record: this.mint(opts), created: true };
	}

	bindBySegment(team: string, extra: { claudeSessionId?: string; live?: LiveRef } = {}): SessionRecord | null {
		const record = this.getByTeam(team);
		return record ? this.bind(record, extra) : null;
	}

	resumeRecord(claudeSessionId: string): SessionRecord | undefined {
		for (const record of this.records.values()) {
			if (record.claudeSessionId === claudeSessionId) return record;
		}
		return undefined;
	}

	// Ambiguous provenance resolves to nothing.
	findByMintedFrom(mintedFrom: string, spawn: string): SessionRecord | undefined {
		let found: SessionRecord | undefined;
		for (const record of this.records.values()) {
			if (record.mintedFrom !== mintedFrom || record.spawn !== spawn) continue;
			if (found) return undefined;
			found = record;
		}
		return found;
	}

	bindResume(claudeSessionId: string, extra: { live?: LiveRef } = {}): SessionRecord | null {
		const record = this.resumeRecord(claudeSessionId);
		return record ? this.bind(record, { claudeSessionId, live: extra.live }) : null;
	}

	confirm(team: string, live?: LiveRef): SessionRecord | undefined {
		const record = this.records.get(team);
		if (record) {
			record.confirmedAt = this.now();
			record.lastSeen = this.now();
			if (live) record.liveTeam = live;
		}
		return record;
	}

	establishOnConfirm(
		team: string,
		{
			claudeSessionId,
			harness,
			label,
			live,
			handover = false,
		}: {
			claudeSessionId?: string;
			/** For a record this creates. Null creates none. */
			harness: SessionHarness | null;
			label?: string;
			live: LiveRef;
			handover?: boolean;
		},
	): SessionRecord | undefined {
		if (!isComposite(team)) return undefined;
		let record = this.bindBySegment(team, { claudeSessionId });
		if (!record && claudeSessionId) {
			record = this.bindResume(claudeSessionId);
			if (record && handover) {
				const previousTeam = this.teamOf(record);
				const { project: spawn, session: id } = parseSessionName(team);
				if (this.taken(team)) return undefined;
				this.records.delete(previousTeam);
				record.spawn = spawn;
				record.id = id;
				this.records.set(team, record);
			}
		}
		if (!record) {
			// A CLI with no handshake never confirms unbound.
			if (!harness || !HARNESS[harness].handshake) return undefined;
			const { project: spawn, session: id } = parseSessionName(team);
			record =
				this.adoptById(id, {
					spawn,
					sessionLabel: label,
					workdirHint: label ?? id,
					claudeSessionId,
					harness,
				}) ?? this.mint({ spawn, sessionLabel: label, workdirHint: label, claudeSessionId, harness });
		}
		return this.confirm(this.teamOf(record), live);
	}

	rename(team: string, label: string): string | null {
		const record = this.records.get(team);
		const clean = sanitizeLabel(label);
		if (!record || !clean) return null;
		this.releaseLabel(record);
		record.sessionLabel = this.dedupLabel(record.spawn, clean);
		this.claimLabel(record);
		record.lastSeen = this.now();
		return record.sessionLabel;
	}

	forget(team: string): boolean {
		const record = this.records.get(team);
		if (!record) return false;
		this.releaseLabel(record);
		return this.records.delete(team);
	}

	touchLive(team: string): void {
		const record = this.records.get(team);
		if (record) record.lastSeen = this.now();
	}

	resolveLive(team: string): LiveRef | undefined {
		return this.records.get(team)?.liveTeam;
	}

	/** Whether that socket was a record's live one. */
	clearLive(team: string, subId: string): boolean {
		let cleared = false;
		for (const record of this.records.values()) {
			if (record.liveTeam?.team === team && record.liveTeam.subId === subId) {
				record.liveTeam = undefined;
				cleared = true;
			}
		}
		return cleared;
	}

	// Sweep before snapshot so expired records never persist.
	sweep(ttlMs: number, policy: SweepPolicy = {}): string[] {
		const cutoff = this.now() - ttlMs;
		const reserved = policy.isReserved ?? (() => false);
		const removed: string[] = [];
		for (const [team, record] of this.records) {
			if (record.lastSeen < cutoff && !reserved(team)) {
				this.releaseLabel(record);
				this.records.delete(team);
				removed.push(team);
			}
		}
		const { cap } = policy;
		if (!cap || this.records.size <= cap.maxEntries) return removed;
		const evictable = [...this.records]
			.filter(([team]) => !cap.isLive(team) && !reserved(team))
			.sort((left, right) => left[1].lastSeen - right[1].lastSeen);
		for (const [team, record] of evictable) {
			if (this.records.size <= cap.maxEntries) break;
			this.releaseLabel(record);
			this.records.delete(team);
			removed.push(team);
		}
		return removed;
	}

	snapshot(): Record<string, PersistedSessionRecord> {
		const out = Object.fromEntries(this.unread) as Record<string, PersistedSessionRecord>;
		for (const record of this.records.values()) {
			const {
				codexCatalog: _escaped,
				copilotCatalog: _copilotEscaped,
				liveTeam: _live,
				...rest
			} = record as SessionRecord & {
				codexCatalog?: unknown;
				copilotCatalog?: unknown;
			};
			const codexCatalog = this.codexCatalogStore.get(record);
			const copilotCatalog = this.copilotCatalogStore.get(record);
			out[this.teamOf(record)] = {
				...rest,
				// Absent reads back as unnamed, which is Claude.
				...(rest.harness ? {} : { harness: UNPICKED_WORD }),
				// FIXME 2026-11-23: drop. Rollback twin.
				...(rest.harness === "copilot" && rest.mintedSessionId
					? { copilotSessionId: rest.mintedSessionId }
					: {}),
				...(codexCatalog ? { codexCatalog } : {}),
				...(copilotCatalog ? { copilotCatalog } : {}),
			};
		}
		return out;
	}

	restore(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		for (const [team, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			if (!isComposite(team) || this.taken(team)) continue;
			const { project: spawn, session: segment } = parseSessionName(team);
			if (!isSlug(spawn) || !isSlug(segment)) continue;
			const v = value as Partial<PersistedSessionRecord> & {
				claudeSessionId?: string;
				lastSeen?: number;
				copilotSessionId?: unknown;
			};
			if (typeof v.id !== "string") continue;
			const lastSeen = typeof v.lastSeen === "number" ? v.lastSeen : this.now();
			const harness = foldHarness(readHarness(v.harness), {
				named: (named) => named,
				unnamed: (assumed) => assumed,
				unpicked: () => undefined,
				// A newer build's CLI.
				unknown: () => null,
			});
			if (harness === null) {
				console.log(`[session] ${team} held unread: unknown CLI`);
				this.unread.set(team, value);
				continue;
			}
			const policy = harness ? HARNESS[harness].sessionId : undefined;
			// FIXME 2026-11-23: drop the `copilotSessionId` read.
			const stored = v.mintedSessionId ?? v.copilotSessionId;
			const heldId =
				harness && policy?.minted ? (mintedIdOf(harness, stored) ?? policy.mint(this.uuidGen)) : undefined;
			const record: SessionRecord = {
				id: segment,
				sessionLabel: this.dedupLabel(spawn, sanitizeLabel(v.sessionLabel) ?? segment),
				spawn,
				workdirHint: sanitizeLabel(v.workdirHint) ?? undefined,
				workdirPath: sanitizeWorkdirPath(v.workdirPath) ?? undefined,
				claudeSessionId: typeof v.claudeSessionId === "string" ? v.claudeSessionId : undefined,
				...(harness ? { harness } : {}),
				...(heldId ? { mintedSessionId: heldId } : {}),
				mintedFrom: typeof v.mintedFrom === "string" ? v.mintedFrom : undefined,
				// Restored records never mint a token for an unbound session.
				bindToken: typeof v.bindToken === "string" ? v.bindToken : undefined,
				bindActiveAt: typeof v.bindActiveAt === "number" ? v.bindActiveAt : undefined,
				confirmedAt: typeof v.confirmedAt === "number" ? v.confirmedAt : undefined,
				lastSeen,
			};
			this.records.set(team, record);
			const codexCatalog = restoreCodexAgentCatalog(v.codexCatalog);
			if (codexCatalog) this.codexCatalogStore.install(record, codexCatalog);
			const copilotCatalog = restoreCopilotAgentCatalog(v.copilotCatalog);
			if (copilotCatalog) this.copilotCatalogStore.install(record, copilotCatalog);
			this.claimLabel(record);
		}
	}

	private bind(record: SessionRecord, extra: { claudeSessionId?: string; live?: LiveRef }): SessionRecord {
		if (extra.claudeSessionId) {
			// `--resume` mints a fresh id; the log is the only trace of the fork.
			const previous = record.claudeSessionId;
			if (previous && previous !== extra.claudeSessionId) {
				console.log(`[session] ${this.teamOf(record)} transcript ${previous} -> ${extra.claudeSessionId}`);
			}
			record.claudeSessionId = extra.claudeSessionId;
		}
		if (extra.live) record.liveTeam = extra.live;
		record.lastSeen = this.now();
		return record;
	}

	private create(id: string, opts: CreateOpts): SessionRecord {
		const policy = opts.harness ? HARNESS[opts.harness].sessionId : undefined;
		const record: SessionRecord = {
			id,
			sessionLabel: this.dedupLabel(opts.spawn, sanitizeLabel(opts.sessionLabel) ?? id),
			spawn: opts.spawn,
			workdirHint: sanitizeLabel(opts.workdirHint) ?? undefined,
			workdirPath: sanitizeWorkdirPath(opts.workdirPath) ?? undefined,
			claudeSessionId: opts.claudeSessionId,
			...(opts.harness ? { harness: opts.harness } : {}),
			...(policy?.minted ? { mintedSessionId: policy.mint(this.uuidGen) } : {}),
			mintedFrom: opts.mintedFrom,
			lastSeen: this.now(),
		};
		this.records.set(this.teamOf(record), record);
		this.claimLabel(record);
		return record;
	}

	private claimLabel(record: SessionRecord): void {
		const set = this.labels.get(record.spawn) ?? new Set<string>();
		set.add(record.sessionLabel);
		this.labels.set(record.spawn, set);
	}

	private releaseLabel(record: SessionRecord): void {
		this.labels.get(record.spawn)?.delete(record.sessionLabel);
	}

	private dedupLabel(spawn: string, label: string): string {
		const taken = this.labels.get(spawn);
		if (!taken?.has(label)) return label;
		for (let n = 2; ; n++) {
			const suffix = `-${n}`;
			const candidate = `${[...label].slice(0, LABEL_MAX - suffix.length).join("")}${suffix}`;
			if (!taken.has(candidate)) return candidate;
		}
	}
}
