// Whether a trigger and an automation's values fill what a function takes.

import { stepsOf } from "./automation-walk.js";
import { type ConsoleNode, parseConsole } from "./live-console-grammar.js";
import type { AutomationTriggerKind, FunctionValue } from "./schemasAutomation.js";
import type { AutomationFunction, FunctionParam, FunctionParamType, FunctionStep, StepArg } from "./schemasFunction.js";
import { scanHoles } from "./text-holes.js";

export const GIVEN_TYPES = ["event", "text", "number", "device", "time"] as const;
export type GivenType = (typeof GIVEN_TYPES)[number];

/** The watched field's type. */
export const GIVES_OF_FIELD = "of_field";
export type GivesType = GivenType | typeof GIVES_OF_FIELD;

/** In `AUTOMATION_TRIGGERS` order. */
export const AUTOMATION_TRIGGER_GIVES = {
	event: [
		{ name: "event", type: "event" },
		{ name: "source", type: "text" },
	],
	value: [
		{ name: "value", type: GIVES_OF_FIELD },
		{ name: "field", type: "text" },
	],
	crossing: [
		{ name: "value", type: "number" },
		// The sensor's name, never a switch.
		{ name: "device", type: "text" },
		{ name: "measure", type: "text" },
		{ name: "threshold", type: "number" },
	],
	time: [{ name: "time", type: "time" }],
	interval: [{ name: "time", type: "time" }],
} as const satisfies Record<AutomationTriggerKind, readonly { name: string; type: GivesType }[]>;

/** Every event gives these beside its source's declared fields. */
export const EVENT_GIVEN_FIELDS = ["id", "title", "url"] as const;
export type EventGivenField = (typeof EVENT_GIVEN_FIELDS)[number];

export interface TriggerGiven {
	names: readonly { name: string; type: GivenType }[];
	/** Event triggers only. */
	eventFields?: readonly string[];
}

export interface FunctionReads {
	names: readonly string[];
	/** Read by name. */
	eventFields: readonly string[];
}

export interface FitAnswer {
	fits: boolean;
	/** Another source's event. */
	hidden: boolean;
	/** Names this trigger lacks. */
	requires: string[];
	/** Still to set. */
	unset: string[];
	/** Wrong type. */
	wrong: { name: string; wants: FunctionParamType; gets: GivenType }[];
}

const TRIGGER_NAMES: ReadonlySet<string> = new Set(
	Object.values(AUTOMATION_TRIGGER_GIVES).flatMap((names) => names.map((held) => held.name)),
);

const childrenOf = (node: ConsoleNode): (ConsoleNode | null)[] => {
	switch (node.kind) {
		case "member":
			return [node.target];
		case "call":
			return [node.target, ...node.args];
		case "index":
			return [node.target, node.index];
		case "unary":
			return [node.operand];
		case "binary":
			return [node.left, node.right];
		case "list":
			return node.items;
		case "dict":
			return node.entries.map((entry) => entry.value);
		case "ident":
		case "literal":
			return [];
	}
};

function collect(node: ConsoleNode | null, into: { names: Set<string>; eventFields: Set<string> }): void {
	if (!node) return;
	if (node.kind === "ident" && TRIGGER_NAMES.has(node.name)) into.names.add(node.name);
	if (node.kind === "member" && node.target.kind === "ident" && node.target.name === "event")
		into.eventFields.add(node.name);
	if (node.kind === "index" && node.target.kind === "ident" && node.target.name === "event") {
		const at = node.index;
		if (at?.kind === "literal" && typeof at.value === "string") into.eventFields.add(at.value);
	}
	for (const child of childrenOf(node)) collect(child, into);
}

/** A bare `event` prints its title. */
const BARE_EVENT = "title";

function eventWord(node: ConsoleNode | null, into: Set<string>): void {
	if (!node) return;
	const onEvent = (target: ConsoleNode) => target.kind === "ident" && target.name === "event";
	if (node.kind === "ident" && node.name === "event") into.add(BARE_EVENT);
	if (node.kind === "member" && onEvent(node.target)) {
		into.add(node.name);
		return;
	}
	if (node.kind === "index" && onEvent(node.target)) {
		const at = node.index;
		into.add(at?.kind === "literal" && typeof at.value === "string" ? at.value : BARE_EVENT);
		eventWord(at, into);
		return;
	}
	for (const child of childrenOf(node)) eventWord(child, into);
}

