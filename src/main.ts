import { startArbiter } from "./arbiter/index.js";
import { startMcp } from "./mcp/index.js";

if (process.argv.includes("--arbiter")) {
	startArbiter();
} else {
	startMcp().catch((err) => {
		console.error(`[mcp] fatal:`, err);
		process.exit(1);
	});
}
