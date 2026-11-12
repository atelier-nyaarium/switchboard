// What setup reads off an installed OpenCode, apart from running it.

import { OPENCODE_PIN } from "../../src/shared/session-harness.js";

/** The version in a `--version` answer, which may carry a name or a leading `v`. */
export function versionIn(answer: string): string | undefined {
	return answer.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];
}

/** The menu line's right half. */
export function opencodeStatusLine(installed: string | undefined): string {
	if (installed === OPENCODE_PIN) return "Installed";
	return installed ? `This machine has ${installed}` : "Not installed";
}
