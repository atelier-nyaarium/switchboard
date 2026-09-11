// Remove-by: 2026-09-25, once every Gateway-held blob is bound on the Router.
// Drives this machine's `/migration/router-blobs` route and prints its answer. Exit 0 on `done`.

import { envGet } from "./lib/host.js";

const token = process.env.ROUTER_BLOB_MIGRATION_TOKEN || (await envGet("ROUTER_BLOB_MIGRATION_TOKEN"));
if (!token) {
	console.error("ROUTER_BLOB_MIGRATION_TOKEN is not set in .env; set one and restart the gateway");
	process.exit(2);
}

const response = await fetch("http://127.0.0.1:20000/migration/router-blobs", {
	method: "POST",
	headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
	body: "{}",
});
const answer = (await response.json()) as { outcome?: string; error?: string };
console.log(JSON.stringify(answer, null, 2));
process.exit(response.ok && answer.outcome === "done" ? 0 : 1);
