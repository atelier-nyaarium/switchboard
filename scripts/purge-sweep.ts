// The one sweep: every thread the Codex, OpenCode and Copilot stores hold that no session in the roster names.
//
//   bun scripts/purge-sweep.ts                      a dry run: prints the counts and a fingerprint
//   bun scripts/purge-sweep.ts --delete <fingerprint>   deletes exactly the set that fingerprint named
//
// The Gateway lists, sorts and queues; this only asks and prints. A set that moved since its dry run is
// refused and shown again.

import { PURGE_SWEEP_PATH, type SweepAnswer, type SweepPlan } from "../src/shared/schemasPurgeSweep.js";
import { envGet } from "./lib/host.js";
import { GATEWAY_URL } from "./setup-constants.js";

/** The listing may open each CLI's client. */
const SWEEP_WAIT_MS = 200_000;

function show(plan: SweepPlan): void {
	const head = ["place", "store", "listed", "kept", "running", "unreadable", "agents' threads", "unnamed"];
	const rows = plan.rows.map((row) =>
		row.error
			? [row.place, row.backend, `not swept: ${row.error}`]
			: [row.place, row.backend, row.listed, row.kept, row.running, row.unreadable, row.agents, row.unnamed].map(
					String,
				),
	);
	const widths = head.map((title, at) =>
		Math.max(title.length, ...rows.map((row) => (row.length > 3 ? row[at]!.length : 0))),
	);
	const line = (cells: string[]): string =>
		cells.length > 3 ? cells.map((cell, at) => cell.padEnd(widths[at]!)).join("  ") : cells.join("  ");
	console.log(line(head));
	for (const row of rows) console.log(line(row));
	const swept = plan.rows.filter((row) => !row.error);
	const total = (pick: (row: SweepPlan["rows"][number]) => number): number =>
		swept.reduce((sum, row) => sum + pick(row), 0);
	console.log("");
	console.log(
		`to delete: ${total((row) => row.agents + row.unnamed)} threads (${total((row) => row.agents)} an agent names, ${total((row) => row.unnamed)} no record names)`,
	);
	console.log(
		`left: ${total((row) => row.kept)} kept, ${total((row) => row.running)} running, ${total((row) => row.unreadable)} unreadable`,
	);
	console.log(
		`left by earlier forgets on this Gateway: ${plan.orphans.claims} claim files, ${plan.orphans.jobs} held rows`,
	);
	if (plan.stopped.length > 0) console.log(`not swept, container not running: ${plan.stopped.join(", ")}`);
}

const args = process.argv.slice(2);
const at = args.indexOf("--delete");
const expect = at >= 0 ? args[at + 1] : undefined;
if (at >= 0 && !expect) {
	console.error("--delete needs the fingerprint a dry run printed");
	process.exit(2);
}

const token = await envGet("HOST_WS_TOKEN");
if (!token) {
	console.error("HOST_WS_TOKEN is missing from .env");
	process.exit(1);
}
const response = await fetch(`${GATEWAY_URL}${PURGE_SWEEP_PATH}`, {
	method: "POST",
	headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	body: JSON.stringify(expect ? { apply: true, expect } : {}),
	signal: AbortSignal.timeout(SWEEP_WAIT_MS),
});
if (!response.ok) {
	console.error(`the Gateway answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
	process.exit(1);
}
const answer = (await response.json()) as SweepAnswer;
if (!answer.plan) {
	console.error("no host daemon is connected, so nothing can be listed");
	process.exit(1);
}
show(answer.plan);
console.log("");
if (answer.applied) {
	console.log(
		`queued ${answer.queued} deletes, ended ${answer.ended} agents' threads, dropped ${answer.orphans.claims} claim files and ${answer.orphans.jobs} held rows`,
	);
	console.log(
		"The Gateway's purge queue deletes them one at a time; watch `docker logs switchboard | grep '\\[purge\\]'` for failures.",
	);
} else if (answer.reason === "changed") {
	console.log(
		`The set moved since that fingerprint was shown. Nothing was deleted. These are the counts now, under ${answer.plan.fingerprint}.`,
	);
	process.exit(3);
} else {
	console.log(
		`dry run: nothing deleted. To delete exactly this set: bun scripts/purge-sweep.ts --delete ${answer.plan.fingerprint}`,
	);
}
