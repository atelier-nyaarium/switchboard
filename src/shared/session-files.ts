////////////////////////////////
//  Constants

/** Session CLI home-relative paths. */
export const SESSION_CAPABILITIES_DIR = ".config/switchboard/session-capabilities";
export const LAUNCH_STATUS_DIR = ".cache/switchboard/launch";

////////////////////////////////
//  Functions & Helpers

/** Composite is `spawn.session`. */
export function sessionCapabilitiesFile(composite: string): string {
	return `${SESSION_CAPABILITIES_DIR}/${composite}.json`;
}

export function launchStatusFile(composite: string): string {
	return `${LAUNCH_STATUS_DIR}/${composite}.json`;
}

/** Session-scoped Switchboard files. */
export function ownSessionFiles(composite: string): string[] {
	return [sessionCapabilitiesFile(composite), launchStatusFile(composite)];
}
