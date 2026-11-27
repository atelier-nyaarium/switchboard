// The automation store.

import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { functionReads } from "../../shared/automation-fit.js";
import {
	below,
	callsOf,
	type FlatEntry,
	type FunctionOf,
	pointerOf,
	RUN_FRAMES_MAX,
	type RunFunction,
	reached,
	reachOf,
	visit,
	type WalkStep,
	within,
	written,
} from "../../shared/automation-walk.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { chainedTimer } from "../../shared/chained-timer.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import { commitChecked, type DurableStore, writeChecked } from "../../shared/durable-store.js";
import { errorName } from "../../shared/error-name.js";
import {
	AUTOMATION_ACTIONS,
	AUTOMATION_MESSAGE_MAX,
	AUTOMATIONS_MAX,
	type Automation,
	type AutomationAction,
	type AutomationActionParam,
	type AutomationFunctionRow,
	type AutomationLastRun,
	type AutomationRow,
	AutomationSchema,
	type AutomationTrigger,
	type ConsoleAutomationDeleteResult,
	type ConsoleAutomationPutResult,
	type ConsoleAutomationRunResult,
	type EventTrigger,
	KEEP_TRYING_MIN_DEFAULT,
	type TellWhen,
} from "../../shared/schemasAutomation.js";
import {
	AUTOMATION_ISSUES_MAX,
	type AutomationIssue,
	type AutomationSaveRefusal,
	type ConsoleAutomationCheckResult,
	type ConsoleAutomationSaveResult,
	SAVE_LINE_MAX,
} from "../../shared/schemasAutomationSave.js";
import {
	type AutomationFunction,
	FRAME_VARS_MAX,
	FUNCTIONS_MAX,
	type FunctionParam,
	FunctionSchema,
	type FunctionStep,
	type StepArg,
	unnamed,
	WAIT_MINUTES_MAX,
} from "../../shared/schemasFunction.js";
import { caseTaken } from "../../shared/switch-cases.js";
import { hasHoles, unescapedText, unreadText } from "../../shared/text-holes.js";
import {
	createOwnerRecords,
	type OwnerBatchResult,
	type OwnerIssue,
	type OwnerRecord,
	type OwnerWrite,
	TOTAL_CAP,
} from "../ownerRecords.js";
import { CLOCK_GRACE_MS, clockShown, isClock, nextSlot, walkSlots } from "./automationClock.js";
import {
	admit,
	EFFECTS_MAX,
	type Fire,
	type FireNames,
	FRAME_VAR_BYTES_MAX,
	type Frame,
	finished,
	frameKey,
	intentAt,
	type StepRef,
	sameRun,
	siteIn,
	started,
	stepKey,
	stepsOf,
	switchOf,
	WAITING_EVENTS_MAX,
} from "./automationFires.js";
import { addressIn, catchOf, entered, type FailureCode, stepAt as treeAt } from "./automationFrames.js";
import {
	AUTOMATION_KIND,
	type AutomationIntent,
	type AutomationVerdict,
	type DroppedAutomation,
	FUNCTION_KIND,
	judgeAutomationWrite,
	movesWithHome,
	NOT_HOME,
} from "./automationJudge.js";
import { type HeldLastRun, type RunStamp, settledRuns } from "./automationLastRun.js";
import { COOLING, type Log, type LogRow, logged, loggedFor, lostRow, triggerRow } from "./automationLog.js";
import { clip, type Dropped, memberOf, outboxOf, ownerOf, told } from "./automationOutbox.js";
import { createPass, droppedRows, FRAME_UNREAD, NEWER_SET, STEP_ERRORS, untold } from "./automationPass.js";
import {
	type Attempt,
	type AutomationActionPorts,
	type AutomationEffect,
	isEffect,
	runEffect,
} from "./automationRunner.js";
import { holeScope } from "./automationScope.js";
import type { StepIssueAt } from "./automationScriptOps.js";
import { type Checkpoint, FIRED_MAX, own, restore, type State, storedOf, versionKey } from "./automationState.js";
import { FRESH_STEP, failedAs, isEnded, refusedUnsent, type Step, steered, type Waited } from "./automationSteps.js";
import {
	kept as keptValue,
	NO_TASK,
	taskName,
	tasksIn,
	WAITS_FOREVER,
	waitedOf,
	waitsForever,
} from "./automationTasks.js";
import {
	holeTextsOf,
	isTell,
	laneTells,
	laneTellWhen,
	ownTellPaths,
	STEP_ISSUE_CODE,
	stepPlaceOf,
	type Tell,
} from "./automationText.js";
import {
	CALL_LOOPS,
	createAutomationValidity,
	FUNCTION_GONE,
	FUNCTION_PRIVATE,
	FUNCTION_UNREAD,
	STEP_UNFIT,
} from "./automationValidity.js";
import { createAutomationWords, fieldsOf, type WatchedReading } from "./automationWords.js";
import type { ComputedFields, DerivedField } from "./computedFields.js";
import { crossingField, crossingFieldId } from "./crossingBand.js";
import { type HeardSensor, silenceNotices } from "./sensorSilence.js";

export { FIRES_MAX, WAITING_EVENTS_MAX } from "./automationFires.js";
export { type LogRow, ROW_OUTCOMES } from "./automationLog.js";
export {
	type AutomationOutbox,
	type OutboxEvent,
	QUEUE_MAX_BYTES,
	QUEUE_MAX_EVENTS,
} from "./automationOutbox.js";
export { FRAME_UNREAD, NEWER_SET } from "./automationPass.js";
export { BACKOFF_MAX_MS, BACKOFF_MIN_MS, KEEP_TRYING_MS } from "./automationSteps.js";
export type { WatchedReading } from "./automationWords.js";
export { AUTOMATION_KIND };

export type AutomationWritten =
	| { written: true; records: (OwnerRecord<StoredBody> | null)[]; dropped: readonly DroppedAutomation[] }
	| {
			written: false;
			reason: string;
			refusal: AutomationSaveRefusal;
			record?: OwnerRecord<StoredBody>;
			confirm?: string[];
			issue?: OwnerIssue;
	  };

export type AutomationSaved =
	| { stored: true; automation: OwnerRecord<Automation>; function?: OwnerRecord<AutomationFunction> }
	| { stored: false; refusal: AutomationSaveRefusal; reason: string };

/** A filled effect parameter. */
const EFFECT_TEXT_MAX = 500;
const NO_RUNNER = "this Gateway runs no such action";
export const TOO_MANY_CALLS = "it ran more functions than one run may";

/** One function at one version. */
const functionStamp = (at: { function: string; incarnation: string; revision: number }): string =>
	`${at.function}@${at.incarnation}:${at.revision}`;

/** A body but for `enabled`; none for one not pinned. */
const bodyStamp = (body: Automation | null): string =>
	body
		? createHash("sha256")
				.update(canonicalJson({ ...body, enabled: true }))
				.digest("hex")
				.slice(0, 32)
		: "";
export const SWITCHED_OFF = "it was switched off";
export { STEP_UNFIT };
export const VALUE_UNREAD = "a value it takes could not be read";
export const CONDITION_UNREAD = "its condition could not be read";
export const NOT_TRUE_OR_FALSE = "its condition is not true or false";
export const SUBJECT_UNREAD = "its subject could not be read";
export const VALUE_TOO_LARGE = "its value is too large to keep";
export const WAIT_UNREAD = "its minutes could not be read";
export const THROWN = "it threw";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** JSON within the bound, as it will be stored. */
const keepable = (value: unknown): { value: JsonValue } | null => {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		return null;
	}
	if (json === undefined || Buffer.byteLength(json, "utf8") > FRAME_VAR_BYTES_MAX) return null;
	return { value: JSON.parse(json) as JsonValue };
};

const flatAt = (body: Automation, path: string): FlatEntry | undefined => reached(body).find((at) => at.path === path);

/** Calls included. */
const actionAt = (body: Automation, path: string): AutomationAction | undefined => {
	const at = flatAt(body, path);
	return (
		at &&
		visit<FlatEntry, AutomationAction>(at, { action: ({ action }) => action, unfollowedCall: ({ call }) => call })
	);
};

type Call = RunFunction;
/** A `do` step and the path it runs at. */
interface WrittenDo {
	path: string;
	step: Extract<FunctionStep, { kind: "do" }>;
}

const callAt = (body: Automation, path: string): Call | null => {
	const at = flatAt(body, path);
	return at ? visit<FlatEntry, Call | null>(at, { action: () => null, unfollowedCall: ({ call }) => call }) : null;
};

/** A walk whose write failed is retried after this. */
const CLOCK_RETRY_MS = 30_000;
/** Kept for a move back. */
export const FUNCTION_UNUSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const FUNCTION_KEY_BYTES = 32;
const FunctionKeySchema = z.strictObject({ key: z.string().min(1) });

type StoredBody = Automation | AutomationFunction;

const isAutomationRecord = (record: OwnerRecord<StoredBody>): record is OwnerRecord<Automation> =>
	record.kind === AUTOMATION_KIND;
const isFunctionRecord = (record: OwnerRecord<StoredBody>): record is OwnerRecord<AutomationFunction> =>
	record.kind === FUNCTION_KIND;

/** Holes in a text, checked and filled. */
export interface AutomationHoles {
	issue: (text: string, names: readonly string[]) => { start: number; end: number; message: string } | null;
	/** A bare expression, no braces. */
	expression: (source: string, names: readonly string[]) => { start: number; end: number; message: string } | null;
	/** Never throws. */
	fill: (text: string, names: Readonly<FireNames>) => Promise<{ text: string; failed: number }>;
	/** Null when it fails. */
	evaluate: (source: string, names: Readonly<FireNames>) => Promise<{ value: unknown } | null>;
	shown: (source: string, names: Readonly<FireNames>) => Promise<string | null>;
	entity: (name: string) => boolean;
}

