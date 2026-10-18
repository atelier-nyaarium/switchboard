import { gateHookOutput } from "./mcp/assistant/gateHook.js";
import { baselineHookOutput } from "./mcp/baseline/baselineHook.js";

// Stdout becomes the hook's answer.

const output =
	process.argv[2] === "gate" ? gateHookOutput(await readStdin(), process.env) : await baselineHookOutput(process.env);
// Exit only once the pipe has the whole answer, or a cut deny reads as invalid.
if (output) process.stdout.write(output, () => process.exit(0));
else process.exit(0);

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}
