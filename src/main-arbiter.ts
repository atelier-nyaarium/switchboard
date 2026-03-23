import { startArbiter } from "./arbiter/index.js";

startArbiter().catch((err) => {
	console.error(`[arbiter] fatal:`, err);
	process.exit(1);
});