export interface AutomationsDeps {
	records: DurableStore;
	state: DurableStore;
	fields: ComputedFields;
	newIncarnation: () => string;
	now: () => number;
	isHome: () => boolean;
	/** Wake after queue append. */
	onQueued?: () => void;
	/** Why an event trigger cannot run here. */
	eventIssue?: (trigger: EventTrigger) => string | null;
	eventWarning?: (trigger: EventTrigger) => string | null;
	/** A source's declared event fields; null when not held. */
	eventFields?: (source: string) => readonly string[] | null;
	eventChoices?: (source: string, field: string) => readonly string[] | null;
	functionKey?: DurableStore;
	entropy?: (size: number) => Buffer;
	/** An event trigger in words. */
	eventSentence?: (trigger: EventTrigger) => string;
	/** Null when no number is read there. */
	reading?: (device: string, measure: string) => WatchedReading | null;
	/** What runs an action's effect. */
	actions?: AutomationActionPorts;
	/** Undefined until the console is composed. */
	holes?: () => AutomationHoles | undefined;
	/** Without it a clock moves only on `tick`. */
	timers?: Pick<Ambient, "setTimer" | "clearTimer">;
	/** Paired sensors; without it no silence is told. */
	sensorsHeard?: () => readonly HeardSensor[];
	/** Names this Gateway in a silence. */
	gatewayName?: string;
}

