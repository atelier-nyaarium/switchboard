// Launcher site inside a dev container.

import path from "node:path";
import type { TmuxTarget } from "../../shared/host-op.js";
import { PLUGIN_ROOT_PARTS } from "../../shared/plugin-root.js";
import { LAUNCH_STATUS_DIR, launchStatusFile } from "../../shared/session-files.js";
import { composeSessionName } from "../../shared/session-id.js";
import { createSingleFlight } from "../../shared/single-flight.js";
import type { LaunchSite } from "./sessionLaunch.js";

////////////////////////////////
//  Interfaces & Types

/** One command in a container; throws on failure. */
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
export const CONTAINER_BUN = `${CONTAINER_HOME}/.bun/bin/bun`;
const CACHE = `${CONTAINER_HOME}/.cache/switchboard`;
const STATUS_DIR = `${CONTAINER_HOME}/${LAUNCH_STATUS_DIR}`;

////////////////////////////////
//  Functions & Helpers

/** A build's runtime, by version. */
export function containerRuntimeRoot(version: string): string {
	if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error(`refusing a runtime version "${version.slice(0, 32)}"`);
	return `${CACHE}/runtime/${version}`;
}

export function containerLaunchSite(version: string, exec: PlaceExec): LaunchSite {
	const statusFile = (target: TmuxTarget) =>
		`${CONTAINER_HOME}/${launchStatusFile(composeSessionName(target.name, target.sessionName))}`;
	return {
		runtime: CONTAINER_BUN,
		root: containerRuntimeRoot(version),
		statusFile,
		readStatus: (target) => exec(target, ["cat", statusFile(target)]).catch(() => undefined),
		// Makes the folder too.
		clearStatus: async (target) => {
			await exec(target, ["sh", "-c", 'mkdir -p "$1" && rm -f "$2"', "sh", STATUS_DIR, statusFile(target)]);
		},
	};
}

/** Copies the runtime into a container. */
export async function placeRuntime(copy: RuntimeCopy): Promise<"present" | "copied"> {
	const root = containerRuntimeRoot(copy.version);
	const present = await copy.exec(["test", "-f", `${root}/package.json`]).then(
		() => true,
		() => false,
	);
	if (present) return "present";
	// A cut copy starts over.
	const folders = PLUGIN_ROOT_PARTS.map((part) => path.posix.join(root, path.posix.dirname(part)));
	await copy.exec(["sh", "-c", 'rm -rf "$1" && shift && mkdir -p "$@"', "sh", root, ...new Set(folders)]);
	for (const part of PLUGIN_ROOT_PARTS) {
		await copy.docker(["cp", "-a", path.join(copy.source, part), `${copy.container}:${root}/${part}`]);
	}
	return "copied";
}

/** One at a time per container and version: a second `docker cp` nests the folder. */
export function createRuntimePlacer(): (copy: RuntimeCopy) => Promise<"present" | "copied"> {
	const flights = createSingleFlight<string, "present" | "copied">();
	return (copy) => flights.run(`${copy.container}:${copy.version}`, () => placeRuntime(copy));
}