/** The event's fields these texts and expressions read, in reading order. */
export function eventWords(read: { texts: readonly string[]; expressions: readonly string[] }): string[] {
	const into = new Set<string>();
	const source = (text: string) => {
		for (const statement of parseConsole(text).statements) eventWord(statement.node, into);
	};
	for (const text of read.texts) for (const part of scanHoles(text)) if (part.kind === "hole") source(part.source);
	for (const text of read.expressions) source(text);
	return [...into];
}

export function functionReads(fn: Pick<AutomationFunction, "steps">): FunctionReads {
	const into = { names: new Set<string>(), eventFields: new Set<string>() };
	const read = (source: string) => {
		for (const statement of parseConsole(source).statements) collect(statement.node, into);
	};
	const text = (value: string) => {
		for (const part of scanHoles(value)) if (part.kind === "hole") read(part.source);
	};
	const expression = (held: StepArg) => {
		if (held.kind === "expression") read(held.text);
	};
	const arg = (held: StepArg) => {
		if (held.kind === "expression") read(held.text);
		else if (typeof held.value === "string") text(held.value);
	};
	const none = () => undefined;
	const reads: { [K in FunctionStep["kind"]]: (step: Extract<FunctionStep, { kind: K }>) => void } = {
		do: (step) => Object.values(step.args).forEach(arg),
		if: (step) => read(step.when),
		let: (step) => expression(step.value),
		wait: (step) => expression(step.minutes),
		throw: (step) => (step.text === undefined ? undefined : text(step.text)),
		try: none,
		exit: none,
		note: none,
	};
	for (const { step } of stepsOf(fn)) (reads[step.kind] as (step: FunctionStep) => void)(step);
	return { names: [...into.names].sort(), eventFields: [...into.eventFields].sort() };
}

export function triggerGiven(
	kind: AutomationTriggerKind,
	context: { fieldType?: GivenType; eventFields?: readonly string[] } = {},
): TriggerGiven {
	const names = AUTOMATION_TRIGGER_GIVES[kind].map(({ name, type }) => ({
		name,
		type: type === GIVES_OF_FIELD ? (context.fieldType ?? "text") : type,
	}));
	return kind === "event"
		? { names, eventFields: [...new Set([...(context.eventFields ?? []), ...EVENT_GIVEN_FIELDS])] }
		: { names };
}

const valueType = (value: FunctionValue): GivenType => (typeof value === "number" ? "number" : "text");

/** A text may fill a device. */
const takes = (wants: FunctionParamType, gets: GivenType): boolean =>
	wants === gets || (wants === "device" && gets === "text");

export function fitOf(
	given: TriggerGiven,
	fn: { params: readonly FunctionParam[]; reads: FunctionReads },
	values: Readonly<Record<string, FunctionValue>>,
): FitAnswer {
	const gives = new Map(given.names.map(({ name, type }) => [name, type]));
	const declared = new Set(fn.params.map((param) => param.name));
	const requires = fn.reads.names.filter((name) => !declared.has(name) && !gives.has(name));
	const hidden =
		given.eventFields !== undefined && fn.reads.eventFields.some((field) => !given.eventFields?.includes(field));
	const unset: string[] = [];
	const wrong: FitAnswer["wrong"] = [];
	for (const { name, type } of fn.params) {
		const fromTrigger = gives.get(name);
		const set = Object.hasOwn(values, name) ? values[name] : undefined;
		const gets = fromTrigger ?? (set === undefined ? undefined : valueType(set));
		if (gets === undefined) unset.push(name);
		else if (!(fromTrigger ? fromTrigger === type : takes(type, gets))) wrong.push({ name, wants: type, gets });
	}
	return {
		fits: !hidden && requires.length === 0 && unset.length === 0 && wrong.length === 0,
		hidden,
		requires,
		unset,
		wrong,
	};
}
