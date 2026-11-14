import { createHash } from "node:crypto";
import type { ParamsOf } from "../../shared/schemasAssistantActions.js";
import { type ActionContext, stoppedBy, WatcherAction } from "./watcherAction.js";

/** Automation id, member hash. */
const shortId = (member: string): string =>
	`${(member.split(":")[1] ?? "event").slice(0, 40)}:${createHash("sha256").update(member).digest("hex").slice(0, 12)}`;

export class SensorsClear extends WatcherAction<"sensors_clear"> {
	readonly key = "sensors_clear";

	constructor(private readonly clear: (members: readonly string[]) => boolean) {
		super();
	}

	async run(params: ParamsOf<"sensors_clear">, ctx: ActionContext) {
		const stopped = stoppedBy(ctx);
		if (stopped) return { threads: [], note: stopped };
		if (!this.clear(params.members)) throw new Error("the sensor events could not be cleared");
		return { threads: params.members.map((member) => ({ threadId: shortId(member), outcome: "done" as const })) };
	}
}
