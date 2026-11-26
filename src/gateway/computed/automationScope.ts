import type { FunctionValues } from "../../shared/schemasAutomation.js";
import type { FunctionParam } from "../../shared/schemasFunction.js";
import type { FireNames } from "./automationFires.js";

export function functionScopeOf(
	params: readonly FunctionParam[],
	values: FunctionValues | undefined,
	switchName?: (device: string) => string | null,
): FireNames {
	const scope: FireNames = {};
	for (const param of params) {
		if (!values || !Object.hasOwn(values, param.name)) continue;
		const value = values[param.name];
		const shown = param.type === "device" ? switchName?.(String(value)) : null;
		scope[param.name] = shown ? { value, shown } : { value };
	}
	return scope;
}
