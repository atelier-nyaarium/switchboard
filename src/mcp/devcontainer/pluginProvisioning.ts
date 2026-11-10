import { HARNESS, type SessionHarness } from "../../shared/session-harness.js";

/** Bash run inside the container; true when it exits 0. Never throws. */
export type ContainerScript = (script: string) => Promise<boolean>;

export interface Provisioned {
	/** Any install landed. */
	landed: boolean;
	/** Each CLI whose own check now passes, or that needs nothing. */
	ready: SessionHarness[];
}

/** Which CLIs each container incarnation has set up; a failure or a CLI found later stays pending. */
export function createProvisionLedger() {
	const held = new Map<string, { id: string; ready: Set<SessionHarness> }>();
	const entry = (project: string, id: string) => {
		const prior = held.get(project);
		const current = prior?.id === id ? prior : { id, ready: new Set<SessionHarness>() };
		held.set(project, current);
		return current;
	};
	return {
		pending(project: string, id: string, found: readonly SessionHarness[]): SessionHarness[] {
			const { ready } = entry(project, id);
			return found.filter((harness) => !ready.has(harness));
		},
		settled(project: string, id: string, ready: readonly SessionHarness[]): void {
			for (const harness of ready) entry(project, id).ready.add(harness);
		},
	};
}

/**
 * Installs each found CLI's plugins its own way, and judges it by the row's own check. A CLI already
 * set up, or one that needs none, is left alone.
 */
export async function provisionPlugins(
	found: readonly SessionHarness[],
	run: ContainerScript,
	log: (line: string) => void,
): Promise<Provisioned> {
	let landed = false;
	const ready: SessionHarness[] = [];
	for (const harness of found) {
		const { label, plugins } = HARNESS[harness];
		if (!plugins || (await run(plugins.installed))) {
			ready.push(harness);
			continue;
		}
		await run(plugins.install);
		if (await run(plugins.installed)) {
			landed = true;
			ready.push(harness);
			log(`${label} plugins installed`);
		} else {
			log(`${label} plugins did not install`);
		}
	}
	return { landed, ready };
}
