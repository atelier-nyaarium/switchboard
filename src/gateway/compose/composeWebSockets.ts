// The session sockets and the held-delivery handover that rides them.

import type { Ambient } from "../../shared/ambient.js";
import type { ClaudeTurnResultFrame } from "../../shared/host-op.js";
import { pushesBaseline } from "../../shared/session-harness.js";
import { ChannelDeliveryCoordinator, type ChannelDeliveryObserver } from "../channelDelivery.js";
import { createWebSocketHandlers } from "../websocket.js";
import { createWorkspacePlane, type WorkspacePlane } from "../workspacePlane.js";
import type { AgentsStage } from "./composeAgents.js";
import type { FederationStage } from "./composeFederation.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";
import type { StoresStage } from "./composeStores.js";
import type { WorkflowsStage } from "./composeWorkflows.js";

const HEARTBEAT_INTERVAL_MS = 30000;
const MISSED_PINGS_LIMIT = 2;

export interface WebSocketsStageDeps {
	hostWsToken?: string;
	ambient: Ambient;
	stores: Pick<StoresStage, "pendingDeliveries" | "daemonCapabilityStore">;
	sessions: Pick<
		SessionsStage,
		| "registry"
		| "conversationRegistry"
		| "knownTeamPaths"
		| "offlineCatalog"
		| "hostSpawnPoints"
		| "presence"
		| "sessionStore"
		| "sessionAuthority"
	>;
	host: Pick<HostStage, "wakeCoordinator" | "hostOpCoordinator" | "pushPresenceWatch" | "readLiveness">;
	agents: Pick<AgentsStage, "codexRelay" | "copilotRelay">;
	workflows: Pick<WorkflowsStage, "hostRegistering" | "hostRegistered" | "catalogChanged" | "claudeTurnResult">;
	federation: Pick<FederationStage, "channelDeliveryAck">;
	/** Composes after routes. */
	retireStaging?: (blobIds: string[]) => void;
	observer: ChannelDeliveryObserver;
	onSessionConfirmed?: (team: string) => void;
}

export interface WebSocketsStage {
	channelDeliveries: ChannelDeliveryCoordinator;
	wsHandlers: ReturnType<typeof createWebSocketHandlers>;
	workspacePlane: WorkspacePlane;
	onCopilotCompacted: (listener: (team: string) => void) => void;
	onRestartPending: (listener: (team: string, pending: boolean) => void) => void;
}