export function createAutomations(deps: AutomationsDeps) {
	const restored = restore(deps.state.load(), deps.now());
	let state: State = restored.state;
	/** A restore that dropped fires writes once. */
	let unwritten = restored.changed;
	/** Silence counts from here. */
	const startedAt = deps.now();
	const {
		triggerIssue,
		givenOf,
		choicesOf,
		functionIssue,
		stepIssuesOf,
		assessBody,
		automationIssue,
		issuesOf,
		writeIssue,
		actionStops,
		stepStops,
		entryIssue,
		calledEntryIssue,
		resolved,
		resolvedCall,
		armed,
	} = createAutomationValidity(
		deps,
		(id) => functionOf(id),
		(id) => store.unreadOf(id, FUNCTION_KIND),
		(id) => pointingAt(id),
	);
	const { sentenceOf, watched, namesOf, crossingNames } = createAutomationWords(deps);

	const store = createOwnerRecords<StoredBody>({
		store: deps.records,
		kinds: { [AUTOMATION_KIND]: AutomationSchema, [FUNCTION_KIND]: FunctionSchema },
		max: AUTOMATIONS_MAX + FUNCTIONS_MAX,
		maxByKind: { [AUTOMATION_KIND]: AUTOMATIONS_MAX, [FUNCTION_KIND]: FUNCTIONS_MAX },
		newIncarnation: deps.newIncarnation,
		refusal: (candidate, others) => {
			if (isFunctionRecord(candidate)) return functionIssue(candidate.body);
			if (!isAutomationRecord(candidate)) return null;
			// Includes the write's own functions.
			const functions = (id: string) => {
				const row = others.find((other) => other.id === id);
				return row && isFunctionRecord(row) ? row.body : null;
			};
			return writeIssue(candidate.body, functions);
		},
		label: "automations",
	});
	const records = {
		list: (): OwnerRecord<Automation>[] => store.list().filter(isAutomationRecord),
		get: (id: string): OwnerRecord<Automation> | null => {
			const record = store.get(id);
			return record && isAutomationRecord(record) ? record : null;
		},
		/** Read every time, its function's steps and fit included. */
		invalidOf: (id: string): string | null => {
			const record = store.get(id);
			return record && isAutomationRecord(record) ? automationIssue(record.body) : store.invalidOf(id);
		},
	};

	/** Read or minted at open; null when held but unreadable, never overwritten. */
	const functionKey: Buffer | null = (() => {
		const keys = deps.functionKey;
		if (!keys) return null;
		const raw = keys.load();
		const held = FunctionKeySchema.safeParse(raw);
		if (held.success) return Buffer.from(held.data.key, "base64");
		if (raw !== null || keys.exists()) {
			console.warn("[automations] the function key cannot be read; copies and carries are refused");
			return null;
		}
		if (!deps.entropy) return null;
		const key = deps.entropy(FUNCTION_KEY_BYTES);
		return writeChecked(keys, { key: key.toString("base64") }, "function key").landed ? key : null;
	})();

	/** Same inputs, same row; unguessable; null without a key. */
	const derivedFunctionId = (purpose: "copy" | "carry", automationId: string, from: string): string | null => {
		if (!functionKey) return null;
		const digest = createHmac("sha256", functionKey).update(`${purpose}\0${automationId}\0${from}`).digest("hex");
		return `fn-${digest.slice(0, 16)}`;
	};

	const functionOf = (id: string): AutomationFunction | null => {
		const record = store.get(id);
		return record && isFunctionRecord(record) ? record.body : null;
	};

	/** Held fires' versions; unmatched drop. */
	const pinned = (next: State): State["versions"] =>
		Object.fromEntries(
			next.fires.flatMap((fire) => {
				const key = versionKey(fire);
				const record = records.get(fire.automation);
				const current =
					record?.incarnation === fire.incarnation && record.revision === fire.revision
						? record.body
						: undefined;
				const held = own(next.versions, key) ?? current;
				return held ? [[key, held]] : [];
			}),
		);

	/** Live while revision holds. */
	const liveFunction = (frame: Frame): AutomationFunction | undefined => {
		const record = store.get(frame.function);
		return record &&
			isFunctionRecord(record) &&
			record.incarnation === frame.incarnation &&
			record.revision === frame.revision
			? record.body
			: undefined;
	};

	/** Unmatched drop. */
	const pinnedFunctions = (next: State): State["functionVersions"] =>
		Object.fromEntries(
			next.fires.flatMap((fire) =>
				Object.values(fire.frames ?? {}).flatMap((frame) => {
					const key = frameKey(frame);
					const held = own(next.functionVersions, key) ?? liveFunction(frame);
					return held ? [[key, held]] : [];
				}),
			),
		);

	/** The one writer of the versions. */
	/** Drops clocks, sets and rows of gone records. */
	const pruned = (next: State): Pick<State, "firedAt" | "landedSets" | "log" | "lastRuns" | "order"> => ({
		order: {
			next: next.order.next,
			members: Object.fromEntries(
				next.fires.flatMap((fire) => {
					const place = own(next.order.members, fire.member);
					return place === undefined ? [] : [[fire.member, place]];
				}),
			),
		},
		log: loggedFor(next.log, new Set(records.list().map((record) => record.id))),
		lastRuns: settledRuns(
			Object.fromEntries(Object.entries(next.lastRuns).filter(([id, held]) => lastRunStands(id, held))),
			new Set(next.fires.map((fire) => fire.member)),
		),
		firedAt: Object.fromEntries(
			Object.entries(next.firedAt).filter(([id, held]) => records.get(id)?.incarnation === held.incarnation),
		),
		landedSets: Object.fromEntries(
			Object.entries(next.landedSets).filter(([device]) => (deps.actions?.switchName(device) ?? null) !== null),
		),
	});

	const commit = (next: State): boolean => {
		const landing = { ...next, versions: pinned(next), functionVersions: pinnedFunctions(next), ...pruned(next) };
		return commitChecked(
			deps.state,
			landing,
			(landed) => {
				state = landed;
			},
			{ label: "automation state", snapshot: storedOf(landing) },
		).landed;
	};

	{
		const versions = pinned(state);
		const functionVersions = pinnedFunctions(state);
		if (
			canonicalJson(versions) !== canonicalJson(state.versions) ||
			canonicalJson(functionVersions) !== canonicalJson(state.functionVersions)
		)
			unwritten = true;
		state = { ...state, versions, functionVersions };
	}

	/** The body a fire fired with. */
	const bodyOf = (fire: Fire): Automation | null => own(state.versions, versionKey(fire)) ?? null;

	/** Still what its automation runs: the same body but for `enabled`, each function it entered unchanged. */
	const lastRunStands = (id: string, held: HeldLastRun): boolean => {
		const record = records.get(id);
		if (!record || record.incarnation !== held.incarnation || bodyStamp(record.body) !== held.stamp.body)
			return false;
		return held.stamp.functions.every((stamped) => {
			const fn = stamped.slice(0, stamped.indexOf("@"));
			const live = store.get(fn);
			return live !== null && functionStamp({ function: fn, ...live }) === stamped;
		});
	};

	const frameFunction = (frame: Frame): AutomationFunction | null =>
		own(state.functionVersions, frameKey(frame)) ?? liveFunction(frame) ?? null;

	/** The `do` step written at a frame's path, in the body its frame pinned. */
	const writtenStep = (fire: Fire, path: string): WrittenDo | null => {
		const step = treeStep(fire, path);
		return step?.kind === "do" ? { path, step } : null;
	};

	/** Its automation's own tell, as written. */
	const ownTell = (fire: Fire, path: string): Tell | null => {
		const body = bodyOf(fire);
		const action = body && siteIn(fire, path) === null ? actionAt(body, path) : undefined;
		return action && isTell(action) ? action : null;
	};

	/** As read, else as fired; null while a tell's holes are unread. */
	const actionOf = (fire: Fire, path: string): AutomationAction | null => {
		const site = siteIn(fire, path);
		if (site !== null) return fire.frames?.[site]?.resolved?.[path] ?? null;
		const read = fire.resolved?.[path];
		if (read) return read;
		const body = bodyOf(fire);
		const action = (body && actionAt(body, path)) ?? null;
		if (!action || !isTell(action) || action.message === undefined) return action;
		return hasHoles(action.message) ? null : { ...action, message: unescapedText(action.message) };
	};

	const unreadAt = (fire: Fire, path: string): boolean => {
		if (siteIn(fire, path) === null) return ownTell(fire, path) !== null;
		const kind = treeStep(fire, path)?.kind;
		return kind === "do" || kind === "call";
	};

	const noteAt = (fire: Fire, path: string): string | null => {
		const held = writtenStep(fire, path)?.step.args.message;
		const written =
			siteIn(fire, path) === null ? ownTell(fire, path)?.message : held?.kind === "literal" && held.value;
		return typeof written === "string" && hasHoles(written) ? written : null;
	};

	/** A frame's leading tell the lane told when the fire was recorded, still one in the body it entered. */
	const laneTold = (fire: Fire, path: string): boolean => {
		const body = bodyOf(fire);
		if (!body || !fire.lane?.includes(path) || siteIn(fire, path) === null) return false;
		const pinned = (id: string): AutomationFunction | null => {
			const frame = Object.values(fire.frames ?? {}).find((held) => held.function === id);
			return (frame && frameFunction(frame)) ?? null;
		};
		return laneTells(body, pinned).some((tell) => tell.path === path);
	};

	const stepAt = (fire: Fire, path: string): AutomationEffect | null => {
		const action = actionOf(fire, path);
		return action && isEffect(action) ? action : null;
	};

	/** The written step at a frame's path, of any kind. */
	function treeStep(fire: Fire, path: string): FunctionStep | null {
		const site = siteIn(fire, path);
		const tree = site === null ? null : frameBody(fire, site);
		const address = tree && site !== null ? addressIn(tree, below(path, site)) : null;
		return tree && address ? treeAt(tree, address) : null;
	}

	/** For a step's row: its action, else its own kind. */
	const kindAt = (fire: Fire, path: string): string | undefined =>
		actionOf(fire, path)?.kind ??
		ownTell(fire, path)?.kind ??
		writtenStep(fire, path)?.step.action ??
		treeStep(fire, path)?.kind;

	/** Inside an event trigger's cool-down, from its last admission. */
	const coolingAt = (
		firedAt: State["firedAt"],
		record: Pick<OwnerRecord<Automation>, "id" | "incarnation">,
		now: number,
		coolDownSec: number,
	): boolean => {
		const held = own(firedAt, record.id);
		return held?.incarnation === record.incarnation && now - held.at < coolDownSec * 1000;
	};

	/** Its automation's window, else default. */
	const windowOf = (fire: Fire): number => (bodyOf(fire)?.keepTryingMin ?? KEEP_TRYING_MIN_DEFAULT) * 60_000;

	/** Baselines whose write has not landed. */
	let unsaved: State["automations"] = {};

	/** What one pass will commit. */
	interface Work {
		log: Log;
		fires: Fire[];
		firedAt: State["firedAt"];
		order: State["order"];
	}

	const workOf = (): Work => ({
		log: state.log,
		fires: [...state.fires],
		firedAt: state.firedAt,
		order: state.order,
	});

	/** `notes`: owner texts, holes unfilled. */
	const withMessage = (
		fields: Record<string, string>,
		messages: readonly string[],
		notes: readonly string[] = [],
	): Record<string, string> => {
		if (messages.length === 0) return fields;
		const told: Record<string, string> = { ...fields, message: clip(messages.join("\n")) };
		if (notes.length > 0) told.note = clip(notes.join("\n"));
		return told;
	};

	/** The paths the lane tells itself, as its functions stand now. */
	const laneOf = (body: Automation): string[] => laneTells(body, functionOf).map((tell) => tell.path);

	/** A record per action, less the tells the lane tells itself. */
	const runSteps = (body: Automation, lane: readonly string[] = laneOf(body)): Fire["steps"] =>
		Object.fromEntries(Object.entries(stepsOf(body)).filter(([path]) => !lane.includes(path)));

	/** Its own tells alone, a light run; null when it holds none. */
	const tellsOnly = (fire: Fire, body: Automation | null): Fire | null => {
		// skew:fire-tell: goes with the fire's `tell`.
		if (fire.tell) return { ...fire, steps: {}, active: [] };
		const own = body ? ownTellPaths(body) : new Set<string>();
		const kept = Object.entries(fire.steps).filter(([path]) => own.has(path));
		if (kept.length === 0) return null;
		const { frames: _frames, ...rest } = fire;
		return { ...rest, steps: Object.fromEntries(kept), active: [], light: true };
	};

	/** Current trigger names; throws what a put would. */
	const namesNow = (trigger: Exclude<AutomationTrigger, EventTrigger>): FireNames => {
		const issue = triggerIssue({ trigger });
		if (issue !== null) throw new Error(issue);
		if (isClock(trigger)) {
			const now = deps.now();
			return { time: { value: now, shown: clockShown(trigger, now) } };
		}
		if (trigger.kind === "crossing") return crossingNames(trigger);
		const label = deps.fields.get(trigger.field)?.body.label ?? trigger.field;
		const held = deps.fields.value(trigger.field);
		return { value: { value: held.known ? held.value : null }, field: { value: label } };
	};

	/** Records a fire for the run; false when nothing will run. */
	const fire = (
		work: Work,
		record: OwnerRecord<Automation>,
		at: { member: string; seq: number; at: number },
		names: FireNames,
		fields: Record<string, string>,
		/** By hand: no cool-down, replaces nothing. */
		manual = false,
	): boolean => {
		const fired = { automation: record.id, seq: at.seq, at: at.at };
		const { trigger } = record.body;
		// A crossing's or a value's is its checkpoint's.
		const cool = trigger.kind === "event" && !manual ? (trigger.coolDownSec ?? 0) : 0;
		if (cool > 0 && coolingAt(work.firedAt, record, at.at, cool)) {
			work.log = logged(work.log, lostRow(fired, COOLING));
			return false;
		}
		const cooled = (): void => {
			if (cool > 0)
				work.firedAt = { ...work.firedAt, [record.id]: { incarnation: record.incarnation, at: at.at } };
		};
		const told = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, clip(value)]));
		const lane = laneOf(record.body);
		const steps = runSteps(record.body, lane);
		if (Object.keys(steps).length === 0) {
			// The lane tells it.
			cooled();
			return false;
		}
		const own = ownTellPaths(record.body);
		const light = Object.keys(steps).every((path) => own.has(path));
		const recorded: Fire = {
			...fired,
			member: at.member,
			incarnation: record.incarnation,
			revision: record.revision,
			names,
			steps,
			active: [],
			fields: told,
			...(light ? { light: true as const } : {}),
			...(lane.length > 0 ? { lane } : {}),
		};
		const event = trigger.kind === "event";
		const verdict = admit(work.fires, recorded, {
			// Each event carries its own.
			supersede: !light && !event && !manual,
			earlier: (member) => state.fires.some((stored) => stored.member === member),
			...(event ? { waitingMax: WAITING_EVENTS_MAX } : {}),
			tells: (held) => tellsOnly(held, held === recorded ? record.body : bodyOf(held)),
		});
		work.fires = verdict.fires;
		for (const row of verdict.rows) work.log = logged(work.log, lostRow(row.fire, row.reason));
		if (verdict.admitted) {
			cooled();
			const place = work.order.next;
			work.order = { next: place + 1, members: { ...work.order.members, [at.member]: place } };
		}
		return verdict.admitted;
	};

	/** Replays transitions idempotently. */
	function drain(): boolean {
		const now = deps.now();
		const work = workOf();
		const checkpoints: State["automations"] = {};
		const baselines: State["automations"] = {};
		for (const record of records.list()) {
			// The lane runs event triggers.
			const trigger = watched(record);
			if (!trigger || !armed(record)) continue;
			const { field, becomes } = trigger;
			const saved = own(state.automations, record.id);
			const held = unsaved[record.id];
			const was = held?.revision === record.revision && saved?.revision !== record.revision ? held : saved;
			if (held && was === held) baselines[record.id] = held;
			const current = deps.fields.stateOf(field);
			if (!current) {
				if (was) checkpoints[record.id] = was;
				continue;
			}
			const carried =
				was?.incarnation === record.incarnation && was.firedAt !== undefined ? { firedAt: was.firedAt } : {};
			if (!was || was.revision !== record.revision || was.incarnation !== record.incarnation) {
				// Record changes reset baseline.
				const baseline = {
					revision: record.revision,
					incarnation: record.incarnation,
					fieldEpoch: current.epoch,
					handledSeq: current.seq,
					...carried,
				};
				checkpoints[record.id] = baseline;
				baselines[record.id] = baseline;
				continue;
			}
			// Epoch changes reset sequence.
			let at: Checkpoint =
				was.fieldEpoch === current.epoch
					? was
					: {
							revision: record.revision,
							incarnation: record.incarnation,
							fieldEpoch: current.epoch,
							handledSeq: 0,
							...carried,
						};
			const pending = current.changes.filter((row) => row.seq > at.handledSeq);
			const oldest = pending[0]?.seq ?? current.seq + 1;
			if (current.seq > at.handledSeq && oldest > at.handledSeq + 1) {
				const missed = oldest - at.handledSeq - 1;
				const gap = { automation: record.id, seq: oldest - 1, at: now };
				work.log = logged(work.log, triggerRow(gap, "uncertain", `missed ${missed} changes`));
				at = { ...at, handledSeq: oldest - 1 };
			}
			for (const row of pending) {
				const crossed = row.value === becomes && row.previous !== becomes;
				const handled = { ...at, handledSeq: row.seq };
				const seen = { automation: record.id, seq: row.seq, at: row.at };
				if (!crossed) {
					at = handled;
					continue;
				}
				if (at.firedAt !== undefined && row.at - at.firedAt < trigger.coolDownSec * 1000) {
					work.log = logged(work.log, triggerRow(seen, "suppressed", "cooling down"));
					at = handled;
					continue;
				}
				const member = memberOf(record.id, record.incarnation, current.epoch, row.seq);
				const names = namesOf(record, row.value, trigger.label);
				const fields = { field: trigger.label, value: names.value?.shown ?? String(row.value) };
				const fired = fire(work, record, { member, seq: row.seq, at: row.at }, names, fields);
				at = fired ? { ...handled, firedAt: row.at } : handled;
			}
			checkpoints[record.id] = at;
		}
		const next: State = {
			...state,
			automations: checkpoints,
			log: work.log,
			fires: work.fires,
			firedAt: work.firedAt,
			order: work.order,
		};
		if (canonicalJson(next) === canonicalJson(state)) {
			pump();
			return true;
		}
		const landed = commit(next);
		unsaved = landed ? {} : baselines;
		pump();
		return landed;
	}

	let clock: { handle: () => TimerHandle } | null = null;
	let stopped = false;

	/** Arms the next slot; retries an unlanded walk. */
	const rearm = (now: number, landed = true): void => {
		if (clock) deps.timers?.clearTimer(clock.handle());
		clock = null;
		if (!deps.timers || stopped) return;
		const nexts = records.list().flatMap((record) => {
			const { trigger } = record.body;
			if (!isClock(trigger) || !armed(record)) return [];
			const next = nextSlot(trigger, own(state.slots, record.id)?.at ?? now);
			return next === null ? [] : [next];
		});
		if (nexts.length === 0) return;
		const wait = landed ? Math.max(0, Math.min(...nexts) - now) : CLOCK_RETRY_MS;
		clock = chainedTimer(deps.timers, wait, () => {
			clock = null;
			tick();
		});
	};

	/** Fires due slots; a late one is counted only. */
	function tick(): boolean {
		if (stopped) return true;
		const now = deps.now();
		const work = workOf();
		const slots: State["slots"] = {};
		for (const record of records.list()) {
			const { trigger } = record.body;
			if (!isClock(trigger) || !armed(record)) continue;
			const held = own(state.slots, record.id);
			if (!held || held.revision !== record.revision || held.incarnation !== record.incarnation) {
				// A saved clock starts from now.
				slots[record.id] = { revision: record.revision, incarnation: record.incarnation, at: now };
				continue;
			}
			if (held.at > now + CLOCK_GRACE_MS) {
				// Stepped back: restart from now.
				slots[record.id] = { ...held, at: now, skip: Math.max(held.at, held.skip ?? held.at) };
				continue;
			}
			const walk = walkSlots(trigger, held.at, now, held.skip);
			for (const next of walk.due) {
				const member = memberOf(record.id, record.incarnation, "slot", next);
				const shown = clockShown(trigger, next);
				fire(work, record, { member, seq: 0, at: next }, { time: { value: next, shown } }, { time: shown });
			}
			if (walk.missed > 0) {
				const gap = { automation: record.id, seq: 0, at: now };
				const reason = `missed ${walk.missed} slot${walk.missed === 1 ? "" : "s"}`;
				work.log = logged(work.log, triggerRow(gap, "uncertain", reason));
			}
			const { skip, ...kept } = held;
			if (walk.skipped && skip !== undefined) {
				const before = { automation: record.id, seq: 0, at: skip };
				work.log = logged(work.log, triggerRow(before, "suppressed", "it ran before the clock stepped back"));
			}
			slots[record.id] = { ...kept, at: walk.at, ...(skip !== undefined && walk.at < skip ? { skip } : {}) };
		}
		const next: State = {
			...state,
			slots,
			log: work.log,
			fires: work.fires,
			firedAt: work.firedAt,
			order: work.order,
		};
		const landed = canonicalJson(next) === canonicalJson(state) || commit(next);
		pump();
		rearm(now, landed);
		return landed;
	}

	const running = new Map<string, { done: Promise<void>; device?: string }>();
	const runningDone = (): Promise<void>[] => [...running.values()].map((held) => held.done);
	/** Read in flight. */
	let reading: Promise<void> | null = null;
	/** Answers kept until written. */
	const spent = new Map<string, { ref: StepRef; rows: LogRow[]; attempt: Attempt; reason?: string }>();
	/** Judged each pass until committed. */
	let recovering = true;

	const isRunning = (ref: StepRef): boolean => running.has(stepKey(ref));

	/** Why a fire stops; started ones finish pinned. */
	const retireOf = (fire: Fire): LogRow | null => {
		const record = records.get(fire.automation);
		if (!record || record.incarnation !== fire.incarnation)
			return triggerRow(fire, "uncertain", "the automation is gone");
		if (!record.body.enabled) return triggerRow(fire, "suppressed", SWITCHED_OFF);
		if (!bodyOf(fire)) return triggerRow(fire, "suppressed", "the automation changed");
		if (started(fire)) return null;
		if (record.revision !== fire.revision) return triggerRow(fire, "suppressed", "the automation changed");
		// Entry judges its function.
		const issue = automationIssue(record.body, null);
		return issue === null ? null : triggerRow(fire, "refused", issue);
	};

	/** How many held automations point at a function. */
	const pointingAt = (id: string): number =>
		records.list().filter((record) => pointerOf(record.body)?.function === id).length;

	/** Opens the frame on its first step; the call's record stays. */
	const enter = (
		fire: Fire,
		path: string,
		call: Call,
	): { fire: Fire; first: string } | { refused: string; code?: FailureCode } => {
		const above = Object.entries(fire.frames ?? {}).filter(([site]) => path.startsWith(`${site}.`));
		// An edit can close a loop.
		if (above.some(([, held]) => held.function === call.function)) return { refused: CALL_LOOPS, code: "loop" };
		if (Object.keys(fire.frames ?? {}).length >= RUN_FRAMES_MAX) return { refused: TOO_MANY_CALLS, code: "loop" };
		const record = store.get(call.function);
		if (!record || !isFunctionRecord(record))
			return { refused: store.unreadOf(call.function, FUNCTION_KIND) ? FUNCTION_UNREAD : FUNCTION_GONE };
		const frame: Frame = {
			function: record.id,
			incarnation: record.incarnation,
			revision: record.revision,
			...(call.values ? { values: call.values } : {}),
		};
		// One automation's own steps: never called, never shared.
		if (unnamed(record.body) && (above.length > 0 || pointingAt(record.id) > 1))
			return { refused: FUNCTION_PRIVATE };
		const body = bodyOf(fire) as Automation;
		const unsound =
			above.length > 0
				? calledEntryIssue(body, record.id, record.body, call.values ?? {})
				: entryIssue(body, record.id, record.body);
		// Issue lines contain values.
		if (unsound !== null) return { refused: STEP_ERRORS, code: "unread" };
		const first = entered(written(record.body));
		if (!("to" in first)) return { refused: FRAME_UNREAD };
		const to = within(path, first.to);
		const opened = {
			...fire,
			steps: { ...fire.steps, [to]: FRESH_STEP },
			frames: { ...fire.frames, [path]: frame },
		};
		return { fire: opened, first: to };
	};

	/** The steps a frame runs. */
	const frameBody = (fire: Fire, site: string): readonly FunctionStep[] | null => {
		const frame = fire.frames?.[site];
		const fn = frame ? frameFunction(frame) : null;
		return fn ? written(fn) : null;
	};

	/** What a run ran: its body but for `enabled`, each function it entered at its version. */
	const stampOf = (fire: Fire): RunStamp => ({
		body: bodyStamp(bodyOf(fire)),
		functions: [...new Set(Object.values(fire.frames ?? {}).map(functionStamp))].sort(),
	});

	/** Pinned fire bodies. */
	const errorIn = (fire: Fire, path: string): boolean => {
		const body = bodyOf(fire);
		if (!body) return false;
		const site = siteIn(fire, path);
		if (site === null) {
			const action = actionAt(body, path);
			return action !== undefined && action.kind !== "run_function" && actionStops(body, action);
		}
		const frame = fire.frames?.[site];
		const fn = frame ? frameFunction(frame) : null;
		const tree = fn ? written(fn) : null;
		const address = tree ? addressIn(tree, below(path, site)) : null;
		const step = tree && address ? treeAt(tree, address) : null;
		return fn !== null && step !== null && address !== null && stepStops(fn, step, address);
	};

	const automationPass = createPass({
		retireOf,
		stampOf,
		enter,
		frameBody,
		bodyOf,
		actionOf,
		stepAt,
		kindAt,
		unreadAt,
		noteAt,
		laneTold,
		errorAt: errorIn,
		windowOf,
		callAt,
		ready: (action) => deps.actions?.ready(action as AutomationEffect) ?? true,
		sentenceOf,
		withMessage,
	});

	/** Unused a week, then removed. */
	function sweepFunctions(): void {
		if (stopped) return;
		const now = deps.now();
		const all = store.list();
		const used = new Set(all.filter(isAutomationRecord).flatMap((record) => [...reachOf(record.body, functionOf)]));
		const since: State["unusedFunctions"] = {};
		const due: string[] = [];
		for (const record of all.filter(isFunctionRecord)) {
			if (used.has(record.id)) continue;
			const at = Math.min(own(state.unusedFunctions, record.id) ?? now, now);
			if (now - at >= FUNCTION_UNUSED_KEEP_MS) due.push(record.id);
			else since[record.id] = at;
		}
		if (due.length > 0 && !write({ kind: "sweep", ids: due }).written) {
			for (const id of due) since[id] = own(state.unusedFunctions, id) ?? now;
		}
		if (canonicalJson(since) !== canonicalJson(state.unusedFunctions)) commit({ ...state, unusedFunctions: since });
	}

	/** A notice with no room waits. */
	function watchSensors(): boolean {
		// Home only.
		if (stopped || !deps.sensorsHeard || !deps.isHome()) return true;
		const now = deps.now();
		const gateway = deps.gatewayName ?? "This Gateway";
		const found = silenceNotices(state.silences, deps.sensorsHeard(), now, gateway, startedAt);
		let { queue, log } = state;
		let silences = found.held;
		const dropped: Dropped = new Map();
		for (const notice of found.notices) {
			const room = told(
				queue,
				{ member: notice.member, when: notice.when, fields: notice.fields },
				notice.sentence,
				now,
			);
			if (!room) continue;
			queue = room.queue;
			silences = notice.settle(silences);
			for (const [owner, count] of room.dropped) dropped.set(owner, (dropped.get(owner) ?? 0) + count);
		}
		log = droppedRows(log, dropped, now, null);
		const next: State = { ...state, queue, log, silences };
		if (canonicalJson(next) === canonicalJson(state)) return true;
		const queued = next.queue.lastAt !== state.queue.lastAt;
		const landed = commit(next);
		if (landed && queued) deps.onQueued?.();
		return landed;
	}

	/** Lands outcomes and queues tells with the next claim. */
	function pump(): void {
		if (stopped) return;
		const now = deps.now();
		const home = deps.isHome();
		const {
			next,
			effects,
			read: toRead,
			queued,
		} = automationPass.pass({
			state,
			now,
			home,
			recover: recovering,
			answers: spent,
			inFlight: isRunning,
			busy: {
				free: Math.max(0, EFFECTS_MAX - running.size),
				devices: new Set(
					[...running.values()].flatMap((held) => (held.device === undefined ? [] : [held.device])),
				),
				read: reading !== null,
			},
		});
		// An unlanded pass is retried whole, its claim with it.
		if ((unwritten || canonicalJson(next) !== canonicalJson(state)) && !commit(next)) return;
		recovering = false;
		unwritten = false;
		for (const [key, { ref }] of [...spent]) {
			const claimed = state.fires.some((held) => held.member === ref.member && held.steps[ref.path]?.claimed);
			if (!claimed) spent.delete(key);
		}
		// Register claims before answers.
		for (const effect of effects) startEffect(effect);
		if (toRead) startRead(toRead);
		if (queued) deps.onQueued?.();
	}

	/** A held fire and the body it fired with. */
	const heldWork = (member: string) => {
		const fire = state.fires.find((held) => held.member === member);
		const body = fire && bodyOf(fire);
		return fire && body ? { fire, body } : null;
	};

	/** `thrown`: whether a throw pumps again. */
	const launch = (work: () => Promise<boolean>, end: () => void, thrown: boolean): Promise<void> =>
		Promise.resolve()
			.then(work)
			.catch((error) => {
				console.error(`[automations] a run failed: ${errorName(error)}`);
				return thrown;
			})
			.then((moved) => {
				end();
				if (moved) pump();
			});

	function startEffect(ref: StepRef): void {
		const held = heldWork(ref.member);
		if (!held) return;
		const done = launch(
			() =>
				runOne(held.fire, ref).catch((error) => {
					// `runEffect` keeps port throws, so this one came before sending.
					console.error(`[automations] a run failed: ${errorName(error)}`);
					spent.set(stepKey(ref), { ref, rows: [], attempt: { hold: "it could not be started" } });
					return true;
				}),
			() => {
				running.delete(stepKey(ref));
			},
			true,
		);
		const device = switchOf(stepAt(held.fire, ref.path))?.device;
		running.set(stepKey(ref), { done, ...(device === undefined ? {} : { device }) });
	}

	function startRead(ref: StepRef): void {
		const held = heldWork(ref.member);
		if (!held) return;
		const before = canonicalJson(held.fire);
		reading = launch(
			async () => {
				const moved = await readStep(held.fire, ref);
				const after = state.fires.find((fire) => fire.member === ref.member);
				// Unchanged read must not repump.
				return moved && (after === undefined || canonicalJson(after) !== before);
			},
			() => {
				reading = null;
			},
			false,
		);
	}

	const patched = (member: string, patch: Partial<Fire>): Fire[] =>
		state.fires.map((held) => (held.member === member ? { ...held, ...patch } : held));

	/** Call values over names, then the frame's variables and a catch's `e`. */
	const scopeOf = (fire: Fire, at: Pick<WalkStep, "path">): FireNames => {
		const body = bodyOf(fire);
		const site = siteIn(fire, at.path);
		const frame = site === null ? undefined : fire.frames?.[site];
		const fn = frame ? frameFunction(frame) : null;
		// skew:frame-values: a frame stored before it held its values reads its pointer's.
		const pointed = body && site !== null && frame?.values === undefined ? callAt(body, site)?.values : undefined;
		const scope = holeScope(fire.names, fn?.params ?? [], frame?.values ?? pointed, deps.actions?.switchName);
		if (!frame || !fn || site === null) return scope;
		const vars = Object.fromEntries(
			Object.entries(frame.vars ?? {}).map(([name, value]) => [name, taskName(value, fire.steps)]),
		);
		const address = addressIn(written(fn), below(at.path, site));
		const by = address ? catchOf(address) : null;
		const caught = by ? frame.caught?.[within(site, by)] : undefined;
		return { ...scope, ...vars, ...(caught ? { e: { value: caught, shown: caught.message } } : {}) };
	};

	/** A condition, a value, the minutes or a thrown text, read once at its turn. */
	/** True pumps again: its run is over. */
	const unwanted = (rows: LogRow[], log: Log, current: Fire | undefined, step: Step | undefined): boolean => {
		const landed = rows.length > 0 && commit({ ...state, log });
		return landed || !current || (step !== undefined && isEnded(step));
	};

	async function readSteering(
		fire: Fire,
		ref: StepRef,
		site: string,
		written: Exclude<FunctionStep, { kind: "do" }>,
	): Promise<boolean> {
		const rows: LogRow[] = [];
		const names = scopeOf(fire, ref);
		const argValue = async (arg: StepArg) => {
			if (arg.kind === "expression") return evaluated(arg.text, names);
			return { value: arg.value as unknown };
		};
		const fail = (code: FailureCode, message: string, reason = message) => ({
			step: (held: Step) => failedAs(held, code, message),
			reason,
		});
		let outcome: { step: (held: Step) => Step; reason?: string; vars?: Record<string, JsonValue> };
		let awaits: Waited | null = null;
		switch (written.kind) {
			case "if": {
				const read = await evaluated(written.when, names);
				if (read === null) outcome = fail("unread", CONDITION_UNREAD);
				else if (typeof read.value !== "boolean") outcome = fail("unread", NOT_TRUE_OR_FALSE);
				else outcome = { step: (held) => steered(held, read.value ? "then" : "else") };
				break;
			}
			case "switch": {
				const shown = await shownOf(written.subject, names);
				const trigger = bodyOf(fire)?.trigger;
				const choices = trigger ? choicesOf(trigger, written.subject) : null;
				if (shown === null) outcome = fail("unread", SUBJECT_UNREAD);
				else outcome = { step: (held) => steered(held, caseTaken(written.cases, shown, choices)) };
				break;
			}
			case "let": {
				const read = await argValue(written.value);
				// Kept by name, never by standing.
				const kept = read === null ? null : keepable(keptValue(read.value));
				if (read === null) outcome = fail("unread", VALUE_UNREAD);
				else if (kept === null) outcome = fail("refused", VALUE_TOO_LARGE);
				else outcome = { step: (held) => steered(held), vars: { [written.name]: kept.value } };
				break;
			}
			case "wait": {
				const minutes = (await argValue(written.minutes))?.value;
				if (typeof minutes !== "number" || !(minutes >= 0 && minutes <= WAIT_MINUTES_MAX)) {
					outcome = fail("unread", WAIT_UNREAD);
				} else {
					const until = deps.now() + Math.round(minutes * 60_000);
					outcome = { step: (held) => ({ ...held, until }) };
				}
				break;
			}
			case "throw": {
				const said =
					written.text === undefined ? THROWN : await fillerOf(fire, ref.path, rows, names)(written.text);
				outcome = fail("thrown", said, THROWN);
				break;
			}
			case "await": {
				const read = await evaluated(written.task, names);
				const asked = read === null ? null : waitedOf(read.value);
				if (read === null) outcome = fail("unread", VALUE_UNREAD);
				else if (!asked) outcome = fail("unread", NO_TASK);
				else {
					awaits = asked;
					outcome = { step: (held) => ({ ...held, awaits: asked }) };
				}
				break;
			}
			default:
				return false;
		}
		const log = rows.reduce(logged, state.log);
		const current = state.fires.find((held) => sameRun(held, fire));
		const step = current?.steps[ref.path];
		const frame = current?.frames?.[site];
		if (!current || !step || isEnded(step) || step.until !== undefined || step.awaits !== undefined || !frame) {
			return unwanted(rows, log, current, step);
		}
		if (awaits) {
			const tasks = tasksIn(awaits);
			const known = tasks.every(
				(task) => current.steps[task] !== undefined && treeStep(current, task)?.kind === "start",
			);
			if (!known) outcome = fail("unread", NO_TASK);
			else if (waitsForever(ref.path, awaits, current.steps)) outcome = fail("refused", WAITS_FOREVER);
		}
		const overfull =
			outcome.vars !== undefined && Object.keys({ ...frame.vars, ...outcome.vars }).length > FRAME_VARS_MAX;
		if (overfull) outcome = fail("refused", VALUE_TOO_LARGE);
		const next = outcome.step(step);
		const vars = outcome.vars ? { vars: { ...frame.vars, ...outcome.vars } } : {};
		const fires = patched(ref.member, {
			steps: { ...current.steps, [ref.path]: next },
			frames: { ...current.frames, [site]: { ...frame, ...vars } },
		});
		const failed =
			outcome.reason === undefined ? [] : [automationPass.endedRow(current, ref.path, next, outcome.reason)];
		return commit({ ...state, fires, log: failed.reduce(logged, log) });
	}

	/** Another fire set this switch since; a toggle never outdates a toggle. */
	const outdated = (fire: Fire, path: string, action: AutomationAction): boolean => {
		const target = isEffect(action) ? switchOf(action) : null;
		const newer = target ? own(state.landedSets, target.device) : undefined;
		return (
			newer !== undefined &&
			newer.member !== fire.member &&
			newer.at > intentAt(fire, path, (at) => automationPass.rootOf(fire, at)) &&
			!(newer.nature === "nudges" && target?.nature === "nudges")
		);
	};

	/** Read in the caller's scope. */
	async function calledOf(
		fire: Fire,
		path: string,
		step: Extract<FunctionStep, { kind: "call" }>,
	): Promise<{ action: AutomationAction } | { refused: string }> {
		const names = scopeOf(fire, { path });
		const values: Record<string, unknown> = {};
		for (const [name, arg] of Object.entries(step.values ?? {})) {
			if (arg.kind !== "expression") {
				values[name] = arg.value;
				continue;
			}
			const read = await evaluated(arg.text, names);
			if (read === null) return { refused: VALUE_UNREAD };
			values[name] = read.value;
		}
		return resolvedCall(step.function, values);
	}

	/** Read once, at start. */
	async function readStep(fire: Fire, ref: StepRef): Promise<boolean> {
		const own = ownTell(fire, ref.path);
		if (own) return readOwnTell(fire, ref, own);
		const written = treeStep(fire, ref.path);
		const frameSite = siteIn(fire, ref.path);
		if (written && written.kind !== "do" && written.kind !== "call" && frameSite !== null) {
			return readSteering(fire, ref, frameSite, written);
		}
		const rows: LogRow[] = [];
		const at = writtenStep(fire, ref.path);
		let read: { action: AutomationAction } | { refused: string };
		if (written?.kind === "call") read = await calledOf(fire, ref.path, written);
		else if (!at) read = { refused: FRAME_UNREAD };
		else read = await valuesOf(fire, at, rows);
		const log = rows.reduce(logged, state.log);
		const current = state.fires.find((held) => sameRun(held, fire));
		const step = current?.steps[ref.path];
		const site = siteIn(fire, ref.path);
		const frame = site === null ? undefined : current?.frames?.[site];
		if (!current || !step || isEnded(step) || !frame || site === null) return unwanted(rows, log, current, step);
		if (!("refused" in read) && outdated(current, ref.path, read.action)) read = { refused: NEWER_SET };
		if ("refused" in read) {
			const ended = refusedUnsent(step);
			const fires = patched(ref.member, { steps: { ...current.steps, [ref.path]: ended } });
			return commit({
				...state,
				fires,
				log: logged(log, automationPass.endedRow(current, ref.path, ended, read.refused)),
			});
		}
		const resolved = { ...frame.resolved, [ref.path]: read.action };
		const fires = patched(ref.member, { frames: { ...current.frames, [site]: { ...frame, resolved } } });
		return commit({ ...state, fires, log });
	}

	/** Holes filled, expressions read. */
	async function valuesOf(
		fire: Fire,
		at: WrittenDo,
		rows: LogRow[],
	): Promise<{ action: AutomationAction } | { refused: string }> {
		const names = scopeOf(fire, at);
		const filled = fillerOf(fire, at.path, rows, names);
		const kind = at.step.action;
		const spec = Object.hasOwn(AUTOMATION_ACTIONS, kind)
			? AUTOMATION_ACTIONS[kind as AutomationAction["kind"]]
			: null;
		const params: readonly AutomationActionParam[] = spec?.params ?? [];
		const raw: Record<string, unknown> = { kind };
		for (const [name, arg] of Object.entries(at.step.args)) {
			if (arg.kind === "expression") {
				const value = await evaluated(arg.text, names);
				if (value === null) return { refused: VALUE_UNREAD };
				raw[name] = value.value;
				continue;
			}
			const written = arg.value;
			if (typeof written !== "string") {
				raw[name] = written;
				continue;
			}
			const max = params.find((held) => held.name === name && held.kind === "text")?.max;
			const text = await filled(written);
			raw[name] = max === undefined ? text : text.slice(0, max);
		}
		return resolved(kind, raw);
	}

	const evaluated = async (source: string, names: FireNames): Promise<{ value: unknown } | null> => {
		try {
			return (await deps.holes?.()?.evaluate(source, names)) ?? null;
		} catch (error) {
			console.error(`[automations] a value read failed: ${errorName(error)}`);
			return null;
		}
	};

	const shownOf = async (source: string, names: FireNames): Promise<string | null> => {
		try {
			return (await deps.holes?.()?.shown(source, names)) ?? null;
		} catch (error) {
			console.error(`[automations] a subject read failed: ${errorName(error)}`);
			return null;
		}
	};

	/** Fills a text's holes; a failed hole prints a mark and logs once. */
	const fillerOf = (fire: Fire, path: string, rows: LogRow[], names: FireNames = fire.names ?? {}) => {
		const holes = deps.holes?.();
		let threw = false;
		const row = (reason: string) => rows.push(automationPass.rowAt(fire, path, "uncertain", reason));
		return async (text: string): Promise<string> => {
			if (!hasHoles(text)) return unescapedText(text);
			if (!holes) {
				row("its holes cannot be read yet");
				return unreadText(text);
			}
			let read: Awaited<ReturnType<AutomationHoles["fill"]>>;
			try {
				read = await holes.fill(text, names);
			} catch (error) {
				// A thrown fill gives up.
				console.error(`[automations] a fill failed: ${errorName(error)}`);
				if (!threw) row("its holes could not be read");
				threw = true;
				return unreadText(text);
			}
			if (read.failed > 0) {
				row(`${read.failed} of its holes could not be read`);
			}
			return read.text;
		};
	};

	/** One claimed effect; the pump lands its outcome. */
	async function runOne(fire: Fire, ref: StepRef): Promise<boolean> {
		const rows: LogRow[] = [];
		const effect = stepAt(fire, ref.path);
		if (!effect) {
			spent.set(stepKey(ref), { ref, rows, attempt: { word: "refused" }, reason: NO_RUNNER });
			return true;
		}
		const spec = AUTOMATION_ACTIONS[effect.kind];
		if (spec.home && !deps.isHome()) {
			spent.set(stepKey(ref), { ref, rows, attempt: { word: "refused" }, reason: NOT_HOME });
			return true;
		}
		const filled = fillerOf(fire, ref.path, rows);
		const texts: Record<string, string> = {};
		// Read at start.
		const written = siteIn(fire, ref.path) === null ? holeTextsOf([effect]) : [];
		for (const { param, text } of written) {
			const params: readonly AutomationActionParam[] = spec.params;
			const max = params.find((held) => held.name === param)?.max ?? EFFECT_TEXT_MAX;
			texts[param] = (await filled(text)).slice(0, max);
		}
		if (!deps.actions) {
			spent.set(stepKey(ref), { ref, rows, attempt: { word: "refused" }, reason: NO_RUNNER });
			return true;
		}
		const attempt = await runEffect({ ...effect, ...texts }, deps.actions);
		spent.set(stepKey(ref), { ref, rows, attempt });
		return true;
	}

	/** Its automation's own tell, its message filled. */
	async function readOwnTell(fire: Fire, ref: StepRef, tell: Tell): Promise<boolean> {
		const rows: LogRow[] = [];
		const filled = await fillerOf(fire, ref.path, rows)(tell.message ?? "");
		const log = rows.reduce(logged, state.log);
		const current = state.fires.find((held) => sameRun(held, fire));
		const step = current?.steps[ref.path];
		if (!current || !step || isEnded(step)) return unwanted(rows, log, current, step);
		const { message: _written, ...bare } = tell;
		const message = filled.slice(0, AUTOMATION_MESSAGE_MAX);
		// An empty fill tells with no message.
		const read: Tell = message === "" ? bare : { ...bare, message };
		const resolved = { ...current.resolved, [ref.path]: read };
		return commit({ ...state, fires: patched(ref.member, { resolved }), log });
	}

	/** Outcomes in one write. */
	const landSpent = (): void => {
		const landed = automationPass.settle(state.fires, state, deps.now(), false, spent, isRunning);
		const fires = landed.fires.filter((fire) => !finished(fire));
		const next: State = {
			...state,
			log: landed.log,
			ran: landed.ran,
			landedSets: landed.landedSets,
			lastRuns: landed.lastRuns,
			fires,
		};
		if (canonicalJson(next) !== canonicalJson(state) && commit(next)) spent.clear();
	};

	const outbox = outboxOf(() => state.queue, deps.now);

	/** One band per crossing. */
	const derivedFields = (): DerivedField[] =>
		records.list().flatMap((record) => {
			const { trigger } = record.body;
			if (trigger.kind !== "crossing") return [];
			return [{ id: crossingFieldId(record.id), incarnation: record.incarnation, body: crossingField(trigger) }];
		});

	const rowOf = (record: OwnerRecord<Automation>): AutomationRow => {
		const invalid = records.invalidOf(record.id);
		const errors = issuesOf(record.body).filter((issue) => issue.level === "error").length;
		const slot = own(state.slots, record.id);
		const lastRanAt = own(state.ran, record.id);
		const held = own(state.lastRuns, record.id);
		const lastRun = held && lastRunStands(record.id, held) ? held : undefined;
		const { trigger } = record.body;
		const current = slot?.revision === record.revision ? slot : undefined;
		const coming = isClock(trigger) && current && armed(record) ? nextSlot(trigger, current.at) : null;
		const nextRunAt =
			coming !== null && coming === current?.skip && isClock(trigger) ? nextSlot(trigger, coming) : coming;
		return {
			id: record.id,
			revision: record.revision,
			automation: record.body,
			sentence: sentenceOf(record.body),
			...(invalid === null ? {} : { invalid }),
			...(lastRanAt === undefined ? {} : { lastRanAt }),
			...(nextRunAt === null ? {} : { nextRunAt }),
			...(lastRun ? { lastRun: lastRun.run } : {}),
			...(errors > 0 ? { errors } : {}),
		};
	};

	/** A revived id starts unrun. */
	const forgetRan = (ids: readonly string[]): void => {
		if (!ids.some((id) => Object.hasOwn(state.ran, id))) return;
		commit({ ...state, ran: Object.fromEntries(Object.entries(state.ran).filter(([id]) => !ids.includes(id))) });
	};

	const judged = (intent: AutomationIntent, held: readonly OwnerRecord<Automation>[]) =>
		judgeAutomationWrite(intent, {
			held,
			functions: store.list().filter(isFunctionRecord),
			unreadAutomations: store.unreadCount(AUTOMATION_KIND),
			unreadFunctions: store.unreadCount(FUNCTION_KIND),
			isHome: deps.isHome(),
			assess: (body, functions) => [...assessBody(body, functions)],
			copyIdOf: (automationId, from) => derivedFunctionId("copy", automationId, from),
			carryIdOf: (from) => derivedFunctionId("carry", "", from),
			unreadAt: (id) => store.unreadOf(id, AUTOMATION_KIND) || store.unreadOf(id, FUNCTION_KIND),
			unreadFunctionAt: (id) => store.unreadOf(id, FUNCTION_KIND),
		});

	/** What removed automations left queued. */
	const dropOwned = (ids: readonly string[]): void => {
		if (ids.length === 0) return;
		const gone = new Set(ids);
		const owned = (member: string) => {
			const owner = ownerOf(member);
			return owner !== null && gone.has(owner);
		};
		const events = state.queue.events.filter((event) => !owned(event.member));
		const fires = state.fires.map((held) => (gone.has(held.automation) ? untold(held) : held));
		const next: State = { ...state, queue: { ...state.queue, events }, fires };
		if (canonicalJson(next) !== canonicalJson(state) && !commit(next)) {
			console.warn("[automations] a removed automation's queued events were not dropped");
		}
	};

	const refusalWithLine = (refusal: AutomationSaveRefusal, reason: string): AutomationSaveRefusal =>
		refusal.line === undefined ? { ...refusal, line: reason.slice(0, SAVE_LINE_MAX) } : refusal;

	const storeRefused = (
		result: Extract<OwnerBatchResult<StoredBody>, { stored: false }>,
		writes: readonly OwnerWrite[],
		intent: AutomationIntent,
	): Extract<AutomationWritten, { written: false }> => ({
		written: false,
		reason: result.reason,
		refusal: refusalWithLine(storeRefusal(result, writes[result.at], sentFunctions(intent)), result.reason),
		...(result.record ? { record: result.record } : {}),
		...(result.issue ? { issue: result.issue } : {}),
	});

	/** `write`'s answer, unwritten. */
	function assess(
		intent: AutomationIntent,
		held: readonly OwnerRecord<Automation>[],
	): Extract<AutomationWritten, { written: false }> | Extract<AutomationVerdict, { kind: "writes" }> {
		const verdict = judged(intent, held);
		if (verdict.kind === "refused") {
			return {
				written: false,
				reason: verdict.reason,
				refusal: refusalWithLine(verdict.refusal, verdict.reason),
				...(verdict.confirm ? { confirm: verdict.confirm } : {}),
			};
		}
		const refused = store.refusalOf(verdict.writes);
		return refused ? storeRefused(refused, verdict.writes, intent) : verdict;
	}

	/** Every row lands, or none. */
	function write(intent: AutomationIntent): AutomationWritten {
		const held = records.list();
		const verdict = assess(intent, held);
		if ("written" in verdict) return verdict;
		for (const { id, why } of verdict.dropped) {
			console.warn(`[automations] ${intent.kind}: ${id} dropped: ${why}`);
		}
		const result = store.batch(verdict.writes);
		if (!result.stored) return storeRefused(result, verdict.writes, intent);
		const known = new Set(held.map((record) => record.id));
		forgetRan(verdict.writes.filter((row) => row.op === "remove" || !known.has(row.id)).map((row) => row.id));
		const live = new Set(records.list().map((record) => record.id));
		dropOwned(held.filter((record) => !live.has(record.id)).map((record) => record.id));
		// Bands follow their crossings.
		deps.fields.derivedChanged();
		drain();
		tick();
		return { written: true, records: result.records, dropped: verdict.dropped };
	}

	/** Derived ids never answered. */
	const sentFunctions = (intent: AutomationIntent): ReadonlySet<string> =>
		intent.kind === "save"
			? new Set([
					...(intent.function?.as === "edit" ? [intent.function.id] : []),
					...(intent.called ?? []).map((each) => each.id),
				])
			: new Set();

	const storeRefusal = (
		refusal: Extract<OwnerBatchResult<StoredBody>, { stored: false }>,
		write: OwnerWrite | undefined,
		sent: ReadonlySet<string>,
	): AutomationSaveRefusal => {
		const kind = write?.op === "put" ? write.kind : (store.get(write?.id ?? "")?.kind ?? AUTOMATION_KIND);
		const record = kind === FUNCTION_KIND ? "function" : "automation";
		const which = record === "function" && write && sent.has(write.id) ? { id: write.id } : {};
		const { cause } = refusal;
		if (typeof cause === "object") {
			if (cause.cap === TOTAL_CAP) return { code: "full", max: cause.max };
			return { code: "full", kind: cause.cap === FUNCTION_KIND ? "function" : "automation", max: cause.max };
		}
		switch (cause) {
			case "invalid": {
				const { issue } = refusal;
				if (!issue) return { code: "invalid", record, ...which, line: refusal.reason.slice(0, SAVE_LINE_MAX) };
				const path = issue.path.join(".");
				const place = stepPlaceOf(issue);
				return issue.code === STEP_ISSUE_CODE
					? { code: "invalid", record, ...which, path, ...place, line: issue.message.slice(0, SAVE_LINE_MAX) }
					: { code: "invalid", record, ...which, path, line: `the ${record} is invalid` };
			}
			case "moved": {
				return refusal.record
					? { code: "moved", record, ...which, revision: refusal.record.revision }
					: { code: "moved", record, ...which };
			}
			case "newer_build":
				return record === "function"
					? { code: "newer_function", record, ...which }
					: { code: "newer_automation", ...(write ? { id: write.id } : {}) };
			case "spent":
				return { code: "invalid", record, ...which, path: "revision" };
			case "bad_id":
				return { code: "invalid", record, ...which, path: "id" };
			case "absent":
			case "removed":
				return { code: "gone", record, ...which };
			case "unsaved":
				return { code: "unwritten", record };
		}
	};

	/** Trigger reads, callees' included. */
	const readsThrough = (fn: AutomationFunction, lookup: FunctionOf): { names: string[]; eventFields: string[] } => {
		const own = functionReads(fn);
		const names = new Set(own.names);
		const eventFields = new Set(own.eventFields);
		const seen = new Set<string>();
		const take = (id: string): void => {
			const callee = seen.has(id) ? null : lookup(id);
			seen.add(id);
			if (!callee) return;
			const declared = new Set(callee.params.map((param) => param.name));
			const reads = functionReads(callee);
			for (const name of reads.names) if (!declared.has(name)) names.add(name);
			for (const field of reads.eventFields) eventFields.add(field);
			for (const below of callsOf(callee)) take(below);
		};
		for (const called of callsOf(fn)) take(called);
		return { names: [...names].sort(), eventFields: [...eventFields].sort() };
	};

	/** One read; a function no automation reaches is unlisted. */
	const listing = (): { automations: AutomationRow[]; functions: AutomationFunctionRow[] } => {
		const all = store.list();
		const automations = all.filter(isAutomationRecord);
		const held = all.filter(isFunctionRecord);
		const reaching = automations.map((record) => ({ record, enters: reachOf(record.body, functionOf) }));
		const functions = held.flatMap((record) => {
			const reachers = reaching.filter(({ enters }) => enters.has(record.id)).map((each) => each.record);
			if (reachers.length === 0) return [];
			const invalid = store.invalidOf(record.id);
			return [
				{
					id: record.id,
					revision: record.revision,
					function: record.body,
					users: reachers
						.filter((each) => pointerOf(each.body)?.function === record.id)
						.map((each) => each.id),
					callers: held.filter((each) => callsOf(each.body).includes(record.id)).map((each) => each.id),
					moves: reachers.some((each) => movesWithHome(each.body)),
					reads: readsThrough(record.body, functionOf),
					...(invalid === null ? {} : { invalid }),
				},
			];
		});
		return { automations: automations.map(rowOf), functions };
	};

	/** Both rows from one read. */
	function saveOp(op: Omit<Extract<ConsoleOp, { kind: "automation_save" }>, "kind">): ConsoleAutomationSaveResult {
		const { kind: _kind, ...intent } = saveIntentOf(op);
		const saved = save(intent);
		if (!saved.stored) return { stored: false, refusal: refusalWithLine(saved.refusal, saved.reason) };
		const listed = listing();
		const row = listed.automations.find((held) => held.id === saved.automation.id);
		const pointer = pointerOf(saved.automation.body);
		const fn = pointer ? listed.functions.find((held) => held.id === pointer.function) : undefined;
		const wrote = new Set((op.called ?? []).map((each) => each.id));
		const called = listed.functions.filter((held) => wrote.has(held.id));
		const issues = issuesOf(saved.automation.body).slice(0, AUTOMATION_ISSUES_MAX);
		return {
			stored: true,
			...(row ? { automation: row } : {}),
			...(fn ? { function: fn } : {}),
			...(wrote.size > 0 ? { called } : {}),
			...(issues.length > 0 ? { issues } : {}),
		};
	}

	/** Proposed save issues. */
	const issuesLeft = (writes: readonly OwnerWrite[], id: string, sent: ReadonlySet<string>): AutomationIssue[] => {
		const putAt = (at: string) => writes.find((row) => row.op === "put" && row.id === at);
		const row = putAt(id);
		const body = row?.op === "put" ? AutomationSchema.safeParse(row.body) : null;
		if (!body?.success) return [];
		const lookup: FunctionOf = (at) => {
			const put = putAt(at);
			if (put?.op !== "put" || put.kind !== FUNCTION_KIND) return functionOf(at);
			const fn = FunctionSchema.safeParse(put.body);
			return fn.success ? fn.data : null;
		};
		return issuesOf(body.data, lookup)
			.slice(0, AUTOMATION_ISSUES_MAX)
			.map((issue) => {
				// Unwritten ids stay omitted.
				if (issue.id === undefined || sent.has(issue.id) || functionOf(issue.id) !== null) return issue;
				const { id: _derived, ...unnamed } = issue;
				return unnamed;
			});
	};

	const saveIntentOf = (
		op: Omit<Extract<ConsoleOp, { kind: "automation_save" | "automation_check" }>, "kind">,
	): Extract<AutomationIntent, { kind: "save" }> => ({
		kind: "save",
		id: op.automationId,
		body: op.automation,
		base: op.automationBase,
		...(op.function ? { function: op.function } : {}),
		...(op.called ? { called: op.called } : {}),
		...(op.functionBase === undefined ? {} : { functionBase: op.functionBase }),
		confirmed: op.confirmed === true,
	});

	/** A save's answer, unwritten. */
	function checkOp(op: Omit<Extract<ConsoleOp, { kind: "automation_check" }>, "kind">): ConsoleAutomationCheckResult {
		const verdict = assess(saveIntentOf(op), records.list());
		const pointer = pointerOf(op.automation);
		const sent = op.function && FunctionSchema.safeParse(op.function.body);
		const body = sent ? (sent.success ? sent.data : null) : pointer ? functionOf(pointer.function) : null;
		// As the save would leave them.
		const written = new Map((op.called ?? []).map((each) => [each.id, FunctionSchema.safeParse(each.body)]));
		const lookup: FunctionOf = (id) => {
			const sentCallee = written.get(id);
			return sentCallee ? (sentCallee.success ? sentCallee.data : null) : functionOf(id);
		};
		const reads = body ? { reads: readsThrough(body, lookup) } : {};
		if ("written" in verdict) return { ready: false, refusal: verdict.refusal, ...reads };
		const issues = issuesLeft(verdict.writes, op.automationId, sentFunctions(saveIntentOf(op)));
		return { ready: true, ...reads, ...(issues.length > 0 ? { issues } : {}) };
	}

	function save(intent: Omit<Extract<AutomationIntent, { kind: "save" }>, "kind">): AutomationSaved {
		const result = write({ kind: "save", ...intent });
		if (!result.written) return { stored: false, refusal: result.refusal, reason: result.reason };
		const automation = result.records.find((record) => record?.id === intent.id);
		if (!automation || !isAutomationRecord(automation))
			return { stored: false, refusal: { code: "gone", record: "automation" }, reason: "not saved; try again" };
		const pointed = pointerOf(automation.body)?.function;
		const fn = result.records.find((record) => record?.id === pointed);
		return { stored: true, automation, ...(fn && isFunctionRecord(fn) ? { function: fn } : {}) };
	}

	drain();
	tick();

	return {
		list: () => records.list(),
		/** Null when not held. */
		functionOf,
		functionRows: () =>
			store
				.list()
				.filter(isFunctionRecord)
				.map((record) => ({ id: record.id, name: record.body.name, params: record.body.params })),
		givenOf,
		/** Refusals use error level. */
		stepIssuesOf(
			body: { params: readonly FunctionParam[]; steps: readonly FunctionStep[] },
			trigger?: AutomationTrigger,
		): StepIssueAt[] {
			const parsed = FunctionSchema.safeParse({ name: "", ...body });
			if (!parsed.success) return [];
			return stepIssuesOf(parsed.data, trigger).map(
				({ step, param, start, end, case: at, chip, message, level }) => ({
					step,
					...(param === undefined ? {} : { param }),
					...(start === undefined ? {} : { start }),
					...(end === undefined ? {} : { end }),
					...(at === undefined ? {} : { case: at }),
					...(chip === undefined ? {} : { chip }),
					message,
					level: level === "refuses" ? "error" : level,
				}),
			);
		},
		rows: (): AutomationRow[] => records.list().map(rowOf),
		listing,
		saveOp,
		checkOp,
		write,
		/** Why `write` would refuse it; writes nothing. */
		refusalOf(intent: AutomationIntent): { reason: string; full: boolean } | null {
			const verdict = assess(intent, records.list());
			return "written" in verdict ? { reason: verdict.reason, full: verdict.refusal.code === "full" } : null;
		},
		derivedFields,
		save,
		ownerPut(id: string, body: unknown, base: number, confirmed = false): ConsoleAutomationPutResult {
			const result = write({ kind: "owner_put", id, body, base, confirmed });
			const landed = result.written ? result.records[0] : result.record;
			const record = landed && isAutomationRecord(landed) ? landed : records.get(id);
			if (result.written && record) return { stored: true, revision: record.revision, row: rowOf(record) };
			return {
				stored: false,
				revision: record?.revision ?? 0,
				reason: result.written ? "not saved; try again" : result.reason,
				...(record ? { row: rowOf(record) } : {}),
				...(!result.written && result.confirm ? { confirm: result.confirm } : {}),
			};
		},
		ownerRemove(id: string, base: number): ConsoleAutomationDeleteResult {
			const result = write({ kind: "owner_remove", id, base });
			return result.written ? { deleted: true } : { deleted: false, reason: result.reason };
		},
		/** Fires each match once per event. */
		fireEvents(matched: readonly { automation: string; key: string; names: FireNames }[], at: number): void {
			const work = workOf();
			const fired = [...state.fired];
			for (const { automation, key, names } of matched) {
				const record = records.get(automation);
				if (!record || !armed(record)) continue;
				const member = memberOf(record.id, record.incarnation, key);
				const { trigger } = record.body;
				// A cooling one counts the lane's own tells.
				const cools = trigger.kind === "event" && (trigger.coolDownSec ?? 0) > 0;
				const runs = Object.keys(runSteps(record.body)).length > 0;
				if ((!runs && !cools) || fired.includes(member)) continue;
				fired.push(member);
				fire(work, record, { member, seq: 0, at }, names, fieldsOf(names));
			}
			if (fired.length === state.fired.length) return;
			const lost = fired.length - state.fired.length;
			if (
				commit({
					...state,
					fires: work.fires,
					fired: fired.slice(-FIRED_MAX),
					log: work.log,
					firedAt: work.firedAt,
					order: work.order,
				})
			)
				pump();
			else console.warn(`[automations] ${lost} event fires were not recorded and will not run`);
		},
		/** Once by hand; a repeated call id answers as the first did. */
		run(id: string, callId: string): ConsoleAutomationRunResult {
			const record = records.get(id);
			if (!record) return { ran: false, refusal: "gone" };
			if (!record.body.enabled) return { ran: false, refusal: "off" };
			if (!armed(record)) return { ran: false, refusal: "invalid" };
			const { trigger } = record.body;
			if (trigger.kind === "event" && !deps.isHome()) return { ran: false, refusal: "away" };
			const member = memberOf(record.id, record.incarnation, "manual", callId);
			if (state.fired.includes(member)) return { ran: true };
			// An event by hand has no event.
			const names = trigger.kind === "event" ? {} : namesNow(trigger);
			const work = workOf();
			const admitted = fire(work, record, { member, seq: 0, at: deps.now() }, names, fieldsOf(names), true);
			const next = {
				...state,
				fires: work.fires,
				fired: [...state.fired, member].slice(-FIRED_MAX),
				log: work.log,
				firedAt: work.firedAt,
				order: work.order,
			};
			if (!commit(next)) return { ran: false, refusal: "not_admitted" };
			if (admitted) pump();
			return admitted ? { ran: true } : { ran: false, refusal: "not_admitted" };
		},
		/** Resolves when idle. */
		async settled(): Promise<void> {
			while (running.size > 0 || reading) await Promise.all([...runningDone(), reading]);
		},
		/** Event automations that woke the assistant. */
		noteEvents(ids: readonly string[], at: number): void {
			if (ids.length === 0) return;
			const live = new Set(records.list().map((record) => record.id));
			const ran = Object.fromEntries(Object.entries(state.ran).filter(([id]) => live.has(id)));
			for (const id of ids) if (live.has(id)) ran[id] = at;
			commit({ ...state, ran });
		},
		/** Read-time validity; never stored. */
		invalidOf: (id: string): string | null => records.invalidOf(id),
		namesNow,
		/** Field commit callback. */
		drain: (): void => {
			drain();
		},
		/** Clocks that a timer missed. */
		tick: (): void => {
			tick();
		},
		/** Sensors gone silent, or heard again. */
		watchSensors: (): void => {
			watchSensors();
		},
		/** On the persist tick. */
		sweepFunctions,
		/** Stops clocks and runs; awaits the run in flight. */
		async stop(): Promise<void> {
			stopped = true;
			if (clock) deps.timers?.clearTimer(clock.handle());
			clock = null;
			while (running.size > 0 || reading) await Promise.all([...runningDone(), reading]);
			landSpent();
		},
		/** Clear events, then drain; a repeat retries. */
		/** False when the write did not land. */
		emptyOutbox(): boolean {
			return state.queue.events.length === 0 || commit({ ...state, queue: { ...state.queue, events: [] } });
		},
		clear(members: readonly string[]): boolean {
			const events = state.queue.events.filter((event) => !members.includes(event.member));
			if (
				events.length !== state.queue.events.length &&
				!commit({ ...state, queue: { ...state.queue, events } })
			) {
				return false;
			}
			return drain();
		},
		sentenceOf: (id: string): string | null => {
			const record = records.list().find((held) => held.id === id);
			return record ? sentenceOf(record.body) : null;
		},
		/** A source's armed event automations. */
		eventsOf(sourceId: string): { id: string; trigger: EventTrigger; when: TellWhen | null; cooling: boolean }[] {
			const now = deps.now();
			return records.list().flatMap((record) => {
				const { trigger } = record.body;
				if (trigger.kind !== "event" || trigger.source !== sourceId || !armed(record)) return [];
				const cool = trigger.coolDownSec ?? 0;
				const cooling = cool > 0 && coolingAt(state.firedAt, record, now, cool);
				return [{ id: record.id, trigger, when: laneTellWhen(record.body, functionOf), cooling }];
			});
		},
		log: (): readonly LogRow[] => state.log.rows,
		/** Null before it ran, or once what it runs changed. */
		lastRun: (id: string): AutomationLastRun | null => {
			const held = own(state.lastRuns, id);
			return held && lastRunStands(id, held) ? held.run : null;
		},
		checkpoint: (id: string) => own(state.automations, id) ?? null,
		queued: () => state.queue,
		outbox,
	};
}

export type Automations = ReturnType<typeof createAutomations>;
