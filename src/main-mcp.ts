import { startMcp } from "./mcp/index.js";

startMcp().catch((err) => {
	console.error(`[mcp] fatal:`, err);
	process.exit(1);
});
