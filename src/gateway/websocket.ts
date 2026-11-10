import type { ServerWebSocket } from "bun";
import { agentInboundFrameTypes } from "../shared/agent-backend.js";
import { ClaudeTurnAckFrameSchema, ClaudeTurnResultFrameSchema } from "../shared/host-op.js";
import { isHostSpawnSession } from "../shared/host-spawn.js";
import { LaunchFailureSchema } from "../shared/launch-notice.js";
import { OP_LEDGER_PROTOCOL, WsRegisterSchema } from "../shared/schemas.js";
import { ContainerListSchema, DerivedPresenceSchema, HarnessSpawnsSchema } from "../shared/schemasPresence.js";
import { WakeStageFrameSchema } from "../shared/schemasWake.js";
import {
	parseSessionControlResult,
	SESSION_CONTROL_REPLY_FRAME,
	SESSION_PRESENCE_FRAME,
	SessionPresenceReportSchema,
} from "../shared/session-control.js";
import { foldHarness, HARNESS, readHarness, readsOwnState, SESSION_HARNESSES } from "../shared/session-harness.js";
import { isComposite } from "../shared/session-id.js";
import type { ConnectionMode } from "../shared/types.js";
import { WORKSPACE_OP_REPLY_FRAME, type WorkspaceOpResult } from "../shared/workspace-op.js";
import { HandshakeGate } from "./handshakeGate.js";
import { NOTHING_PRESENTED, type Presented, presentedByRegister } from "./sessionAuthority.js";
import { reached, sendOn } from "./wsSend.js";
import {
	getAllActiveWs,
	type HandshakeRepushOutcome,
	REGISTER_WINDOW_MS,
	RESERVED_TEAM_NAMES,
	resolveLiveIncarnation,
	type WebSocketDeps,
	type WsData,
} from "./wsTypes.js";

const CODEX_INBOUND_FRAMES = agentInboundFrameTypes("codex");
const COPILOT_INBOUND_FRAMES = agentInboundFrameTypes("copilot");

