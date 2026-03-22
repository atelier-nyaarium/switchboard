import { existsSync } from "node:fs";

export function isInsideContainer(): boolean {
	return existsSync("/.dockerenv") || !!process.env.REMOTE_CONTAINERS;
}
