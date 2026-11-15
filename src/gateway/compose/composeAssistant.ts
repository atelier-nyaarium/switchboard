// The assistant's one session and its sources, placed where the Router's home record names.

import { type Ambient, withinMs } from "../../shared/ambient.js";
import type { HoldAnswer } from "../../shared/assistant-hold.js";
import {
	ASSISTANT_RESERVE_KEY,
	ASSISTANT_SESSION_NAME,
	ASSISTANT_SPAWN,
	ASSISTANT_TEAM,
	isAssistantRecord,
} from "../../shared/assistant-session.js";
import { SEND_BOUND_MS } from "../../shared/console-protocol.js";
import { openDurable } from "../../shared/durable-store.js";
import { TEST_LABELS } from "../../shared/field-types.js";
import { isSpawnWorkdirPath } from "../../shared/host-op.js";
import { createFifo } from "../../shared/keyed-fifo.js";
import { MIGRATING } from "../../shared/migration-fence.js";
import type { PendingDelivery } from "../../shared/pending-delivery-store.js";
import { actionListings } from "../../shared/schemasActionFront.js";
import {
	type AssistantSource,
	type AssistantWatcher,
	type ConsoleAssistantStateResult,
	INTEGRATION_IDS,
	type TemperatureUnit,
} from "../../shared/schemasAssistant.js";
import { actionsOf, GITHUB_SOURCE_ID } from "../../shared/schemasAssistantActions.js";
import type { AssistantHomeRecord, AssistantHomeSealed } from "../../shared/schemasAssistantHome.js";
import { eventLines } from "../../shared/schemasAssistantInbox.js";
import {
	canonicalConditions,
	conditionsIssue,
	conditionsMatch,
	DEFAULT_RULES,
	fieldsOf,
	type RuleAction,
} from "../../shared/schemasAssistantRules.js";
import type { AssistantSendRequest } from "../../shared/schemasAssistantSend.js";
import {
	AUTOMATION_PREVIEW_EVENTS,
	AUTOMATION_PREVIEW_SHOWN,
	type AutomationTrigger,
	automationsOfRules,
	type CarriedAutomation,
	type ConsoleAutomationPreviewResult,
	type EventTrigger,
	rulesOfAutomations,
} from "../../shared/schemasAutomation.js";
import { IFTTT_INTEGRATION_ID, INTEGRATION_KEYS, integrationLabel } from "../../shared/schemasIntegrations.js";
import type {
	GatewayCapabilityRuns,
	IftttTriggerAnswer,
	IftttTriggerRequest,
} from "../../shared/schemasPhoneCapabilities.js";
import type { PhoneHoldPlane } from "../../shared/schemasPhoneHold.js";
import { type BaselineHold, holdLine, type SessionBaseline } from "../../shared/session-baseline.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";
import { neutralizeMarkup } from "../../shared/system-reminder.js";
import { createActGuard } from "../assistant/actGuard.js";
import { type ActionRecord, createActionDispatch } from "../assistant/actionDispatch.js";
import { createAssistantRoutes, type Handler } from "../assistant/assistantRoutes.js";
import { approvedDeviceRun, createDeviceDispatch } from "../assistant/deviceDispatch.js";
import { createGithubClient, type GithubClientDeps, type TokenRead } from "../assistant/githubClient.js";
import { GithubDone } from "../assistant/githubDone.js";
import { createGithubSource } from "../assistant/githubSource.js";
import { createHomeFollow, type HomeFollowEffects } from "../assistant/homeFollow.js";
import { createHomeMarkStore } from "../assistant/homeMark.js";
import { createIftttClient } from "../assistant/iftttClient.js";
import { createInboxListing } from "../assistant/inboxListing.js";
import { createPhoneDispatch, holdRefusal } from "../assistant/phoneDispatch.js";
import { createPhoneRequests, type PhoneRequest, type PhoneRequestDelivery } from "../assistant/phoneRequests.js";
import { adoptStoredRules, clearStoredRules } from "../assistant/rulesAdoption.js";
import { createOriginMarker, createSafetyStore, createSendGuard } from "../assistant/sendGuard.js";
import { SensorsClear } from "../assistant/sensorsClear.js";
import { type ListPage, type ListQuery, type Source, type SourceEvent, told } from "../assistant/source.js";
import type { SourceActions } from "../assistant/sourceAction.js";
import { createSourceEnabledStore } from "../assistant/sourceEnabled.js";
import { type AssistantWake, createSourceLanes, type SourceLanes } from "../assistant/sourceLane.js";
import { createSourceStateStore, FRESH_STATE, goneAdded, unexpectedNow } from "../assistant/sourceState.js";
import { createStatusMemo } from "../assistant/statusMemo.js";
import { createTemperatureUnitStore } from "../assistant/temperatureUnit.js";
import { ASSISTANT_WAITS } from "../assistant/waits.js";
import type { Automations } from "../computed/automations.js";
import type { AssistantConsoleHandlers } from "../console/consoleTypes.js";
import { createHoldFollow } from "../phone/holdFollow.js";
import { presentedByRequest } from "../sessionAuthority.js";
import type { VaultRelease } from "../vault/vaultUse.js";
import type { DeviceStage } from "./composeDevices.js";
import type { GatewayRoutes } from "./composeRoutes.js";
import type { SessionsStage } from "./composeSessions.js";