export function createWebSocketHandlers({
	registry,
	conversationRegistry,
	knownTeamPaths,
	offlineCatalog,
	hostSpawnPoints,
	wakeCoordinator,
	hostOpCoordinator,
	workspacePlane,
	sessionControl,
	config,
	onTeamConnect,
	onHandshakeConfirmed,
	onTeamDisconnect,
	onDeliveryAck,
	onVirtualPeerEvicted,
	onCatalogChange,
	onSpawnPointsChange,
	onPickResolved,
	onDaemonCapabilities,
	onCodexHostMessage,
	onCopilotHostMessage,
	onClaudeTurnResult,
	onPresenceDerive,
	onRestartPending,
	sessionStore,
	auth,
	presenceWriter,
	announcePresenceDirty,
	ambient,
	busyOf,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;
	const liveWriter = presenceWriter ?? sessionStore;

	/** No pane reader runs. */
	function reportsOwnState(team: string | null | undefined): boolean {
		const record = team ? sessionStore?.getByTeam(team) : undefined;
		return !!record?.harness && readsOwnState(record.harness);
	}

	function heartbeatTick() {
		flushHandshakes();
		for (const pending of handshakeGate.expirePending((team) => busyOf?.(team) === true)) {
			const ws = registry.get(pending.team)?.get(pending.subId);
			if (ws && !ws.data.handshakeConfirmed) evictSocket(ws);
		}
		handshakeGate.sweep();
		for (const subs of registry.values()) {
			for (const ws of subs.values()) {
				const data = ws.data as WsData;
				if (data.virtual) continue;
				data.missedPings = (data.missedPings || 0) + 1;
				if (data.missedPings >= MISSED_PINGS_LIMIT) {
					ws.close();
					continue;
				}
				ws.ping();
			}
		}
	}
	const heartbeatInterval = ambient.setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);

	const handshakeGate = new HandshakeGate(ambient);

	/** A session known busy is not handed a handshake yet. */
	const handshakeReady = (team: string): boolean => busyOf?.(team) !== true;

	function mintHandshake(ws: ServerWebSocket<WsData>, team: string, subId: string): void {
		const held = !handshakeReady(team);
		const { hsId, push } = handshakeGate.mint(team, subId, held);
		if (held) {
			console.log(`[ws] handshake held for ${team}/${subId} [${hsId}] until it is idle`);
			return;
		}
		if (!reached(sendOn(ws, push, `handshake to ${team}/${subId}`))) return;
		console.log(`[ws] handshake sent to ${team}/${subId} [${hsId}]`);
	}

	function flushHandshakes(): void {
		for (const due of handshakeGate.due((p) => handshakeReady(p.team))) {
			const ws = registry.get(due.team)?.get(due.subId);
			if (ws?.readyState !== 1 || !reached(sendOn(ws, due.push, `handshake to ${due.team}/${due.subId}`)))
				continue;
			handshakeGate.sent(due.hsId);
			console.log(`[ws] held handshake sent to ${due.team}/${due.subId} [${due.hsId}]`);
		}
	}

	function repushHandshake(team: string, subId: string): HandshakeRepushOutcome {
		if (busyOf?.(team) === true) return "throttled";
		const decision = handshakeGate.decideRepush(team, subId);
		if (decision.kind !== "send") return decision.kind;
		const ws = registry.get(team)?.get(subId);
		if (ws?.readyState !== 1) return "socket-gone";
		if (!reached(sendOn(ws, decision.push, `handshake re-push to ${team}/${subId}`))) return "socket-gone";
		decision.commit();
		console.log(`[ws] handshake re-pushed to ${team}/${subId} [${decision.hsId}] (attempt ${decision.attempt})`);
		return "pushed";
	}

	function evictSocket(victim: ServerWebSocket<WsData>): void {
		victim.data.isStale = true;
		const vTeam = victim.data.teamName;
		if (vTeam) {
			const vSubs = registry.get(vTeam);
			if (vSubs?.get(victim.data.subId) === victim) vSubs.delete(victim.data.subId);
			handshakeGate.forget(vTeam, victim.data.subId);
			liveWriter?.clearLive(vTeam, victim.data.subId);
		}
		const vConv = victim.data.conversationId;
		if (vConv && conversationRegistry.get(vConv) === victim) conversationRegistry.delete(vConv);
		victim.close();
		announcePresenceDirty?.();
	}

	function open(ws: ServerWebSocket<WsData>): void {
		ws.data.missedPings = 0;
		ws.data.isStale = false;
		ws.data.handshakeConfirmed = false;
		ws.data.conversationId = null;
		ws.data.daemonInstanceId = undefined;
	}

	/** Flag and announcement together; a bare assignment publishes "verifying". */
	function confirmHandshake(ws: ServerWebSocket<WsData>): void {
		ws.data.handshakeConfirmed = true;
		announcePresenceDirty?.();
		if (ws.data.teamName) onHandshakeConfirmed?.(ws.data.teamName);
	}

	function message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			return;
		}

		if (msg.type === "register") {
			const reg = WsRegisterSchema.safeParse(msg);
			if (!reg.success) {
				console.warn(`[ws] dropped malformed register: ${reg.error.issues[0]?.message ?? "invalid"}`);
				return;
			}
			const team = reg.data.team;
			const subId = reg.data.subId || ambient.newId().slice(0, 8);
			const mode: ConnectionMode = "channel";
			const conversationId = reg.data.conversationId ?? null;

			// Only the authenticated host socket may drive terminals and wakes.
			if (team === "host" && (!config.hostWsToken || reg.data.token !== config.hostWsToken)) {
				console.log(`[ws] rejected host register - bad or missing token`);
				sendOn(
					ws,
					JSON.stringify({ type: "register_reject", team, reason: "unauthorized" }),
					"register_reject",
				);
				ws.data.isStale = true;
				ws.close();
				return;
			}

			const presentedToken = reg.data.sessionToken;
			const boundRecord = presentedToken ? sessionStore?.recordByBindToken(presentedToken) : undefined;
			const isBound = !!boundRecord && sessionStore?.teamOf(boundRecord) === team;
			const presentedHere = presentedByRegister(reg.data);

			// A bound name may be claimed only by its binding holder.
			if (auth && !auth.satisfies(auth.toClaim(team), presentedHere)) {
				console.log(`[ws] rejected register for bound team "${team}" - binding not presented`);
				sendOn(
					ws,
					JSON.stringify({ type: "register_reject", team, reason: "unauthorized" }),
					"register_reject",
				);
				ws.data.isStale = true;
				ws.close();
				return;
			}
			// Host shell sessions must prove daemon-launched ownership.
			if (auth && isHostSpawnSession(team) && !auth.presentsOwnLaunchToken(team, presentedHere)) {
				console.log(`[ws] rejected register for host session "${team}" - no daemon launch token`);
				sendOn(
					ws,
					JSON.stringify({ type: "register_reject", team, reason: "unauthorized" }),
					"register_reject",
				);
				ws.data.isStale = true;
				ws.close();
				return;
			}
			if (isBound && boundRecord) {
				ws.data.boundToken = presentedToken;
				const wasInert = !sessionStore?.isBindingActive(boundRecord);
				sessionStore?.activateBinding(boundRecord);
				if (wasInert) {
					// Activating a binding expels claims made while it was inert.
					for (const [otherSubId, other] of registry.get(team) ?? []) {
						if (other !== ws && other.data.boundToken !== presentedToken) {
							console.log(
								`[ws] evicting ${team}/${otherSubId} - claimed the name before its binding armed`,
							);
							evictSocket(other);
						}
					}
				}
			}

			if (RESERVED_TEAM_NAMES.has(team)) {
				const existingSubs = registry.get(team);
				const existingActive = existingSubs ? getAllActiveWs(existingSubs) : [];
				const sameSocketAlready = existingSubs?.get(subId) === ws;
				if (!sameSocketAlready && existingActive.length > 0) {
					console.log(`[ws] rejected register for reserved team "${team}" - already held`);
					sendOn(
						ws,
						JSON.stringify({ type: "register_reject", team, reason: "reserved" }),
						"register_reject",
					);
					ws.data.isStale = true;
					ws.close();
					return;
				}
			}

			if (team === "host" && reg.data.daemonCapabilities) {
				onDaemonCapabilities?.(reg.data.daemonCapabilities);
			}

			let subs = registry.get(team);
			if (!subs) {
				subs = new Map();
				registry.set(team, subs);
			}

			for (const [virtualSubId, virtualWs] of [...subs]) {
				if (virtualWs.data.virtual) {
					subs.delete(virtualSubId);
					const virtualConvId = virtualWs.data.conversationId;
					if (virtualConvId && conversationRegistry.get(virtualConvId) === virtualWs) {
						conversationRegistry.delete(virtualConvId);
					}
					if (virtualConvId) onVirtualPeerEvicted?.(virtualConvId);
					console.log(`[ws] evicted virtual peer ${team}/${virtualSubId} (real registration)`);
				}
			}

			const existing = subs.get(subId);
			if (existing && existing !== ws) {
				// A subId has one live socket incarnation.
				evictSocket(existing);
			}

			ws.data.teamName = team;
			ws.data.subId = subId;
			ws.data.conversationId = conversationId;
			ws.data.mode = mode;
			ws.data.version = reg.data.version;
			ws.data.claudeSessionId = reg.data.claudeSessionId;
			ws.data.harness = readHarness(reg.data.harness);
			ws.data.cwdName = reg.data.cwdName;
			ws.data.agentPid = reg.data.agentPid;
			ws.data.daemonInstanceId = reg.data.daemonInstanceId;
			ws.data.catalogProjects = undefined;
			subs.set(subId, ws);
			announcePresenceDirty?.();

			if (conversationId) {
				const priorConversationWs = conversationRegistry.get(conversationId);
				if (priorConversationWs && priorConversationWs.data.teamName !== team) {
					console.warn(
						`[ws] refusing conversationId claim: ${team}/${subId} presented a conversationId already held by team "${priorConversationWs.data.teamName}"`,
					);
				} else {
					if (priorConversationWs && priorConversationWs !== ws && priorConversationWs.readyState === 1) {
						evictSocket(priorConversationWs);
					}
					conversationRegistry.set(conversationId, ws);
				}
			}

			if (typeof msg.projectPath === "string" && msg.projectPath && !isComposite(team)) {
				knownTeamPaths.set(team, msg.projectPath);
			}

			wakeCoordinator.notify(team);
			console.log(`[ws] ${team}/${subId} connected (mode: ${mode})`);

			const acked = JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL });
			if (!reached(sendOn(ws, acked, `register_ok for ${team}`))) {
				evictSocket(ws);
				return;
			}

			if (mode === "channel" && team !== "host") {
				const confirmedBy = handshakeGate.confirmedBy(team);
				const sameConfirmer = !!auth && !!confirmedBy && auth.sameAs(confirmedBy, auth.toAnswerFor(ws));
				// A CLI with no channel to answer a handshake through; its launch token stands in.
				const boundRow = boundRecord?.harness ? HARNESS[boundRecord.harness] : undefined;
				const tokenStands = isBound && !!boundRow && !boundRow.handshake;
				// One plugin socket per session; its reload replaces it, a nested agent is refused.
				const held = tokenStands
					? [...subs.values()].filter(
							(other) => other !== ws && other.readyState === 1 && other.data.handshakeConfirmed,
						)
					: [];
				if (held.length > 0) {
					// FIXME 2026-11-20: drop `=== undefined`, which lets a plugin naming its agent replace an older one.
					const reload =
						ws.data.agentPid !== undefined &&
						held.every(
							(other) => other.data.agentPid === undefined || other.data.agentPid === ws.data.agentPid,
						);
					const losers = reload ? held : [ws];
					const why = reload
						? "replaced by its agent's reloaded plugin"
						: "refused - another agent holds the session";
					for (const loser of losers) {
						console.log(`[ws] ${team}/${loser.data.subId} ${why}`);
						sendOn(loser, JSON.stringify({ type: "handshake_reject" }), "handshake_reject");
						evictSocket(loser);
					}
					if (!reload) return;
				}
				if (tokenStands || (reg.data.isMainOrLead === true && sameConfirmer)) {
					if (establishRecord(ws, { team, subId }) === "refused") {
						evictSocket(ws);
						return;
					}
					confirmHandshake(ws);
					console.log(
						`[ws] ${team}/${subId} ${tokenStands ? `is a ${boundRow?.label} session` : "reconnected as remembered lead"} - handshake skipped`,
					);
				} else {
					mintHandshake(ws, team, subId);
				}
			} else {
				confirmHandshake(ws);
			}

			onTeamConnect?.(team, ws);
		}

		if (msg.type === "wake_result" && ws.data.teamName === "host" && typeof msg.team === "string") {
			if (msg.success === false) {
				const failure = LaunchFailureSchema.safeParse(msg.failure);
				wakeCoordinator.fail(msg.team, {
					...(failure.success ? { failure: failure.data } : {}),
					...(typeof msg.error === "string" ? { error: msg.error.slice(0, 2048) } : {}),
				});
			} else {
				wakeCoordinator.ackReceived(msg.team, REGISTER_WINDOW_MS);
			}
		}

		if (msg.type === "wake_stage" && ws.data.teamName === "host") {
			const frame = WakeStageFrameSchema.safeParse(msg);
			if (frame.success) {
				wakeCoordinator.stage(frame.data.team, frame.data.stage);
				// Before it registers, since registration reads the CLI off the record.
				if (frame.data.stage === "cli_found" && frame.data.harness) {
					onPickResolved?.(frame.data.team, frame.data.harness);
				}
			}
		}

		if (msg.type === "channel_delivery_ack" && typeof msg.delivery_id === "string" && ws.data.teamName) {
			onDeliveryAck?.(ws.data.teamName, msg.delivery_id);
		}

		if (msg.type === "host_op_reply" && ws.data.teamName === "host" && typeof msg.reqId === "string") {
			hostOpCoordinator?.settle(msg.reqId, {
				ok: msg.ok === true,
				result: msg.result,
				error: typeof msg.error === "string" ? msg.error : undefined,
				errorKind: msg.errorKind === "absent" || msg.errorKind === "failure" ? msg.errorKind : undefined,
			});
		}

		if (msg.type === "claude_turn_result" && ws.data.teamName === "host") {
			const parsed = ClaudeTurnResultFrameSchema.safeParse(msg);
			if (!parsed.success || !onClaudeTurnResult) return;
			void Promise.resolve()
				.then(() => onClaudeTurnResult(parsed.data, ws))
				.then(() => {
					if (ws.data.isStale || ws.readyState !== 1 || registry.get("host")?.get(ws.data.subId) !== ws)
						return;
					const ack = ClaudeTurnAckFrameSchema.parse({
						type: "claude_turn_ack",
						runId: parsed.data.runId,
						turnId: parsed.data.turnId,
					});
					sendOn(ws, JSON.stringify(ack), "claude_turn_ack");
				})
				.catch(() => console.warn("[ws] Claude result was not acknowledged"));
		}

		// Any session, never just host: the plane serves the workspace the plugin itself holds.
		if (msg.type === WORKSPACE_OP_REPLY_FRAME && typeof msg.reqId === "string" && ws.data.teamName) {
			const settled = workspacePlane?.settle(ws, msg.reqId, msg.result as WorkspaceOpResult);
			if (settled === false) console.log(`[workspace] reply ${msg.reqId} had no waiter`);
		}

		if (msg.type === SESSION_CONTROL_REPLY_FRAME && typeof msg.reqId === "string" && ws.data.teamName) {
			const result = parseSessionControlResult(msg.result);
			const settled = result !== null && sessionControl?.settle(ws, msg.reqId, result);
			if (settled === false) console.log(`[session-control] reply ${msg.reqId} had no waiter`);
		}

		// The team is the socket's, never the frame's.
		if (msg.type === SESSION_PRESENCE_FRAME && ws.data.handshakeConfirmed && reportsOwnState(ws.data.teamName)) {
			const team = ws.data.teamName as string;
			// A bare frame clears.
			if (msg.working === undefined) onPresenceDerive?.(team, undefined);
			else {
				const report = SessionPresenceReportSchema.safeParse(msg);
				if (report.success) onPresenceDerive?.(team, report.data);
				else console.warn(`[ws] session_presence refused for ${team}`);
			}
		}

		if (ws.data.teamName === "host" && typeof msg.type === "string" && CODEX_INBOUND_FRAMES.has(msg.type)) {
			onCodexHostMessage?.(msg);
		}

		if (ws.data.teamName === "host" && typeof msg.type === "string" && COPILOT_INBOUND_FRAMES.has(msg.type)) {
			onCopilotHostMessage?.(msg);
		}

		if (msg.type === "catalog" && ws.data.teamName === "host") {
			const projects = msg.projects;
			if (Array.isArray(projects)) {
				const catalogProjects = new Set<string>();
				offlineCatalog.clear();
				for (const p of projects) {
					if (typeof p.team === "string" && typeof p.projectPath === "string") {
						offlineCatalog.set(p.team, p.projectPath);
						knownTeamPaths.set(p.team, p.projectPath);
						catalogProjects.add(p.team);
					}
				}
				ws.data.catalogProjects = catalogProjects;
				console.log(`[ws] catalog received: ${offlineCatalog.size} projects`);
				const spawns = msg.hostSpawns;
				if (Array.isArray(spawns) && hostSpawnPoints) {
					hostSpawnPoints.ids = spawns.filter((s): s is string => typeof s === "string" && s.length > 0);
					hostSpawnPoints.known = true;
					const named = (list: unknown): string[] =>
						Array.isArray(list)
							? list.filter((s): s is string => typeof s === "string" && s.length > 0)
							: [];
					const sent = HarnessSpawnsSchema.safeParse(msg.harnessSpawns);
					if (msg.harnessSpawns !== undefined && sent.success) {
						hostSpawnPoints.harnessSpawns = Object.fromEntries(
							SESSION_HARNESSES.map((harness) => [harness, sent.data[harness] ?? []]),
						);
					} else {
						// FIXME 2026-11-23: drop, once every daemon sends `harnessSpawns`.
						// Claude everywhere.
						hostSpawnPoints.harnessSpawns = {
							claude: Array.isArray(msg.claudeSpawns)
								? named(msg.claudeSpawns)
								: ["host", ...hostSpawnPoints.ids],
							copilot: named(msg.copilotSpawns),
						};
					}
					console.log(`[ws] host spawn points: ${hostSpawnPoints.ids.join(", ") || "(none beyond host)"}`);
					takeContainers(msg.containers);
				}
				onCatalogChange?.(ws.data.daemonInstanceId);
			}
		}

		if (msg.type === "containers" && ws.data.teamName === "host" && hostSpawnPoints?.known) {
			if (takeContainers(msg.containers)) onSpawnPointsChange?.();
		}

		if (
			msg.type === "restart_pending" &&
			ws.data.teamName === "host" &&
			typeof msg.team === "string" &&
			typeof msg.pending === "boolean"
		) {
			onRestartPending?.(msg.team, msg.pending);
		}

		// The daemon never writes a state a session's own plugin reports.
		if (
			msg.type === "presence_derive" &&
			ws.data.teamName === "host" &&
			typeof msg.team === "string" &&
			!reportsOwnState(msg.team)
		) {
			// A bare frame clears.
			if (msg.working === undefined) onPresenceDerive?.(msg.team, undefined);
			else {
				const derived = DerivedPresenceSchema.safeParse(msg);
				if (derived.success) onPresenceDerive?.(msg.team, derived.data);
				else console.warn(`[ws] presence_derive refused for ${msg.team}`);
			}
			flushHandshakes();
		}

		ws.data.missedPings = 0;
	}

	/** A daemon that sends none leaves none. */
	function takeContainers(raw: unknown): boolean {
		if (!hostSpawnPoints) return false;
		const parsed = ContainerListSchema.safeParse(raw);
		hostSpawnPoints.containers = parsed.success ? parsed.data : undefined;
		return true;
	}

	function close(ws: ServerWebSocket<WsData>): void {
		const teamName = ws.data.teamName;
		const subId = ws.data.subId;

		// Before the stale return: a REPLACED socket can never answer what it was carrying, so its waits
		// must fail now rather than each spending the full timeout.
		const stranded = (workspacePlane?.dropped(ws) ?? 0) + (sessionControl?.dropped(ws) ?? 0);
		if (stranded > 0) console.log(`[plane] ${stranded} op(s) stranded by ${teamName}/${subId} closing`);

		if (ws.data.isStale) {
			console.log(`[ws] stale socket closed for ${teamName}/${subId} - ignoring`);
			return;
		}

		if (!teamName) return;

		if (teamName === "host") {
			ws.data.daemonInstanceId = undefined;
			ws.data.catalogProjects = undefined;
			const subs = registry.get(teamName);
			if (subs) {
				subs.delete(subId);
				if (subs.size === 0) {
					registry.delete(teamName);
					offlineCatalog.clear();
					if (hostSpawnPoints) {
						hostSpawnPoints.known = false;
						hostSpawnPoints.ids = [];
						hostSpawnPoints.harnessSpawns = {};
						hostSpawnPoints.containers = undefined;
					}
					hostOpCoordinator?.failAll("host daemon disconnected");
					wakeCoordinator.failAll();
					console.log(`[ws] host disconnected - offline catalog cleared`);
					onTeamDisconnect?.(teamName);
				} else {
					console.log(`[ws] host/${subId} disconnected (${subs.size} remaining)`);
				}
			}
			const hostConversationId = ws.data.conversationId;
			if (hostConversationId && conversationRegistry.get(hostConversationId) === ws) {
				conversationRegistry.delete(hostConversationId);
			}
			return;
		}

		const subs = registry.get(teamName);
		if (!subs) return;

		if (subs.get(subId) !== ws) {
			// Stale closes cannot clean up a replacement socket.
			console.log(`[ws] stale close for ${teamName}/${subId} - skipping cleanup`);
			return;
		}

		subs.delete(subId);
		console.log(`[ws] ${teamName}/${subId} disconnected (${subs.size} remaining)`);

		handshakeGate.forget(teamName, subId);

		liveWriter?.clearLive(teamName, subId);

		const closingConversationId = ws.data.conversationId;
		if (closingConversationId && conversationRegistry.get(closingConversationId) === ws) {
			conversationRegistry.delete(closingConversationId);
		}

		const hasRealSubs = [...subs.values()].some((s) => !s.data.virtual);
		if (!hasRealSubs) {
			if (subs.size === 0) registry.delete(teamName);
			// Its plugin is the only reader.
			if (reportsOwnState(teamName)) onPresenceDerive?.(teamName, undefined);
			onTeamDisconnect?.(teamName);
		}
	}

	function establishRecord(
		ws: ServerWebSocket<WsData>,
		pending: { team: string; subId: string },
	): "confirmed" | "refused" | "not-recorded" {
		if (!sessionStore) return "not-recorded";
		const claudeSessionId = ws.data.claudeSessionId;
		let handover = false;
		if (claudeSessionId) {
			const holder = sessionStore.resumeRecord(claudeSessionId);
			if (holder && sessionStore.teamOf(holder) !== pending.team) {
				const holderTeam = sessionStore.teamOf(holder);
				const live = resolveLiveIncarnation(registry, sessionStore, holderTeam);
				if (live && live !== ws && live.readyState === 1 && !live.data.virtual) {
					console.log(
						`[ws] transcript binding refused: ${pending.team}/${pending.subId} conflicts with ${holderTeam}`,
					);
					return "refused";
				}
				handover = true;
			}
		}
		const record = liveWriter?.establishOnConfirm(pending.team, {
			claudeSessionId,
			harness: foldHarness(ws.data.harness ?? readHarness(undefined), {
				named: (named) => named,
				unnamed: (assumed) => assumed,
				// A plugin knows its CLI.
				unpicked: () => null,
				// A newer plugin's CLI creates none.
				unknown: () => null,
			}),
			label: ws.data.cwdName,
			live: { team: pending.team, subId: pending.subId },
			handover,
		});
		if (record) {
			console.log(
				`[ws] session record ${sessionStore.teamOf(record)} confirmed (label "${record.sessionLabel}")`,
			);
		}
		return record ? "confirmed" : "refused";
	}

	function pong(ws: ServerWebSocket<WsData>): void {
		ws.data.missedPings = 0;
		if (ws.data.handshakeConfirmed && ws.data.teamName) sessionStore?.touchLive(ws.data.teamName);
	}

	function resolveHandshake(
		sessionId: string,
		replyAsJson?: Record<string, unknown>,
		responderToken?: Presented,
	): boolean {
		const pending = handshakeGate.pendingOf(sessionId);
		if (!pending) return false;

		// Only the challenged session may answer its handshake.
		const challenged = registry.get(pending.team)?.get(pending.subId);
		if (auth && !auth.satisfies(auth.toAnswerFor(challenged), responderToken ?? NOTHING_PRESENTED)) {
			console.log(`[ws] ignored handshake answer for ${pending.team} - not from the challenged session`);
			return true;
		}
		handshakeGate.consume(sessionId);

		const subs = registry.get(pending.team);
		const ws = subs?.get(pending.subId);
		if (!ws) return true;
		if (ws.readyState !== 1) return true;

		const claim = HandshakeGate.leadClaim(replyAsJson);
		if (claim === undefined) {
			console.log(`[ws] ignored malformed handshake answer: ${pending.team}/${pending.subId}`);
			return true;
		}
		if (claim) {
			if (establishRecord(ws, pending) === "refused") {
				evictSocket(ws);
				return true;
			}
			confirmHandshake(ws);
			if (auth) handshakeGate.confirmLead(pending.team, auth.toAnswerFor(ws));
			console.log(`[ws] handshake confirmed: ${pending.team}/${pending.subId} is lead`);
		} else {
			console.log(`[ws] handshake rejected: ${pending.team}/${pending.subId} is worker, closing`);
			sendOn(ws, JSON.stringify({ type: "handshake_reject" }), "handshake_reject");
			evictSocket(ws);
		}
		return true;
	}

	return {
		open,
		message,
		close,
		heartbeatInterval,
		heartbeatTick,
		resolveHandshake,
		pong,
		findPendingHandshakeId: (team: string, subId: string) => handshakeGate.pendingIdFor(team, subId),
		repushHandshake,
		// Proxy only projects reported by the host catalog.
		isConnectorProject: (project: string) => offlineCatalog.has(project),
	};
}