export function composeWebSockets(deps: WebSocketsStageDeps): WebSocketsStage {
	const { sessions, stores, host, agents, federation, ambient, workflows } = deps;
	const compacting = new Set<string>();
	/** No hook hands such a CLI its baseline. */
	const compactsByEvents = (team: string) => {
		const record = sessions.sessionStore.getByTeam(team);
		return !!record && pushesBaseline(record.harness);
	};
	let compacted: ((team: string) => void) | undefined;
	let restartPending: ((team: string, pending: boolean) => void) | undefined;
	let hostRegisterPass: Promise<void> = Promise.resolve();
	let hostFamilyPass: Promise<void> = Promise.resolve();
	let hostRegisterSocket: object | undefined;
	let hostFamilyReady = true;
	type HostFamilyFrame = { socket: object; backend: "codex" | "copilot"; message: Record<string, unknown> };
	let pendingHostFrames: HostFamilyFrame[] = [];
	const applyHostFrame = async (frame: HostFamilyFrame): Promise<void> => {
		if (host.readLiveness().socket !== frame.socket) return;
		const relay = frame.backend === "codex" ? agents.codexRelay : agents.copilotRelay;
		await relay.handleHostMessage(frame.message);
	};
	const queueHostFrame = (backend: HostFamilyFrame["backend"], message: Record<string, unknown>): void => {
		const socket = hostRegisterSocket;
		if (!socket) return;
		const frame = { socket, backend, message };
		if (!hostFamilyReady) {
			pendingHostFrames.push(frame);
			return;
		}
		hostFamilyPass = hostFamilyPass.then(() => applyHostFrame(frame));
	};
	// Built here because it needs the registry this stage owns, and the socket handler settles onto it.
	const workspacePlane = createWorkspacePlane({
		registry: sessions.registry,
		sessionStore: sessions.sessionStore,
		ambient,
	});
	const channelDeliveries = new ChannelDeliveryCoordinator({
		store: stores.pendingDeliveries,
		registry: sessions.registry,
		repushHandshake: (team, subId) => wsHandlers.repushHandshake(team, subId),
		retireStaging: deps.retireStaging,
		observer: deps.observer,
	});

	const wsHandlers = createWebSocketHandlers({
		ambient,
		registry: sessions.registry,
		conversationRegistry: sessions.conversationRegistry,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT, hostWsToken: deps.hostWsToken },
		knownTeamPaths: sessions.knownTeamPaths,
		offlineCatalog: sessions.offlineCatalog,
		hostSpawnPoints: sessions.hostSpawnPoints,
		wakeCoordinator: host.wakeCoordinator,
		hostOpCoordinator: host.hostOpCoordinator,
		workspacePlane,
		onTeamConnect: (team, ws) => {
			if (team === "host") {
				hostRegisterSocket = ws;
				hostFamilyReady = false;
				const frames: HostFamilyFrame[] = [];
				pendingHostFrames = frames;
				workflows.hostRegistering();
				hostRegisterPass = Promise.all([
					agents.codexRelay.onHostRegister(),
					agents.copilotRelay.onHostRegister(),
				]).then(() => undefined);
				hostFamilyPass = hostRegisterPass.then(async () => {
					if (host.readLiveness().socket !== ws) return;
					while (frames.length > 0) await applyHostFrame(frames.shift()!);
					if (hostRegisterSocket === ws) hostFamilyReady = true;
				});
				void hostFamilyPass.then(() => {
					if (host.readLiveness().socket !== ws) return;
					workflows.hostRegistered();
					host.pushPresenceWatch(true);
				});
			}
			const handed = channelDeliveries.drain(team);
			if (handed === "migrating") return;
			if (handed > 0) console.log(`[delivery] handed ${handed} held message(s) to ${team}`);
		},
		onHandshakeConfirmed: (team) => deps.onSessionConfirmed?.(team),
		onDeliveryAck: (team, deliveryId) => {
			federation.channelDeliveryAck(team, deliveryId);
			if (channelDeliveries.acknowledge(deliveryId, team) === true) {
				console.log(`[delivery] ${team} confirmed ${deliveryId.slice(0, 8)}`);
			}
		},
		onTeamDisconnect: (team) => {
			if (team === "host") {
				sessions.presence.clearAllWorking();
				sessions.presence.markDirty();
			}
		},
		onCatalogChange: (daemonInstanceId) => {
			sessions.presence.markDirty();
			const socket = hostRegisterSocket;
			void hostFamilyPass.then(async () => {
				const live = host.readLiveness();
				if (!socket || live.socket !== socket || live.daemonInstanceId !== daemonInstanceId) return;
				await Promise.all([
					agents.codexRelay.resendRequested(daemonInstanceId),
					agents.copilotRelay.resendRequested(daemonInstanceId),
				]);
				if (host.readLiveness().socket !== socket) return;
				workflows.catalogChanged();
			});
		},
		onDaemonCapabilities: (capabilities) => stores.daemonCapabilityStore.declare(capabilities),
		onCodexHostMessage: (msg) => queueHostFrame("codex", msg),
		onCopilotHostMessage: (msg) => queueHostFrame("copilot", msg),
		onClaudeTurnResult: (frame: ClaudeTurnResultFrame, socket) =>
			hostFamilyPass.then(() => {
				if (host.readLiveness().socket !== socket) return;
				return workflows.claudeTurnResult(frame);
			}),
		onPresenceDerive: (team, derived) => {
			// A clear is unknown, not a compaction's end.
			if (!derived) {
				sessions.presence.clearWorkingFor(team);
				return;
			}
			sessions.presence.setWorking(team, derived);
			const wasCompacting = compacting.has(team);
			if (derived.compacting) compacting.add(team);
			else compacting.delete(team);
			if (wasCompacting && !derived.compacting && compactsByEvents(team)) compacted?.(team);
		},
		onRestartPending: (team, pending) => restartPending?.(team, pending),
		sessionStore: sessions.sessionStore,
		auth: sessions.sessionAuthority,
		presenceWriter: {
			establishOnConfirm: (team, args) => sessions.presence.establishOnConfirm(team, args),
			clearLive: (team, subId) => sessions.presence.clearLive(team, subId),
		},
		announcePresenceDirty: () => sessions.presence.markDirty(),
		busyOf: (team) => sessions.presence.busyOf(team),
	});

	return {
		channelDeliveries,
		wsHandlers,
		workspacePlane,
		onCopilotCompacted: (listener) => {
			compacted = listener;
		},
		onRestartPending: (listener) => {
			restartPending = listener;
		},
	};
}