const NEEDS_SECRET = "needs a secret";
const NOT_HERE = "the assistant does not live on this Gateway";
const STOP_WAIT_MS = 5_000;
const MOVING_HERE = "the assistant is still moving here; try again shortly";
export function renderPhoneHold(answer: HoldAnswer): { baseline: BaselineHold; line: string } {
	const baseline: BaselineHold =
		answer.kind === "held"
			? { kind: "held", label: answer.label, remainingMs: answer.remainingMs }
			: answer.kind === "lapsed"
				? { kind: "lapsed", label: answer.label, lapsedMs: answer.lapsedMs }
				: { kind: "none" };
	return { baseline, line: neutralizeMarkup(holdLine(baseline)) };
}

/** Owner send callback. */
export type AssistantNudge = (nudge: { from: string; body: string; deliveryId: string }) => Promise<string | null>;

const checkNudge = (label: string) =>
	`
The owner asked you to check ${label} now.
Call ${ASSISTANT_COMMANDS.inbox.tool} with scope "new" and handle what it lists by your rules.
Reply only if something needs the owner.
	`.trim();

/** What the assistant reaches in the vault, read late. */
export interface AssistantVault {
	serviceGrants: (sourceId: string) => string[];
	setServiceGrants: (sourceId: string, entryIds: string[]) => void;
	readForService: (sourceId: string, entryId: string) => Promise<VaultRelease>;
	/** Whether this Gateway may use the entry's value. */
	usableHere: (entryId: string) => Promise<boolean>;
}

export type AssistantAutomations = Pick<Automations, "eventsOf" | "write" | "noteEvents" | "fireEvents">;

const inSentence = (label: string) => (/^[A-Z][a-z]/.test(label) ? label[0]?.toLowerCase() + label.slice(1) : label);

/** The federation's half of following the home, bound on each activation. */
export interface AssistantHomePort {
	open: (
		record: AssistantHomeRecord,
	) => { kind: "ok"; sealed: AssistantHomeSealed } | { kind: "refused"; reason: string };
	report: HomeFollowEffects["report"];
	/** Ends the session's pane and record; throws when refused, as while it wakes. */
	endSession: () => Promise<void>;
}

export interface AssistantStageDeps {
	dataDir: string;
	localGatewayId: string;
	/** The active Domain, which scopes the home mark. */
	domainId: () => string | null;
	ambient: Pick<Ambient, "now" | "newId" | "randomBytes" | "setTimer" | "clearTimer">;
	sessions: Pick<SessionsStage, "sessionStore" | "presence" | "sessionAuthority" | "conversationRegistry">;
	/** A checked save of the session records, which hold where it lives; throws when it did not land. */
	saveSessions: () => void;
	vault: AssistantVault;
	devices?: Pick<DeviceStage, "assistant" | "record">;
	/** Resolve after Domain activation. */
	routes: () => Pick<GatewayRoutes, "deliverToOwner" | "ownerSessionKey" | "bindTarget" | "sendFromAssistant">;
	/** Null unless fully staged. */
	blobSize: (blobId: string) => number | null;
	/** The newest delivery acceptance. */
	lastDeliverySeq: () => number;
	fetch: GithubClientDeps["fetch"];
	/** Replaces the built-in sources. */
	sources?: readonly Source[];
	clearSensorEvents?: (members: readonly string[]) => boolean;
}

export interface AssistantStage {
	temperatureUnit: () => TemperatureUnit;
	/** Refuses when no key is granted. */
	iftttTrigger: (params: IftttTriggerRequest) => Promise<IftttTriggerAnswer>;
	/** Identifies sweep-exempt sessions. */
	reserves: (team: string) => boolean;
	/** Check-ins use this session. */
	placed: () => boolean;
	/** Null means unwritten. */
	follow: (record: AssistantHomeRecord | null, how: { registered: boolean }) => Promise<void>;
	followPhoneHold: (plane: PhoneHoldPlane) => void;
	holdAnswer: () => HoldAnswer;
	phoneHoldLine: () => string;
	bindHome: (port: AssistantHomePort) => void;
	forgetRefusal: (team: string) => string | null;
	console: AssistantConsoleHandlers;
	/** Assistant-only loopback routes. */
	routes: Map<string, Handler>;
	baselineFor: (team: string) => SessionBaseline["assistant"];
	/** Bound once automations open. */
	bindAutomations: (automations: AssistantAutomations) => void;
	/** Null when the trigger can run. */
	eventIssue: (trigger: EventTrigger) => string | null;
	eventSentence: (trigger: EventTrigger) => string;
	/** Over the live first page. */
	previewTrigger: (trigger: AutomationTrigger) => Promise<ConsoleAutomationPreviewResult>;
	/** Bound on federation activation. */
	bindWake: (wake: AssistantWake) => void;
	/** Check-now road. */
	bindNudge: (nudge: AssistantNudge) => void;
	/** Register before start. */
	registerSource: (source: Source) => void;
	/** Arms sources after activation. */
	start: () => void;
	pokeSource: (sourceId: string) => void;
	/** Stop lanes before flush. */
	stop: () => Promise<void>;
	/** Plugin-confirmed delivery. */
	delivered: (row: PendingDelivery) => void;
	/** Pre-delivery session offer. */
	offered: (row: PendingDelivery) => void;
	/** Reply pushed to team. */
	replyPushed: (team: string) => void;
	/** Held send blob reference. */
	namesBlob: (blobId: string) => boolean;
	sessionEnded: (team: string) => void;
}

