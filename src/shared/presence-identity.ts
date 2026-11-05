import { stableHash } from "./plane-registry.js";
import type { TeamInfo } from "./types.js";

export type PresenceRow = TeamInfo;

/** Hashes presence rows without the high-churn `lastActive` field. */
export function presenceIdentityOf(rows: PresenceRow[]): string {
	return stableHash(rows.map(({ lastActive: _lastActive, ...rest }) => rest));
}
