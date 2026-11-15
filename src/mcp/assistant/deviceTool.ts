import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readingInDisplay } from "../../shared/field-values.js";
import { ACTION_FRONT_ROUTES, type ActionRunResult, ActionRunResultSchema } from "../../shared/schemasActionFront.js";
import {
	DEVICE_TOOL,
	DEVICE_TOOL_RESULTS,
	type DeviceToolOp,
	DeviceToolOpSchema,
} from "../../shared/schemasDeviceTool.js";
import { RouterHttpError, routerPost } from "../bridge/helpers.js";
import { phoneText, type ToolText, text } from "./actionFront.js";

/** Answer read by kind. */
export function deviceText(op: DeviceToolOp, result: ActionRunResult): ToolText {
	const answer = result.kind === "ok" ? DEVICE_TOOL_RESULTS[op.kind].safeParse(result.answer).data : undefined;
	const failed = result.kind !== "ok" || answer === undefined || answer.kind === "refused";
	if (answer?.kind === "sensor") {
		const display = answer.temperatureUnit ?? "C";
		const { temperatureUnit: _temperatureUnit, ...sensor } = answer;
		const readings = sensor.readings.map((reading) => {
			const shown = readingInDisplay(reading, display);
			return {
				...reading,
				spec: shown.spec,
				...(shown.shown === undefined ? {} : { value: shown.shown }),
				...(reading.low && shown.low ? { low: { ...reading.low, value: shown.low.shown } } : {}),
				...(reading.high && shown.high ? { high: { ...reading.high, value: shown.high.shown } } : {}),
			};
		});
		return text(phoneText(result, { ...sensor, readings }), failed);
	}
	return text(phoneText(result, answer), failed);
}

function unreachable(error: unknown): ToolText {
	const status = error instanceof RouterHttpError ? error.status : null;
	// An older Gateway refuses the body.
	if (status === 404 || status === 400)
		return text(`This Gateway does not serve ${DEVICE_TOOL}; it needs updating.`, true);
	const where = status === null ? "" : ` (HTTP ${status})`;
	return text(
		`Could not reach the Gateway${where}; it may still have run, so device_read before sending it again: ${(error as Error).message}`,
		true,
	);
}

export function registerDeviceTool(mcpServer: McpServer): void {
	mcpServer.registerTool(
		DEVICE_TOOL,
		{
			title: "Device",
			description: `
# Device

One op on the owner's paired devices, run on the Gateway. Start with \`device_list\`: each device's id, name, kind, driver, revision, and a switch's state and capabilities or a sensor's \`heardAt\` and \`stale\`. An id is the lower-case colon MAC from that list; a name is not an id.

- \`device_read\`: a switch's state, schedule and settings; a sensor's readings with their 24-hour lows and highs, when last heard, and why stale.
- \`device_set\`: \`on\`, \`off\` or \`toggle\`, switches only. After a \`toggle\` answering \`timeout\`, \`device_read\` before another.
- \`device_rename\`, \`device_schedule_put\`, \`device_setting_put\`: carry the device's \`revision\` from the list; \`stale\` means read again. A schedule put carries the schedule it edits as \`base\`. A sensor takes only a rename.
- A danger setting, such as cloud disconnect, waits for the owner's approval on the phone. A denial's note steers you.

A refusal names a \`code\`. \`effect\` \`unknown\` means the device may have changed, and \`landed\` counts the steps that did.
			`.trim(),
			inputSchema: { op: DeviceToolOpSchema },
		},
		async ({ op }) => {
			let result: ActionRunResult;
			try {
				result = ActionRunResultSchema.parse(
					await routerPost(ACTION_FRONT_ROUTES.run, { device: op, callId: randomUUID() }, { retries: 2 }),
				);
			} catch (error) {
				return unreachable(error);
			}
			return deviceText(op, result);
		},
	);
}
