// Launcher site inside a dev container.

import path from "node:path";
import type { TmuxTarget } from "../../shared/host-op.js";
import { composeSessionName } from "../../shared/session-id.js";
import type { LaunchSite } from "./sessionLaunch.js";

////////////////////////////////
//  Interfaces & Types

/** One command in a target's container, as its user; throws on a non-zero exit. */
export type PlaceExec = (target: Pick<TmuxTarget, "kind" | "name">, argv: string[]) => Promise<string>;

export interface RuntimeCopy {
	/** In the container, as its user. */
	exec(argv: string[]): Promise<string>;
	/** `docker` on this machine. */
	docker(args: string[]): Promise<unknown>;
	container: string;
	/** The daemon checkout holding the runtime. */
	source: string;
	version: string;
}

////////////////////////////////
//  Constants

export const CONTAINER_HOME = "/home/vscode";
const CONTAINER_BUN = `${CONTAINER_HOME}/.bun/bin/bun`;
const CACHE = `${CONTAINER_HOME}/.cache/switchboard`;
const STATUS_DIR = `${CACHE}/launch`;
// `package.json` last: it marks a whole copy.
const RUNTIME_PARTS = ["dist", "launch", "package.json"];

////////////////////////////////
//  Functions & Helpers

/** A build's runtime in a container, by its version. */
export function containerRuntimeRoot(version: string): string {
	if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error(`refusing a runtime version "${version.slice(0, 32)}"`);
	return `${CACHE}/runtime/${version}`;
}

export function containerLaunchSite(version: string, exec: PlaceExec): LaunchSite {
	const statusFile = (target: TmuxTarget) =>
		`${STATUS_DIR}/${composeSessionName(target.name, target.sessionName)}.json`;
	return {
		runtime: CONTAINER_BUN,
		root: containerRuntimeRoot(version),
		statusFile,
		readStatus: (target) => exec(target, ["cat", statusFile(target)]).catch(() => undefined),
		// Before every launch, so the launcher always has its folder.
		clearStatus: async (target) => {
			await exec(target, ["sh", "-c", 'mkdir -p "$1" && rm -f "$2"', "sh", STATUS_DIR, statusFile(target)]);
		},
	};
}

/** Copies the daemon's runtime into a container, unless that version is whole there. */
export async function placeRuntime(copy: RuntimeCopy): Promise<"present" | "copied"> {
	const root = containerRuntimeRoot(copy.version);
	const present = await copy.exec(["test", "-f", `${root}/package.json`]).then(
		() => true,
		() => false,
	);
	if (present) return "present";
	// A copy cut short starts over.
	await copy.exec(["sh", "-c", 'rm -rf "$1" && mkdir -p "$1"', "sh", root]);
	for (const part of RUNTIME_PARTS) {
		await copy.docker(["cp", "-a", path.join(copy.source, part), `${copy.container}:${root}/${part}`]);
	}
	return "copied";
}