/** The vault's answer, as a source reads it: a missing grant stops it, a transient wait backs off. */
function tokenOf(read: VaultRelease, entryId: string): TokenRead {
	if (read.kind === "released") return { kind: "token", value: read.value, key: entryId };
	if (read.kind === "unusable") return { kind: "stopped", reason: read.reason };
	return {
		kind: "backoff",
		reason: read.kind === "unready" ? `vault unavailable: ${read.reason}` : "vault key not here yet",
	};
}

export function composeAssistant(deps: AssistantStageDeps): AssistantStage {
	const { sessions, ambient } = deps;
	const held = () => {
		const record = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
		return isAssistantRecord(record) ? record : undefined;
	};
	const isAssistant = (team: string) => team === ASSISTANT_TEAM && held() !== undefined;
	const home = openDurable(deps.dataDir, "assistant-home", (store) => createHomeMarkStore(store, deps.domainId));
	/** Its routes answer only while the home lets its lanes run. */
	const acting = (record: Parameters<typeof isAssistantRecord>[0]) => isAssistantRecord(record) && home.allowsLanes();

	const tokenFor = (sourceId: string) => async (): Promise<TokenRead> => {
		const entryId = deps.vault.serviceGrants(sourceId)[0];
		if (entryId === undefined) return { kind: "stopped", reason: NEEDS_SECRET };
		return tokenOf(await deps.vault.readForService(sourceId, entryId), entryId);
	};
	const github = createGithubClient({
		fetch: deps.fetch,
		token: tokenFor(GITHUB_SOURCE_ID),
		now: () => ambient.now(),
	});
	const sources: Source[] = [...(deps.sources ?? [createGithubSource(github)])];
	const actions: SourceActions = {
		github_done: new GithubDone(github),
		sensors_clear: new SensorsClear((members) => deps.clearSensorEvents?.(members) ?? false),
	};

	// An older build reads these names.
	const sourceState = openDurable(deps.dataDir, "assistant-watchers", (store) => createSourceStateStore(store));
	const enabled = openDurable(deps.dataDir, "assistant-watcher-enabled", (store) => createSourceEnabledStore(store));
	// Unknown source returns undefined.
	const specsOf = (sourceId: string) => sources.find((candidate) => candidate.id === sourceId)?.fieldSpecs;
	const render = (source: Source, event: SourceEvent) => eventLines({ label: source.label, ...event }).join("\n");
	let automations: AssistantAutomations | null = null;
	/** Automations that wake for it. */
	const wakers = (sourceId: string, event: SourceEvent): string[] => {
		const specs = specsOf(sourceId) ?? [];
		return (automations?.eventsOf(sourceId) ?? [])
			.filter(({ trigger, when }) => when === "now" && conditionsMatch(trigger.conditions, specs, event.fields))
			.map(({ id }) => id);
	};
	/** Every match fires; one waking match wakes. */
	const decide = (sourceId: string, event: SourceEvent): RuleAction =>
		told(event) ?? (wakers(sourceId, event).length > 0 ? "wake" : "inbox");
	/** Each match runs its effects once per event. */
	const arrived = (sourceId: string, events: readonly SourceEvent[]): void => {
		const specs = specsOf(sourceId) ?? [];
		const armed = automations?.eventsOf(sourceId) ?? [];
		const label = sources.find((source) => source.id === sourceId)?.label ?? sourceId;
		const matched = events.flatMap((event) => {
			const { id, title, url, fields } = event;
			const names = {
				event: { value: { ...fields, id, title, ...(url ? { url } : {}) }, shown: title },
				source: { value: label },
			};
			return armed
				.filter(({ trigger }) => conditionsMatch(trigger.conditions, specs, fields))
				.map((held) => ({ automation: held.id, key: `event:${sourceId}:${id}`, names }));
		});
		automations?.fireEvents(matched, ambient.now());
	};
	const eventIssue = (trigger: EventTrigger): string | null => {
		const source = sources.find((candidate) => candidate.id === trigger.source);
		if (!source) return `this Gateway holds no source "${trigger.source}"`;
		if (source.selfTold) return `${source.label} events are told by their own automations`;
		return conditionsIssue(canonicalConditions(trigger.conditions), source.fieldSpecs);
	};
	const eventSentence = (trigger: EventTrigger): string => {
		const source = sources.find((candidate) => candidate.id === trigger.source);
		const said = trigger.conditions.map((condition) => {
			const spec = source?.fieldSpecs.find((candidate) => candidate.field === condition.field);
			const option =
				spec?.kind === "enumeration"
					? spec.options.find((candidate) => candidate.value === condition.value)
					: null;
			const value = option ? inSentence(option.label) : condition.value;
			return `${inSentence(spec?.label ?? condition.field)} ${TEST_LABELS[condition.test]} ${value}`;
		});
		return `${source?.brief ?? source?.label ?? trigger.source}: ${said.length > 0 ? said.join(" and ") : "every event"}`;
	};

	let lanes: SourceLanes | null = null;
	let wake: AssistantWake | null = null;
	let nudge: AssistantNudge | null = null;
	let active = false;
	let ownerOpsClosed = false;

	/** A quiet row; the phone re-reads. */
	const sourcesChanged = (sourceId: string) => {
		try {
			const routes = deps.routes();
			const sessionId = routes.ownerSessionKey(ASSISTANT_TEAM);
			if (!sessionId) return;
			routes.deliverToOwner({
				entry: {
					kind: "plugin_action",
					session_id: sessionId,
					pluginId: "assistant",
					// Becomes `sources-changed` 2026-11-28; every phone then reads both.
					actionType: "watchers-changed",
					payload: { watcherId: sourceId },
				},
				dedupeKey: `assistant-sources:${ambient.newId()}`,
				label: "assistant",
				volatile: true,
			});
		} catch (error) {
			console.warn(`[assistant] source change signal not sent: ${(error as Error).message}`);
		}
	};
	const startLanes = () => {
		if (!active || lanes || !held() || !home.allowsLanes()) return;
		lanes = createSourceLanes({
			ambient,
			state: sourceState,
			sources,
			enabled: (sourceId) => enabled.enabled(sourceId),
			sort: decide,
			wake: () => wake,
			to: ASSISTANT_TEAM,
			holdLine: () => renderPhoneHold(phoneHold.answer()).line,
			render,
			changed: sourcesChanged,
			woke: (sourceId, events) =>
				automations?.noteEvents(
					[...new Set(events.flatMap((event) => wakers(sourceId, event)))],
					ambient.now(),
				),
			arrived,
		});
		lanes.start();
	};
	const stopLanes = async () => {
		const stopping = lanes;
		lanes = null;
		await stopping?.stop();
	};
	/** One live page in the source's lane; the query is built there, so it reads the lane's mark. */
	const livePage = async <T>(
		sourceId: string,
		query: () => ListQuery,
		deadlineMs: number,
		settle: (page: ListPage) => T,
	): Promise<T> => {
		if (!lanes) throw new Error(NOT_HERE);
		const answer = await lanes.read(
			sourceId,
			deadlineMs,
			async (source, signal): Promise<ListPage> =>
				source.list ? await source.list(query(), signal) : { events: [], here: "" },
			settle,
		);
		if (answer.kind === "ran") return answer.value;
		throw new Error(answer.end === "stopping" ? "the assistant is stopping" : `${sourceId} did not answer in time`);
	};
	const inbox = createInboxListing({
		sources,
		enabled: (sourceId) => enabled.enabled(sourceId),
		state: sourceState,
		decide,
		ambient,
		livePage,
	});
	/** Owner record keyed by call id. */
	const postRecord = (callId: string, record: ActionRecord): boolean => {
		try {
			const routes = deps.routes();
			const sessionId = routes.ownerSessionKey(ASSISTANT_TEAM);
			if (!sessionId) return false;
			const entry = { kind: "assistant_record" as const, session_id: sessionId, ...record };
			return (
				routes.deliverToOwner({ entry, dedupeKey: `assistant-action:${callId}`, label: "assistant" }) === true
			);
		} catch (error) {
			console.warn(`[assistant] record not posted: ${(error as Error).message}`);
			return false;
		}
	};
	const dispatch = createActionDispatch({
		actions,
		ambient,
		write: (sourceId, deadlineMs, work) =>
			lanes ? lanes.write(sourceId, deadlineMs, work) : Promise.reject(new Error(NOT_HERE)),
		recount: (sourceId) => lanes?.recount(sourceId),
		record: postRecord,
		hideNotFound: (sourceId, ids) => {
			const held = sourceState.get(sourceId);
			if (ids.length > 0 && !sourceState.put(sourceId, goneAdded(held, ids, ambient.now()))) {
				console.warn(`[assistant] ${sourceId}: not-found threads not saved, so they stay listed`);
			}
		},
	});
	/** Serializes owner operations. */
	const ownerOps = createFifo();
	const serial = <T>(work: () => T | Promise<T>): Promise<T> =>
		ownerOps.run(() => {
			if (ownerOpsClosed) throw new Error("the Gateway is shutting down");
			return work();
		});
	/** A write that did not land answers as a refusal, never as the state it meant. */
	const grantsLanded = (sourceId: string, entryIds: readonly string[]) => {
		const held = deps.vault.serviceGrants(sourceId);
		return held.length === entryIds.length && entryIds.every((entryId) => held.includes(entryId));
	};
	const grantTargets = () => [...sources.map((source) => source.id), ...INTEGRATION_IDS];

	const sourceOf = (source: Source): AssistantSource => {
		const state = sourceState.get(source.id);
		const specs = source.fieldSpecs;
		return {
			id: source.id,
			label: source.label,
			grants: deps.vault.serviceGrants(source.id),
			unread: state.unread,
			capped: state.capped,
			...(state.lastSuccessAt !== undefined ? { lastSuccessAt: state.lastSuccessAt } : {}),
			...(state.nextPollAt !== undefined ? { nextPollAt: state.nextPollAt } : {}),
			...(state.backoff ? { backoff: state.backoff } : {}),
			...(state.stopped !== undefined ? { stopped: state.stopped } : {}),
			fieldSpecs: [...specs],
			unexpected: unexpectedNow(state, specs),
			...(source.secret === undefined ? {} : { secret: source.secret }),
			actions: actionsOf(source.id),
			enabled: enabled.enabled(source.id),
			triggers: source.selfTold !== true,
		};
	};
	// Remove 2026-11-28: an older phone's row; it carries these rules on a move.
	const watcherOf = (source: AssistantSource): AssistantWatcher => {
		const { triggers: _triggers, ...row } = source;
		const rules = automations ? rulesOfAutomations(automations.eventsOf(source.id)) : DEFAULT_RULES;
		return { ...row, evicted: 0, fields: fieldsOf(source.fieldSpecs), rules, invalid: [] };
	};
	const sourceNamed = (sourceId: string) => {
		const found = sources.find((source) => source.id === sourceId);
		if (!found) throw new Error(`no source "${sourceId}"`);
		return found;
	};
	const safety = openDurable(deps.dataDir, "assistant-safety", (store) => createSafetyStore(store));
	const temperature = openDurable(deps.dataDir, "assistant-temperature-unit", (store) =>
		createTemperatureUnitStore(store),
	);
	const phoneHold = createHoldFollow(() => ambient.now());
	// Preboot rows cannot establish owner activity.
	const marker = createOriginMarker(deps.lastDeliverySeq() + 1);
	/** Owner-thread send card. */
	const card = (
		actionType: "send-request" | "send-retract" | "act-request" | "act-retract",
		payload: Record<string, unknown>,
	) => {
		const routes = deps.routes();
		const sessionId = routes.ownerSessionKey(ASSISTANT_TEAM);
		if (!sessionId) return null;
		return {
			routes,
			entry: {
				kind: "plugin_action" as const,
				session_id: sessionId,
				pluginId: "assistant",
				actionType,
				payload,
			},
		};
	};
	const phonePluginRow = (actionType: "retract", requestId: string, dedupeKey: string): boolean => {
		try {
			const routes = deps.routes();
			const sessionId = routes.ownerSessionKey(ASSISTANT_TEAM);
			if (!sessionId) return false;
			return (
				routes.deliverToOwner({
					entry: {
						kind: "plugin_action",
						session_id: sessionId,
						pluginId: "phone",
						actionType,
						payload: { requestId },
					},
					dedupeKey,
					label: "assistant",
				}) === true
			);
		} catch {
			return false;
		}
	};
	const guard = openDurable(deps.dataDir, "assistant-open-sends", (ledger) =>
		createSendGuard({
			ambient,
			approveEverySend: () => safety.approveEverySend(),
			readsOwner: () => marker.readsOwner(),
			lastOrigin: () => marker.lastOrigin(),
			routes: () => deps.routes(),
			blobSize: deps.blobSize,
			ledger,
			// Answers are process-local.
			deliverCard: (request: AssistantSendRequest) => {
				try {
					const built = card("send-request", request);
					if (!built) return false;
					return built.routes.deliverToOwner({
						entry: built.entry,
						dedupeKey: `assistant-send:${request.requestId}`,
						label: "assistant",
						volatile: true,
					});
				} catch {
					return false;
				}
			},
			retractCard: (stub) => {
				try {
					const built = card("send-retract", { requestId: stub.requestId });
					if (!built) return false;
					const dedupeKey = `assistant-send-retract:${stub.requestId}`;
					return built.routes.deliverToOwner({ entry: built.entry, dedupeKey, label: "assistant" }) === true;
				} catch {
					return false;
				}
			},
		}),
	);
	const phoneRequests = openDurable(deps.dataDir, "assistant-phone-requests", (ledger) =>
		createPhoneRequests({
			ambient,
			ledger,
			deliver: (request: PhoneRequest) => {
				try {
					const routes = deps.routes();
					const sessionId = routes.ownerSessionKey(ASSISTANT_TEAM);
					if (!sessionId) return false;
					const delivered = routes.deliverToOwner({
						entry: {
							kind: "plugin_action",
							session_id: sessionId,
							pluginId: "phone",
							actionType: "capability",
							payload: {
								requestId: request.requestId,
								key: request.key,
								params: request.params,
								guard: request.guard,
								deadlineAt: request.deadlineAt,
							},
						},
						// Fresh row per attempt.
						dedupeKey: `assistant-phone:${request.requestId}:${ambient.newId()}`,
						label: "assistant",
						volatile: true,
						recipient: { kind: "holder" },
						completion: true,
					});
					if (delivered === MIGRATING) return MIGRATING;
					if (!delivered.queued) return false;
					return delivered as PhoneRequestDelivery;
				} catch {
					return false;
				}
			},
			retract: (request) =>
				phonePluginRow("retract", request.requestId, `assistant-phone-retract:${request.requestId}`),
		}),
	);
	const actGuard = openDurable(deps.dataDir, "assistant-open-acts", (ledger) =>
		createActGuard({
			ambient,
			ledger,
			deliver: (request) => {
				try {
					const built = card("act-request", request);
					if (!built) return false;
					return built.routes.deliverToOwner({
						entry: built.entry,
						dedupeKey: `assistant-act:${request.requestId}`,
						label: "assistant",
						volatile: true,
					});
				} catch {
					return false;
				}
			},
			retract: (requestId) => {
				try {
					const built = card("act-retract", { requestId });
					if (!built) return false;
					return (
						built.routes.deliverToOwner({
							entry: built.entry,
							dedupeKey: `assistant-act-retract:${requestId}`,
							label: "assistant",
						}) === true
					);
				} catch {
					return false;
				}
			},
			runDevice: approvedDeviceRun(deps.devices ?? null),
			runPhone: (input) => {
				const denied = holdRefusal(phoneHold.answer);
				if (denied) return Promise.resolve(denied);
				const opened = phoneRequests.open(input);
				return opened.kind === "opened"
					? opened.answer
					: Promise.resolve({
							kind: "refused",
							reason: `the phone request could not be opened: ${opened.reason}`,
						});
			},
		}),
	);
	const ifttt = createIftttClient({
		fetch: deps.fetch,
		vault: {
			entryId: () => deps.vault.serviceGrants(IFTTT_INTEGRATION_ID)[0],
			readForService: (sourceId, entryId) => deps.vault.readForService(sourceId, entryId),
		},
		ambient,
	});
	const gatewayRuns: GatewayCapabilityRuns = {
		ifttt_trigger: (params) => ifttt.trigger(params),
	};
	const deviceDispatch = createDeviceDispatch({ ambient, devices: deps.devices ?? null, act: actGuard });
	const statusMemo = createStatusMemo(phoneHold.answer);
	const phoneDispatch = createPhoneDispatch({
		ambient,
		approveEverySend: safety.approveEverySend,
		hold: phoneHold.answer,
		phone: phoneRequests,
		act: actGuard,
		gateways: gatewayRuns,
	});

	const routes = createAssistantRoutes({
		caller: (req) => {
			const record = sessions.sessionAuthority.resolveConfirmedManagedSession(req);
			if (!record) return "unauthenticated";
			return acting(record) ? "assistant" : "not_assistant";
		},
		sender: (req, conversationId) => {
			const auth = sessions.sessionAuthority;
			if (!acting(auth.resolveConfirmedManagedSession(req) ?? undefined)) return null;
			// Replies require caller ownership.
			const holder = sessions.conversationRegistry.get(conversationId);
			if (!auth.satisfies(auth.toAnswerFor(holder), presentedByRequest(req))) return null;
			return { team: ASSISTANT_TEAM, conversationId };
		},
		list: (scope, page) => inbox.list(scope, page),
		listActions: () => actionListings(statusMemo.read()),
		device: deviceDispatch,
		dispatch,
		phone: async (request) => {
			const result = await phoneDispatch(request);
			statusMemo.note(request.key, result);
			return result;
		},
		guard,
		hold: phoneHold.answer,
		ambient,
	});
	const state = (): ConsoleAssistantStateResult => {
		const record = held();
		const rows = sources.map(sourceOf);
		return {
			workdir: record?.workdirPath ?? null,
			team: record ? ASSISTANT_TEAM : null,
			sources: rows,
			watchers: rows.map(watcherOf),
			integrations: INTEGRATION_IDS.map((id) => ({
				id,
				label: integrationLabel(id),
				grants: deps.vault.serviceGrants(id),
			})),
			offered: INTEGRATION_KEYS,
			approveEverySend: safety.approveEverySend(),
			temperatureUnit: temperature.temperatureUnit(),
			checkIns: true,
		};
	};

	/** Refused mid-apply. */
	const settled = <T>(work: () => T | Promise<T>): Promise<T> =>
		serial(() => {
			if (home.applying()) throw new Error(MOVING_HERE);
			return work();
		});
	let homePort: AssistantHomePort | null = null;

	const carriedEvents = (carried: AssistantHomeSealed["carried"]): CarriedAutomation[] => {
		// Remove 2026-11-28: an older phone carries rules.
		const fromRules = (carried?.watchers ?? []).flatMap((source) =>
			source.rules ? automationsOfRules(source.id, source.rules) : [],
		);
		return carried?.automations ?? fromRules;
	};

	/** With lanes stopped, the carried settings land; lanes start only once all of it is saved. */
	const apply = async (record: AssistantHomeRecord): Promise<string | null> => {
		await stopLanes();
		const opened = homePort?.open(record) ?? { kind: "refused" as const, reason: "federation is not active" };
		if (opened.kind === "refused") return opened.reason;
		const { workdirPath, carried } = opened.sealed;
		const refused = placeRefusal(workdirPath, sessions);
		if (refused) return refused;
		marker.ended();
		for (const id of grantTargets()) deps.vault.setServiceGrants(id, []);
		if (!grantTargets().every((id) => grantsLanded(id, [])))
			return "a grant left from an earlier placement could not be dropped";
		// First poll primes again.
		if (!sources.every((source) => sourceState.put(source.id, FRESH_STATE)))
			return "a source's earlier state could not be reset";
		const undo = place(workdirPath, sessions);
		try {
			deps.saveSessions();
		} catch (error) {
			undo();
			throw error;
		}
		const byId = new Map((carried?.watchers ?? []).map((source) => [source.id, source]));
		const moved = automations?.write({ kind: "carry", rows: carriedEvents(carried) });
		if (!moved?.written) return `the automations could not be saved${moved ? `: ${moved.reason}` : ""}`;
		if (!safety.set(carried?.approveEverySend ?? true)) return "the Safety setting could not be saved";
		if (!temperature.set(carried?.temperatureUnit ?? "C")) return "the temperature unit could not be saved";
		// Fresh is off; unflagged carried is on.
		const off = sources.filter((source) => {
			const moved = byId.get(source.id);
			return moved === undefined || moved.enabled === false;
		});
		if (!enabled.replaceOff(off.map((source) => source.id))) return "the sources' Enabled could not be saved";
		// Unusable grants drop.
		for (const source of sources) {
			const grant = byId.get(source.id)?.grant;
			if (grant && (await deps.vault.usableHere(grant))) deps.vault.setServiceGrants(source.id, [grant]);
		}
		const carriedIntegrations = new Map(
			(carried?.integrations ?? []).map((integration) => [integration.id, integration.grant]),
		);
		for (const id of INTEGRATION_IDS) {
			const grant = carriedIntegrations.get(id);
			if (grant && (await deps.vault.usableHere(grant))) deps.vault.setServiceGrants(id, [grant]);
		}
		return null;
	};

	/** Waiting sends end and lanes stop before anything awaits; the rest runs again until the forget lands. */
	const letGo = async (): Promise<boolean> => {
		guard.sessionEnded(ASSISTANT_TEAM);
		phoneRequests.sessionEnded(ASSISTANT_TEAM);
		actGuard.sessionEnded(ASSISTANT_TEAM);
		await stopLanes();
		if (held()) {
			try {
				await homePort?.endSession();
			} catch (error) {
				console.warn(`[assistant] let-go waits: ${(error as Error).message}`);
			}
			if (held()) return false;
		}
		marker.ended();
		for (const id of grantTargets()) {
			if (deps.vault.serviceGrants(id).length > 0) deps.vault.setServiceGrants(id, []);
		}
		if (!grantTargets().every((id) => grantsLanded(id, []))) return false;
		const ids = sources.map((source) => source.id);
		if (automations && !automations.write({ kind: "carry", rows: [] }).written) return false;
		if (!openDurable(deps.dataDir, "assistant-rules", clearStoredRules)) return false;
		if (!safety.approveEverySend() && !safety.set(true)) return false;
		if (ids.some((sourceId) => !enabled.enabled(sourceId)) && !enabled.replaceOff([])) return false;
		return true;
	};

	const homeFollow = createHomeFollow({
		mark: home,
		localGatewayId: deps.localGatewayId,
		serial,
		ambient,
		effects: {
			stopLanes,
			startLanes,
			apply,
			letGo,
			// Resent at the next registration.
			report: (mark) => homePort?.report(mark) ?? Promise.resolve("dropped" as const),
		},
	});

	return {
		temperatureUnit: temperature.temperatureUnit,
		reserves: isAssistant,
		placed: () => held() !== undefined && home.allowsLanes(),
		follow: homeFollow.follow,
		followPhoneHold: phoneHold.apply,
		holdAnswer: phoneHold.answer,
		phoneHoldLine: () => renderPhoneHold(phoneHold.answer()).line,
		bindHome: (port) => {
			homePort = port;
		},
		forgetRefusal: (team) => (isAssistant(team) ? "the assistant's session ends only when its home changes" : null),
		routes,
		baselineFor: (team) => {
			if (!isAssistant(team)) return undefined;
			const { baseline: hold } = renderPhoneHold(phoneHold.answer());
			return {
				hold,
				sources: sources
					.filter((source) => enabled.enabled(source.id))
					.map((source) => {
						const health = sourceState.get(source.id);
						return {
							label: source.label,
							unread: health.unread,
							capped: health.capped,
							checked: health.lastSuccessAt !== undefined,
							...(health.stopped !== undefined ? { stopped: health.stopped } : {}),
							...(health.backoff ? { waiting: health.backoff.reason } : {}),
						};
					}),
			};
		},
		bindAutomations: (bound) => {
			automations = bound;
			openDurable(deps.dataDir, "assistant-rules", (rules) =>
				openDurable(deps.dataDir, "assistant-rules-adopted", (mark) =>
					adoptStoredRules({
						rules,
						mark,
						now: () => ambient.now(),
						adopt: (rows) => {
							const adopted = bound.write({ kind: "adoption", rows });
							if (adopted.written) return rows.length - adopted.dropped.length;
							console.warn(`[assistant] stored rules not adopted: ${adopted.reason}`);
							return null;
						},
					}),
				),
			);
		},
		eventIssue,
		eventSentence,
		iftttTrigger: (params) => ifttt.trigger(params),
		previewTrigger: async (trigger) => {
			if (trigger.kind !== "event") throw new Error("only an event trigger previews");
			const issue = eventIssue(trigger);
			if (issue !== null) throw new Error(issue);
			const recent = (
				await livePage(
					trigger.source,
					() => ({ scope: "all" }),
					ASSISTANT_WAITS.preview,
					(page) => page.events,
				)
			)
				.sort((a, b) => b.at - a.at)
				.slice(0, AUTOMATION_PREVIEW_EVENTS);
			const specs = specsOf(trigger.source) ?? [];
			const matches = recent.filter((event) => conditionsMatch(trigger.conditions, specs, event.fields));
			return {
				matched: matches.length,
				of: recent.length,
				matches: matches.slice(0, AUTOMATION_PREVIEW_SHOWN).map(({ title, at }) => ({ title, at })),
			};
		},
		bindWake: (bound) => {
			wake = bound;
		},
		bindNudge: (bound) => {
			nudge = bound;
		},
		console: {
			state,
			/** Also the retry: the same set polls a stopped source again. */
			setServiceGrants: (sourceId, entryIds) =>
				settled(() => {
					const source = sources.find((candidate) => candidate.id === sourceId);
					const integration = INTEGRATION_IDS.find((id) => id === sourceId);
					if (!source && !integration) throw new Error(`no source "${sourceId}"`);
					if (entryIds.length > 1) throw new Error("a source takes one secret");
					if (!held()) throw new Error(NOT_HERE);
					deps.vault.setServiceGrants(sourceId, entryIds);
					if (!grantsLanded(sourceId, entryIds)) throw new Error("the grant could not be saved");
					if (source) {
						if (lanes) lanes.poke(sourceId);
						else startLanes();
					}
					return state();
				}),
			// A move carries it; a let-go resets it.
			setSafety: (approveEverySend) =>
				settled(() => {
					if (!safety.set(approveEverySend)) throw new Error("the setting could not be saved");
					return state();
				}),
			setTemperatureUnit: (temperatureUnit) =>
				settled(() => {
					if (!temperature.set(temperatureUnit)) throw new Error("the setting could not be saved");
					return state();
				}),
			// No await: `switched` voids a poll in flight before it can commit.
			setSourceEnabled: (sourceId, on) =>
				settled(() => {
					sourceNamed(sourceId);
					if (!held()) throw new Error(NOT_HERE);
					if (enabled.enabled(sourceId) === on) return state();
					// Backlog wakes nothing.
					const unprimed = { ...sourceState.get(sourceId), primed: false };
					if (on && !sourceState.put(sourceId, unprimed)) throw new Error("the source could not be reset");
					if (!enabled.set(sourceId, on)) throw new Error("the setting could not be saved");
					if (lanes) lanes.switched(sourceId);
					else startLanes();
					return state();
				}),
			checkSource: async (sourceId, from, opId) => {
				const source = await settled(() => {
					const found = sourceNamed(sourceId);
					if (!held() || !home.allowsLanes()) throw new Error(NOT_HERE);
					if (!enabled.enabled(sourceId)) throw new Error(`${found.label} is disabled`);
					return found;
				});
				if (!nudge) throw new Error("federation is not active");
				// Outside the queue; wakes are slow.
				const sent = nudge({
					from,
					body: checkNudge(source.label),
					deliveryId: `assistant-check:${opId}`,
				}).catch((error: Error) => error.message);
				const answered = await withinMs(
					ambient,
					sent.then((refused) => ({ refused })),
					SEND_BOUND_MS,
				);
				if (answered?.refused) throw new Error(answered.refused);
				if (!answered) {
					void sent.then((refused) => {
						if (refused) console.warn(`[assistant] check of ${sourceId} not delivered: ${refused}`);
					});
				}
				return state();
			},
			answerSend: (requestId, decision, note) => guard.answer(requestId, decision, note),
			answerPhone: (requestId, answer, signer) => phoneRequests.answer(requestId, answer, signer),
			answerAct: (requestId, decision, note) => actGuard.answer(requestId, decision, note),
		},
		registerSource: (source) => {
			if (deps.sources) return;
			if (active) throw new Error("sources register before the assistant starts");
			if (sources.some((held) => held.id === source.id)) throw new Error(`${source.id} is registered twice`);
			sources.push(source);
		},
		start: () => {
			active = true;
			startLanes();
			homeFollow.start();
			guard.retractStale();
			phoneRequests.retractStale((stub) =>
				phonePluginRow("retract", stub.requestId, `assistant-phone-retract:${stub.requestId}`),
			);
			actGuard.retractStale((stub) => {
				try {
					const built = card("act-retract", { requestId: stub.requestId });
					if (!built) return false;
					return (
						built.routes.deliverToOwner({
							entry: built.entry,
							dedupeKey: `assistant-act-retract:${stub.requestId}`,
							label: "assistant",
						}) === true
					);
				} catch {
					return false;
				}
			});
		},
		pokeSource: (sourceId) => lanes?.poke(sourceId),
		stop: async () => {
			ownerOpsClosed = true;
			// Late applies start nothing.
			active = false;
			homeFollow.stop();
			// Drain before flush.
			await withinMs(ambient, Promise.all([ownerOps.drain(), stopLanes()]), STOP_WAIT_MS);
		},
		delivered: (row) => marker.delivered(row),
		offered: (row) => marker.offered(row),
		replyPushed: (team) => {
			if (team === ASSISTANT_TEAM) marker.replyPushed(deps.lastDeliverySeq());
		},
		namesBlob: (blobId) => guard.namesBlob(blobId),
		sessionEnded: (team) => {
			guard.sessionEnded(team);
			phoneRequests.sessionEnded(team);
			actGuard.sessionEnded(team);
			if (team === ASSISTANT_TEAM) marker.ended();
		},
	};
}

