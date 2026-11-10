import { HARNESS, type SessionHarness } from "../../shared/session-harness.js";

/** Bash run inside the container; true when it exits 0. Never throws. */
export type ContainerScript = (script: string) => Promise<boolean>;

/** Installs each CLI's plugins; whether any install landed. */
export async function provisionPlugins(
	found: readonly SessionHarness[],
	run: ContainerScript,
	log: (line: string) => void,
): Promise<boolean> {
	let landed = false;
	for (const harness of found) {
		const { label, plugins } = HARNESS[harness];
		if (!plugins || (await run(plugins.installed))) continue;
		await run(plugins.install);
		if (await run(plugins.installed)) {
			landed = true;
			log(`${label} plugins installed`);
		} else {
			log(`${label} plugins did not install`);
		}
	}
	return landed;
}
