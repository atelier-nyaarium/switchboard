import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiscoverCoverage } from "../../shared/console-protocol.js";
import { DiscoverAnswerSchema, type SpawnClis } from "../../shared/schemasConsoleResults.js";
import { Address, isComposite, parseSessionName, SpawnPoint } from "../../shared/session-id.js";
import type { TeamInfo } from "../../shared/types.js";
import { bridgeProjectName, routerGet } from "./helpers.js";

////////////////////////////////
//  Interfaces & Types

export interface DiscoverGroup {
	domainId: string;
	gatewayId: string;
	project: string;
	sessions: TeamInfo[];
}

////////////////////////////////
//  Functions & Helpers

/** Built via value objects so a bare team is not a spawn-point; display only. */
function displayTarget(domainId: string, gatewayId: string, team: string): string {
	try {
		const { project, session } = parseSessionName(team);
		return isComposite(team)
			? Address.of(domainId, gatewayId, project, session).canonical
			: SpawnPoint.of(domainId, gatewayId, project).canonical;
	} catch {
		return team;
	}
}

/** A team's spawn-point, whether or not a session exists under it. Display, not a trust boundary. */
function displayHeader(domainId: string, gatewayId: string, project: string): string {
	try {
		return SpawnPoint.of(domainId, gatewayId, project).canonical;
	} catch {
		return project;
	}
}

/** A coarse "5m ago" / "2h ago" recency label for an asleep session's last-seen timestamp. */
export function relativeAge(lastActiveMs: number, nowMs: number = Date.now()): string {
	const s = Math.max(0, Math.floor((nowMs - lastActiveMs) / 1000));
	if (s < 60) return `just now`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** Buckets by Gateway and project; trusts the wire `kind`, since project names may hold dots. */
export function groupDiscoverEntries(entries: TeamInfo[]): DiscoverGroup[] {
	const groups = new Map<string, DiscoverGroup>();
	for (const t of entries) {
		const project = t.kind === "devcontainer" ? t.team : parseSessionName(t.team).project;
		const key = `${t.domainId} ${t.gatewayId} ${project}`;
		let group = groups.get(key);
		if (!group) {
			group = { domainId: t.domainId, gatewayId: t.gatewayId, project, sessions: [] };
			groups.set(key, group);
		}
		if (t.kind !== "devcontainer") group.sessions.push(t);
	}
	return [...groups.values()];
}

export function coverageCaveat(coverage: DiscoverCoverage): string {
	if (!coverage.rosterKnown) {
		return `\n\nCaveat: the peer roster could not be read (Router unreachable or this Gateway is not registered), so machines beyond this Gateway may be missing.`;
	}
	const missing = [...(coverage.unreachable ?? []), ...(coverage.unreachablePeers ?? [])];
	if (missing.length === 0) return "";
	return `\n\nCaveat: asked ${coverage.asked} peer gateway(s), ${coverage.answered} answered. Unreachable: ${missing.join(", ")} - their sessions are missing above.`;
}

/** One header per bucket, its CLIs where known and its active sessions nested below. Exported for tests. */
export function formatDiscoverLines(entries: TeamInfo[], spawnClis: readonly SpawnClis[] = []): string[] {
	return groupDiscoverEntries(entries).flatMap(({ domainId, gatewayId, project, sessions }) => {
		const known = spawnClis.find(
			(held) => held.domainId === domainId && held.gatewayId === gatewayId && held.spawn === project,
		);
		const clis = known && known.clis.length > 0 ? ` (CLIs: ${known.clis.join(", ")})` : "";
		return [
			`- ${displayHeader(domainId, gatewayId, project)}${clis}`,
			...sessions.map((t) => `  - ${formatSessionLine(t)}`),
		];
	});
}

function formatSessionLine(t: TeamInfo): string {
	const address = displayTarget(t.domainId, t.gatewayId, t.team);
	const name = t.sessionLabel ? `${t.sessionLabel} (${address})` : address;
	if (t.status === "available") {
		const seen = t.lastActive ? `, last seen ${relativeAge(t.lastActive)}` : "";
		return `${name}: asleep${seen}`;
	}
	if (t.status === "verifying") return `${name}: connecting`;
	const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "online";
	return `${name}: ${status}`;
}

/** The assistant creates on its own Gateway's host spawn point. */
const hostRefusal = (guarded: boolean) =>
	guarded
		? `Another Gateway's host spawn point refuses session auto-creation. Ask the user to make one first.`
		: `Host spawn points refuse session auto-creation. Ask the user to make one first.`;

const description = (guarded: boolean) =>
	`
# Crosstalk Discover

List reachable agent teams, excluding this session.

Each team is a spawn point, with:
- Its CLIs, where known.
- Its active sessions, at their full addresses.
- Its asleep sessions, with their last-seen time.

A spawn point is not a target. To create a session under it, \`crosstalk_send\` with:
- \`displayLabel\`
- \`cli\`, when it lists several
- ${hostRefusal(guarded)}
`.trim();

export function registerBridgeDiscover(mcpServer: McpServer, { guarded = false }: { guarded?: boolean } = {}): void {
	mcpServer.registerTool(
		"crosstalk_discover",
		{
			title: `Crosstalk Discover`,
			description: description(guarded),
			inputSchema: {},
		},
		async () => {
			try {
				const { teams, coverage, localGatewayId, spawnClis } = DiscoverAnswerSchema.parse(
					await routerGet("/discover?coverage=1"),
				);
				// Self by Gateway; host by name.
				const isSelf = (t: TeamInfo) => t.team === bridgeProjectName() && t.gatewayId === localGatewayId;
				const others = teams.filter((t) => !isSelf(t) && t.team !== "host" && t.kind !== "console");
				const lines = formatDiscoverLines(others, spawnClis);
				const caveat = coverageCaveat(coverage);
				if (lines.length === 0) {
					return { content: [{ type: "text" as const, text: `No other sessions found.${caveat}` }] };
				}

				return {
					content: [{ type: "text" as const, text: `Sessions on the bridge:\n${lines.join("\n")}${caveat}` }],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to reach router: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