/** `place`'s refusal, checked first. */
function placeRefusal(workdir: string, sessions: AssistantStageDeps["sessions"]): string | null {
	if (!isSpawnWorkdirPath(ASSISTANT_SPAWN, workdir)) return "the folder must be an absolute or ~-rooted path";
	const held = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
	if (held && !isAssistantRecord(held)) return `${ASSISTANT_TEAM} is held by a session the assistant did not make`;
	return null;
}

/**
 * Mints the record, or moves a held one to this folder, and answers how to take that back. The first
 * wake launches it, and a moved session takes the folder at its next launch.
 */
function place(workdir: string, sessions: AssistantStageDeps["sessions"]): () => void {
	const refusal = placeRefusal(workdir, sessions);
	if (refusal) throw new Error(refusal);
	const held = sessions.sessionStore.getByTeam(ASSISTANT_TEAM);
	if (held) {
		const previous = held.workdirPath;
		held.workdirPath = workdir;
		return () => {
			held.workdirPath = previous;
		};
	}
	const minted = sessions.presence.adoptById(ASSISTANT_SESSION_NAME, {
		spawn: ASSISTANT_SPAWN,
		sessionLabel: "Assistant",
		workdirHint: "Assistant",
		workdirPath: workdir,
		harness: "claude",
		mintedFrom: ASSISTANT_RESERVE_KEY,
	});
	if (!minted) throw new Error(`cannot claim ${ASSISTANT_TEAM}: the name is reserved or a project`);
	return () => void sessions.presence.forget(ASSISTANT_TEAM);
}
