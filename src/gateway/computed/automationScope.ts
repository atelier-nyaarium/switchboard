import type { FunctionArgs } from "../../shared/schemasAutomation.js";
import type { FunctionParam } from "../../shared/schemasFunction.js";
import type { FireNames } from "./automationFires.js";

/** A placeholder's scope in a function's step: the trigger's names win over parameters. */
export function placeholderScope(
	trigger: Readonly<FireNames> | null | undefined,
	params: readonly FunctionParam[],
	args: FunctionArgs | undefined,
	deviceName?: (device: string) => string | null,
): FireNames {
	return { ...functionScopeOf(params, args, deviceName), ...(trigger ?? {}) };
}

/** The names that scope holds. */
export function placeholderNames(trigger: readonly string[], params: readonly FunctionParam[]): string[] {
	return [...trigger, ...params.map((param) => param.name)];
}

export function functionScopeOf(
	params: readonly FunctionParam[],
	args: FunctionArgs | undefined,
	deviceName?: (device: string) => string | null,
): FireNames {
	const scope: FireNames = {};
	for (const param of params) {
		if (!args || !Object.hasOwn(args, param.name)) continue;
		const value = args[param.name];
		const shown = param.type === "device" ? deviceName?.(String(value)) : null;
		scope[param.name] = shown ? { value, shown } : { value };
	}
	return scope;
}
