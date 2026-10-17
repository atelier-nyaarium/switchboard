import { baselineHookOutput } from "./mcp/baseline/baselineHook.js";

// Stdout becomes the session's context.

const output = await baselineHookOutput(process.env);
if (output) process.stdout.write(output);
process.exit(0);
