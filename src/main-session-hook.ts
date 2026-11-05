import { gateHookOutput } from "./mcp/assistant/gateHook.js";
import { baselineHookOutput } from "./mcp/baseline/baselineHook.js";
import { capabilityHookOutput } from "./mcp/baseline/capabilityHook.js";

// Stdout becomes the hook's answer.

async function answer(mode: string | undefined): Promise<string | null> {
	if (mode === "gate") return gateHookOutput(await readStdin(), process.env);
	if (mode === "capabilities") return capabilityHookOutput(process.env);
	return baselineHookOutput(process.env);
}

const output = await answer(process.argv[2]);
// Exit only once the pipe has the whole answer, or a cut deny reads as invalid.
if (output) process.stdout.write(output, () => process.exit(0));
else process.exit(0);

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}
