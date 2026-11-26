// The automation store.

import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { functionReads } from "../../shared/automation-fit.js";
import { type ReachedStep, reached } from "../../shared/automation-walk.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { chainedTimer } from "../../shared/chained-timer.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import { commitChecked, type DurableStore, writeChecked } from "../../shared/durable-store.js";
import { errorName } from "../../shared/error-name.js";
import {
	AUTOMATION_ACTIONS,
	AUTOMATIONS_MAX,
	type Automation,
	type AutomationAction,
	type AutomationActionParam,
	AutomationActionSchema,
	type AutomationFunctionRow,
	type AutomationRow,
	AutomationSchema,
	type AutomationTrigger,
	type ConsoleAutomationDeleteResult,
	type ConsoleAutomationPutResult,
	type EventTrigger,
	KEEP_TRYING_MIN_DEFAULT,
	type TellWhen,
} from "../../shared/schemasAutomation.js";
import {
	type AutomationSaveRefusal,
	type ConsoleAutomationSaveResult,
	SAVE_LINE_MAX,
} from "../../shared/schemasAutomationSave.js";
import { type AutomationFunction, FUNCTIONS_MAX, FunctionSchema } from "../../shared/schemasFunction.js";
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
	callSiteOf,
	claim,
	claimedPaths,
	type Fire,
	type FireNames,
	type Frame,
	finished,
	frameKey,
	holdsClaim,
	isStep,
	type LandedSet,
	mayRun,
	nextEffect,
	nextFill,
	outdatedSets,
	type Runnable,
	type StepRef,
	started,
	stepKey,
	stepsOf,
	switchOf,
	turnOf,
	WAITING_EVENTS_MAX,
	withStep,
} from "./automationFires.js";
import {
	AUTOMATION_KIND,
	type AutomationIntent,
	type DroppedAutomation,
	FUNCTION_KIND,
	judgeAutomationWrite,
	movesWithHome,
	NOT_HOME,
	pointerOf,
} from "./automationJudge.js";
import { COOLING, fireRow, logged, type RunRow } from "./automationLog.js";
import { clip, type Dropped, memberOf, outboxOf, ownerOf, QUEUE_FULL, stepMember, told } from "./automationOutbox.js";
import {
	type Attempt,
	type AutomationActionPorts,
	type AutomationEffect,
	effectIssue,
	isEffect,
	natureOf,
	runEffect,
} from "./automationRunner.js";
import { type Checkpoint, FIRED_MAX, own, restore, type State, versionKey } from "./automationState.js";
import {
	begun,
	clamped,
	dueAt,
	endedOutcome,
	expired,
	FRESH_STEP,
	heard,
	isEnded,
	KEEP_TRYING_MS,
	type Nature,
	outOfTime,
	recovered,
	refusedUnsent,
	type Step,
	timedOut,
	unsent,
} from "./automationSteps.js";
import { holeSpanOf, holeTextsOf, isTell, laneTellWhen, tellPlan } from "./automationText.js";
import {
	createAutomationValidity,
	FUNCTION_GONE,
	FUNCTION_UNREAD,
	STEP_ISSUE_CODE,
	STEP_UNFIT,
} from "./automationValidity.js";
import { createAutomationWords, fieldsOf, type WatchedReading } from "./automationWords.js";
import type { ComputedFields, DerivedField } from "./computedFields.js";
import { crossingField, crossingFieldId } from "./crossingBand.js";
import { type HeardSensor, silenceNotices } from "./sensorSilence.js";

export { FIRES_MAX, WAITING_EVENTS_MAX } from "./automationFires.js";
export { ROW_OUTCOMES, type RunRow } from "./automationLog.js";
export {
	type AutomationOutbox,
	type OutboxEvent,
	QUEUE_MAX_BYTES,
	QUEUE_MAX_EVENTS,
} from "./automationOutbox.js";
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
export const NEWER_SET = "a newer setting of this switch landed first";

export const SWITCHED_OFF = "it was switched off";
export { STEP_UNFIT };
export const VALUE_UNREAD = "a value it takes could not be read";
export const FRAME_UNREAD = "the function it ran could not be read";

const actionAt = (body: Automation, path: string): AutomationAction | undefined =>
	reached(body).find((at) => at.path === path)?.action;

type Call = Extract<AutomationAction, { kind: "run_function" }>;
type Tell = Extract<AutomationAction, { kind: "tell_assistant" }>;

const callAt = (body: Automation, path: string): Call | null => {
	const action = actionAt(body, path);
	return action?.kind === "run_function" ? action : null;
};

const callOf = (body: Automation): Call | null => {
	for (const { action } of reached(body)) if (action.kind === "run_function") return action;
	return null;
};

const hasSteps = (body: Automation): boolean => reached(body).some(({ action }) => isStep(action));
/** A walk whose write failed is retried after this. */
const CLOCK_RETRY_MS = 30_000;
/** Kept for a move back. */
export const FUNCTION_UNUSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// Remove 2026-11-28: a body stored before triggers had kinds.
const LegacyBodySchema = z.strictObject({
	label: z.string(),
	enabled: z.boolean(),
	trigger: z.strictObject({ field: z.string(), becomes: z.union([z.string(), z.boolean()]) }),
	action: z.strictObject({ kind: z.literal("tell_assistant") }),
	coolDownSec: z.number(),
});

const StoredAutomationSchema = z.preprocess((body) => {
	const legacy = LegacyBodySchema.safeParse(body);
	if (!legacy.success) return body;
	const { label, enabled, trigger, coolDownSec } = legacy.data;
	return {
		label,
		enabled,
		trigger: { kind: "value", ...trigger, coolDownSec },
		actions: [{ kind: "tell_assistant", when: "quietly" }],
	};
}, AutomationSchema);

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
	/** Never throws. */
	fill: (text: string, names: Readonly<FireNames>) => Promise<{ text: string; failed: number }>;
	/** Null when it fails. */
	evaluate: (source: string, names: Readonly<FireNames>) => Promise<{ value: unknown } | null>;
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
	/** A source's declared event fields; null when not held. */
	eventFields?: (source: string) => readonly string[] | null;
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
	const { triggerIssue, holesIssue, functionIssue, callIssue, automationIssue, writeIssue, bodyIssue, armed } =
		createAutomationValidity(
			deps,
			(id) => functionOf(id),
			(id) => store.unreadOf(id, FUNCTION_KIND),
		);
	const { sentenceOf, watched, namesOf, crossingNames } = createAutomationWords(deps);

	const store = createOwnerRecords<StoredBody>({
		store: deps.records,
		kinds: { [AUTOMATION_KIND]: StoredAutomationSchema, [FUNCTION_KIND]: FunctionSchema },
		max: AUTOMATIONS_MAX,
		maxByKind: { [FUNCTION_KIND]: FUNCTIONS_MAX },
		newIncarnation: deps.newIncarnation,
		refusal: (candidate, others) => {
			if (isFunctionRecord(candidate)) return functionIssue(candidate.body);
			if (!isAutomationRecord(candidate)) return null;
			// Includes the write's own functions.
			const functions = (id: string) => {
				const row = others.find((other) => other.id === id);
				return row && isFunctionRecord(row) ? row.body : null;
			};
			return holesIssue(candidate.body) ?? writeIssue(candidate.body, functions);
		},
		// Remove 2026-11-28 with the legacy body.
		settle: true,
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
	/** Drops clocks and sets of gone records. */
	const pruned = (next: State): Pick<State, "firedAt" | "landedSets"> => ({
		firedAt: Object.fromEntries(
			Object.entries(next.firedAt).filter(([id, held]) => records.get(id)?.incarnation === held.incarnation),
		),
		landedSets: Object.fromEntries(
			Object.entries(next.landedSets).filter(([device]) => (deps.actions?.switchName(device) ?? null) !== null),
		),
	});

	const commit = (next: State): boolean =>
		commitChecked(
			deps.state,
			{ ...next, versions: pinned(next), functionVersions: pinnedFunctions(next), ...pruned(next) },
			(landed) => {
				state = landed;
			},
			{ label: "automation state" },
		).landed;

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

	const frameFunction = (frame: Frame): AutomationFunction | null =>
		own(state.functionVersions, frameKey(frame)) ?? liveFunction(frame) ?? null;

	/** Through the walk. */
	const writtenStep = (fire: Fire, path: string): ReachedStep | null => {
		const site = callSiteOf(path);
		const frame = site === null ? undefined : fire.frames?.[site];
		const body = bodyOf(fire);
		const fn = frame ? frameFunction(frame) : null;
		if (!body || !frame || !fn) return null;
		const at = reached(body, (id) => (id === frame.function ? fn : null)).find((held) => held.path === path);
		return at && "step" in at ? at : null;
	};

	/** As fired, else as read. */
	const actionOf = (fire: Fire, path: string): AutomationAction | null => {
		const site = callSiteOf(path);
		if (site !== null) return fire.frames?.[site]?.resolved?.[path] ?? null;
		const body = bodyOf(fire);
		return (body && actionAt(body, path)) ?? null;
	};

	const stepAt = (fire: Fire, path: string): AutomationEffect | null => {
		const action = actionOf(fire, path);
		return action && isEffect(action) ? action : null;
	};

	/** For a step's row. */
	const kindAt = (fire: Fire, path: string): string | undefined =>
		actionOf(fire, path)?.kind ?? writtenStep(fire, path)?.kind;

	/** Call window, else default. */
	const windowOf = (fire: Fire, path: string): number => {
		const site = callSiteOf(path);
		const body = bodyOf(fire);
		if (site === null || !body) return KEEP_TRYING_MS;
		return (callAt(body, site)?.keepTryingMin ?? KEEP_TRYING_MIN_DEFAULT) * 60_000;
	};

	/** Baselines whose write has not landed. */
	let unsaved: State["automations"] = {};

	/** What one pass will commit. */
	interface Work {
		log: RunRow[];
		fires: Fire[];
		firedAt: State["firedAt"];
	}

	const workOf = (): Work => ({ log: state.log, fires: [...state.fires], firedAt: state.firedAt });

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

	/** Records a fire for the run; false when nothing will run. */
	const fire = (
		work: Work,
		record: OwnerRecord<Automation>,
		at: { member: string; seq: number; at: number },
		names: FireNames,
		fields: Record<string, string>,
	): boolean => {
		const plan = tellPlan(record.body);
		const fired = { automation: record.id, seq: at.seq, at: at.at };
		const call = callOf(record.body);
		if (call?.coolDownSec !== undefined) {
			// From admission, as a trigger's own.
			const held = own(work.firedAt, record.id);
			const last = held?.incarnation === record.incarnation ? held.at : undefined;
			if (last !== undefined && at.at - last < call.coolDownSec * 1000) {
				work.log = logged(work.log, fireRow(fired, "suppressed", COOLING));
				return false;
			}
		}
		const home = deps.isHome();
		if (plan.when !== null && !home) work.log = logged(work.log, fireRow(fired, "refused", NOT_HOME));
		const told = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, clip(value)]));
		const tell: Fire["tell"] =
			plan.when === null || !home
				? undefined
				: plan.filling
					? { when: plan.when, fields: told, fill: true }
					: { when: plan.when, fields: withMessage(told, plan.messages.map(unescapedText)) };
		const effects = hasSteps(record.body);
		if (!tell && !effects) return false;
		const recorded: Fire = {
			...fired,
			member: at.member,
			incarnation: record.incarnation,
			revision: record.revision,
			names,
			steps: stepsOf(record.body),
			active: [],
			...(tell ? { tell } : {}),
			...(call ? { fields: told } : {}),
		};
		const event = record.body.trigger.kind === "event";
		const verdict = admit(work.fires, recorded, {
			// Each event carries its own.
			supersede: effects && !event,
			earlier: (member) => state.fires.some((stored) => stored.member === member),
			...(event ? { waitingMax: WAITING_EVENTS_MAX } : {}),
		});
		work.fires = verdict.fires;
		for (const row of verdict.rows) work.log = logged(work.log, fireRow(row.fire, row.outcome, row.reason));
		if (verdict.admitted && call?.coolDownSec !== undefined)
			work.firedAt = { ...work.firedAt, [record.id]: { incarnation: record.incarnation, at: at.at } };
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
				work.log = logged(work.log, fireRow(gap, "uncertain", `missed ${missed} changes`));
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
					work.log = logged(work.log, fireRow(seen, "suppressed", "cooling down"));
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
				work.log = logged(work.log, fireRow(gap, "uncertain", reason));
			}
			const { skip, ...kept } = held;
			if (walk.skipped && skip !== undefined) {
				const before = { automation: record.id, seq: 0, at: skip };
				work.log = logged(work.log, fireRow(before, "suppressed", "it ran before the clock stepped back"));
			}
			slots[record.id] = { ...kept, at: walk.at, ...(skip !== undefined && walk.at < skip ? { skip } : {}) };
		}
		const next: State = { ...state, slots, log: work.log, fires: work.fires, firedAt: work.firedAt };
		const landed = canonicalJson(next) === canonicalJson(state) || commit(next);
		pump();
		rearm(now, landed);
		return landed;
	}

	/** The effect in flight. */
	let running: { ref: StepRef; done: Promise<void> } | null = null;
	/** The fill beside it. */
	let filling: Promise<void> | null = null;
	/** Read in flight. */
	let reading: Promise<void> | null = null;
	/** Answers kept until written. */
	const spent = new Map<string, { ref: StepRef; rows: RunRow[]; attempt: Attempt; reason?: string }>();
	/** Judged each pass until committed. */
	let recovering = true;

	const isRunning = (ref: StepRef): boolean => running !== null && stepKey(running.ref) === stepKey(ref);

	/** A retiring fire never retries, so it has none. */
	const natureAt = (fire: Fire, path: string, retiring: boolean): Nature | null => {
		const effect = retiring ? null : stepAt(fire, path);
		return effect ? natureOf(effect) : null;
	};

	/** An ended step's row. */
	const endedRow = (fire: Fire, path: string, step: Step, reason?: string): RunRow => {
		const ended = endedOutcome(step.word);
		return fireRow(fire, ended.outcome, reason ?? ended.reason, kindAt(fire, path));
	};

	/** Judges steps a restart found. */
	const recoverFire = (fire: Fire, held: RunRow[], now: number, retiring: boolean) => {
		let log = held;
		let landed = fire;
		for (const [path, step] of Object.entries(fire.steps)) {
			const next = recovered(step, natureAt(fire, path, retiring), now, windowOf(fire, path));
			landed = withStep(landed, path, next);
			if (!isEnded(step) && isEnded(next)) log = logged(log, endedRow(fire, path, next));
		}
		return { fire: landed, log };
	};

	/** A retiring fire's open steps end with their last word. */
	const endHeard = (fire: Fire, held: RunRow[]) => {
		let log = held;
		let landed = fire;
		for (const [path, step] of Object.entries(fire.steps)) {
			// A claim ends when it answers.
			if (isEnded(step) || step.claimed || step.word === undefined) continue;
			const ended = timedOut(step);
			landed = withStep(landed, path, ended);
			log = logged(log, endedRow(fire, path, ended));
		}
		return { fire: landed, log };
	};

	/** Lands answers; a newer set ends older ones. */
	const settle = (
		stored: readonly Fire[],
		held: Pick<State, "log" | "ran" | "landedSets">,
		now: number,
		recover: boolean,
	) => {
		let { log, ran } = held;
		const sets: LandedSet[] = [];
		const settled = stored.map((found) => {
			const retiring = retireOf(found) !== null;
			let fire = found;
			if (recover) ({ fire, log } = recoverFire(fire, log, now, retiring));
			let landedSets: LandedSet[];
			({ fire, log, ran, sets: landedSets } = landAnswers(fire, { log, ran }, now, retiring));
			sets.push(...landedSets);
			if (retiring) ({ fire, log } = endHeard(fire, log));
			return fire;
		});
		const outdated = outdatedSets(settled, sets, stepAt);
		const fires = settled.map((fire) =>
			outdated
				.filter((at) => at.member === fire.member)
				.reduce((held, { path }) => {
					const ended = refusedUnsent(held.steps[path] as Step);
					log = logged(log, endedRow(held, path, ended, NEWER_SET));
					return withStep(held, path, ended);
				}, fire),
		);
		const landedSets = { ...held.landedSets };
		for (const { device, ...set } of sets) {
			const before = own(landedSets, device);
			if (!before || before.at <= set.at) landedSets[device] = set;
		}
		return { fires, log, ran, landedSets };
	};

	/** Lands the answers to its claimed steps. */
	const landAnswers = (fire: Fire, held: Pick<State, "log" | "ran">, now: number, retiring: boolean) => {
		let { log, ran } = held;
		let landed = fire;
		const sets: LandedSet[] = [];
		for (const path of claimedPaths(fire)) {
			const ref = { member: fire.member, path };
			if (isRunning(ref)) continue;
			const answer = spent.get(stepKey(ref));
			if (!answer) continue;
			const step = fire.steps[path] as Step;
			if ("hold" in answer.attempt) {
				landed = withStep(landed, path, unsent(step, now));
				continue;
			}
			log = answer.rows.reduce(logged, log);
			const next = heard(step, natureAt(fire, path, retiring), answer.attempt.word, now, windowOf(fire, path));
			landed = withStep(landed, path, next);
			if (!isEnded(next)) continue;
			log = logged(log, endedRow(fire, path, next, answer.reason));
			if (next.verdict !== "done") continue;
			ran = { ...ran, [fire.automation]: fire.at };
			const switched = switchOf(stepAt(fire, path));
			if (switched) sets.push({ member: fire.member, ...switched, at: fire.at });
		}
		return { fire: landed, log, ran, sets };
	};

	/** Why a fire stops; started ones finish pinned. */
	const retireOf = (fire: Fire): RunRow | null => {
		const record = records.get(fire.automation);
		if (!record || record.incarnation !== fire.incarnation)
			return fireRow(fire, "uncertain", "the automation is gone");
		if (!record.body.enabled) return fireRow(fire, "suppressed", SWITCHED_OFF);
		if (!bodyOf(fire)) return fireRow(fire, "suppressed", "the automation changed");
		if (started(fire)) return null;
		if (record.revision !== fire.revision) return fireRow(fire, "suppressed", "the automation changed");
		const issue = bodyIssue(record.body);
		return issue === null ? null : fireRow(fire, "refused", issue);
	};

	/** Function steps replace the call. */
	const enter = (fire: Fire, path: string, call: Call): Fire | { refused: string } => {
		const record = store.get(call.function);
		if (!record || !isFunctionRecord(record))
			return { refused: store.unreadOf(call.function, FUNCTION_KIND) ? FUNCTION_UNREAD : FUNCTION_GONE };
		const frame: Frame = { function: record.id, incarnation: record.incarnation, revision: record.revision };
		const body = bodyOf(fire) as Automation;
		const inner = reached(body, (id) => (id === record.id ? record.body : null)).filter(
			(at) => callSiteOf(at.path) === path,
		);
		const { [path]: _call, ...steps } = fire.steps;
		for (const at of inner) steps[at.path] = FRESH_STEP;
		return { ...fire, steps, active: [], frames: { ...fire.frames, [path]: frame } };
	};

	/** To the step whose turn it is. */
	const advance = (
		start: Fire,
		held: Pick<State, "log">,
		at: {
			now: number;
			home: boolean;
			runnable: Runnable[];
			/** Unread steps. */
			unread: StepRef[];
			tell: (fire: Fire, path: string, action: Tell) => "told" | "full" | "away";
		},
	): { fire: Fire; log: RunRow[] } => {
		let { log } = held;
		let fire = start;
		for (let path = turnOf(fire); path !== null; path = turnOf(fire)) {
			const step = begun(clamped(fire.steps[path] as Step, at.now), at.now);
			fire = { ...withStep(fire, path, step), active: [path] };
			if (step.claimed) return { fire, log };
			const body = bodyOf(fire);
			const call = body && callSiteOf(path) === null ? callAt(body, path) : null;
			if (call) {
				const entered = enter(fire, path, call);
				if (!("refused" in entered)) {
					fire = entered;
					continue;
				}
				const ended = refusedUnsent(step);
				fire = withStep(fire, path, ended);
				log = logged(log, endedRow(fire, path, ended, entered.refused));
				continue;
			}
			const window = windowOf(fire, path);
			const site = callSiteOf(path);
			const action = actionOf(fire, path);
			if (site !== null && !action && writtenStep(fire, path)) {
				at.unread.push({ member: fire.member, path });
				return { fire, log };
			}
			let ended: { step: Step; reason?: string };
			if (site !== null && !action) ended = { step: refusedUnsent(step), reason: FRAME_UNREAD };
			else if (action && isTell(action)) {
				const told = at.tell(fire, path, action);
				if (told === "told") ended = { step: heard(step, null, "done", at.now) };
				else if (told === "away") ended = { step: refusedUnsent(step), reason: NOT_HOME };
				else if (outOfTime(step, at.now, window)) ended = { step: expired(step) };
				else {
					log = logged(log, fireRow(fire, "refused", QUEUE_FULL, "tell_assistant"));
					return { fire, log };
				}
			} else if (!action || !isEffect(action)) ended = { step: refusedUnsent(step) };
			else if (outOfTime(step, at.now, window)) ended = { step: timedOut(step) };
			else if (AUTOMATION_ACTIONS[action.kind].home && !at.home) {
				ended = { step: refusedUnsent(step), reason: NOT_HOME };
			} else {
				// A hold waits unclaimed.
				const ready = deps.actions?.ready(action) ?? true;
				const due = dueAt(step);
				if (ready && due <= at.now) at.runnable.push({ ref: { member: fire.member, path }, dueAt: due });
				return { fire, log };
			}
			fire = withStep(fire, path, ended.step);
			log = logged(log, endedRow(fire, path, ended.step, ended.reason));
		}
		return { fire: { ...fire, active: [] }, log };
	};

	const untold = ({ tell: _tell, waiting: _waiting, ...rest }: Fire): Fire => rest;

	/** `unowned` takes the rest. */
	const droppedRows = (log: RunRow[], dropped: Dropped, now: number, unowned: Fire | null): RunRow[] => {
		let next = log;
		for (const [owner, count] of dropped) {
			const reason = `dropped ${count} older quiet event${count === 1 ? "" : "s"} for room`;
			const by = owner === null ? unowned : { automation: owner, seq: 0, at: now };
			if (by) next = logged(next, fireRow(by, "suppressed", reason, "tell_assistant"));
		}
		return next;
	};

	/** Unused a week, then removed. */
	function sweepFunctions(): void {
		if (stopped) return;
		const now = deps.now();
		const all = store.list();
		const used = new Set(
			all.filter(isAutomationRecord).flatMap((record) => pointerOf(record.body)?.function ?? []),
		);
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
		let { queue, log, ran } = state;
		let fires: Fire[] = [];
		const runnable: Runnable[] = [];
		let queued = false;
		const dropped: Dropped = new Map();
		/** Takes an unowned drop's row. */
		let droppedBy: Fire | null = null;
		/** Retired, awaiting their claim. */
		const retiring = new Set<string>();
		const pass = settle(state.fires, { ...state, log, ran }, now, recovering);
		const { fires: settled, landedSets } = pass;
		({ log, ran } = pass);
		for (const stored of settled) {
			let fire: Fire = stored;
			const retired = retireOf(fire);
			if (retired) {
				// Retired once its effect lands.
				if (holdsClaim(fire)) {
					fires.push(fire);
					retiring.add(fire.member);
				} else if (!finished(fire)) log = logged(log, retired);
				continue;
			}
			const body = bodyOf(fire) as Automation;
			if (fire.tell && !home) {
				log = logged(log, fireRow(fire, "refused", NOT_HOME, "tell_assistant"));
				fire = untold(fire);
			} else if (fire.tell && !fire.tell.fill) {
				const entry = { member: fire.member, when: fire.tell.when, fields: fire.tell.fields };
				const room = told(queue, entry, sentenceOf(body), now);
				if (!room) {
					if (!fire.waiting) log = logged(log, fireRow(fire, "refused", QUEUE_FULL, "tell_assistant"));
					fire = { ...fire, waiting: true };
				} else {
					queue = room.queue;
					for (const [owner, count] of room.dropped) {
						dropped.set(owner, (dropped.get(owner) ?? 0) + count);
						if (owner === null) droppedBy = fire;
					}
					log = logged(log, fireRow(fire, "ran", undefined, "tell_assistant"));
					ran = { ...ran, [fire.automation]: fire.at };
					queued = true;
					fire = untold(fire);
				}
			}
			fires.push(fire);
		}
		const unread: StepRef[] = [];
		const tell = (fire: Fire, path: string, action: Tell): "told" | "full" | "away" => {
			const body = bodyOf(fire);
			if (!home || !body) return "away";
			const message = action.message === undefined ? [] : [action.message];
			const written = writtenStep(fire, path)?.step.args.message;
			const note = written?.kind === "literal" && typeof written.value === "string" ? written.value : null;
			const fields = withMessage(fire.fields ?? {}, message, note !== null && hasHoles(note) ? [note] : []);
			const entry = { member: stepMember(fire.member, path), when: action.when, fields };
			const room = told(queue, entry, sentenceOf(body), now);
			if (!room) return "full";
			queue = room.queue;
			for (const [owner, count] of room.dropped) {
				dropped.set(owner, (dropped.get(owner) ?? 0) + count);
				if (owner === null) droppedBy = fire;
			}
			ran = { ...ran, [fire.automation]: fire.at };
			queued = true;
			return "told";
		};
		const advanced = new Set<string>();
		const turnsOf = (held: Fire[]): Fire[] => {
			const turns = mayRun(held);
			return held.flatMap((found) => {
				let fire = found;
				if (turns.has(fire.member) && !retiring.has(fire.member) && !advanced.has(fire.member)) {
					advanced.add(fire.member);
					({ fire, log } = advance(fire, { log }, { now, home, runnable, unread, tell }));
				}
				return finished(fire) ? [] : [fire];
			});
		};
		// Ended run passes its turn.
		fires = turnsOf(turnsOf(fires));
		log = droppedRows(log, dropped, now, droppedBy);
		const effect = running ? null : nextEffect(runnable);
		if (effect) fires = claim(fires, effect, now);
		const toFill = filling ? null : nextFill(fires);
		const toRead = reading ? null : (unread[0] ?? null);
		const moved: State = { ...state, queue, log, ran, fires, landedSets };
		// An unlanded pass is retried whole, its claim with it.
		if ((unwritten || canonicalJson(moved) !== canonicalJson(state)) && !commit(moved)) return;
		recovering = false;
		unwritten = false;
		for (const [key, { ref }] of [...spent]) {
			const claimed = state.fires.some((held) => held.member === ref.member && held.steps[ref.path]?.claimed);
			if (!claimed) spent.delete(key);
		}
		// The claim's runner registers first.
		if (effect) startEffect(effect);
		if (toFill) startFill(toFill);
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
				running = null;
			},
			true,
		);
		running = { ref, done };
	}

	function startFill(member: string): void {
		const held = heldWork(member);
		if (!held) return;
		filling = launch(
			() => fill(held.fire, held.body),
			() => {
				filling = null;
			},
			false,
		);
	}

	function startRead(ref: StepRef): void {
		const held = heldWork(ref.member);
		if (!held) return;
		reading = launch(
			() => readStep(held.fire, ref),
			() => {
				reading = null;
			},
			false,
		);
	}

	const patched = (member: string, patch: Partial<Fire>): Fire[] =>
		state.fires.map((held) => (held.member === member ? { ...held, ...patch } : held));

	/** Call values over names. */
	const scopeOf = (fire: Fire, at: ReachedStep): FireNames => {
		const body = bodyOf(fire);
		const site = callSiteOf(at.path);
		const call = body && site !== null ? callAt(body, site) : null;
		const fn = site === null ? undefined : fire.frames?.[site];
		const params = fn ? (frameFunction(fn)?.params ?? []) : [];
		const values = call?.values ?? {};
		const scope: FireNames = {};
		for (const param of params) {
			if (!Object.hasOwn(values, param.name)) continue;
			const value = values[param.name];
			const shown = param.type === "device" ? deps.actions?.switchName(String(value)) : null;
			scope[param.name] = shown ? { value, shown } : { value };
		}
		return { ...scope, ...(fire.names ?? {}) };
	};

	/** Read once, at start. */
	/** Another fire set this switch since; a toggle never outdates a toggle. */
	const outdated = (fire: Fire, action: AutomationAction): boolean => {
		const target = isEffect(action) ? switchOf(action) : null;
		const newer = target ? own(state.landedSets, target.device) : undefined;
		return (
			newer !== undefined &&
			newer.member !== fire.member &&
			newer.at > fire.at &&
			!(newer.nature === "nudges" && target?.nature === "nudges")
		);
	};

	async function readStep(fire: Fire, ref: StepRef): Promise<boolean> {
		const rows: RunRow[] = [];
		const at = writtenStep(fire, ref.path);
		let read: { action: AutomationAction } | { refused: string };
		if (!at) read = { refused: FRAME_UNREAD };
		else read = await valuesOf(fire, at, rows);
		const log = rows.reduce(logged, state.log);
		const current = state.fires.find((held) => held.member === ref.member);
		const step = current?.steps[ref.path];
		const site = callSiteOf(ref.path);
		const frame = site === null ? undefined : current?.frames?.[site];
		if (!current || !step || isEnded(step) || !frame || site === null)
			return rows.length > 0 && commit({ ...state, log });
		if (!("refused" in read) && outdated(current, read.action)) read = { refused: NEWER_SET };
		if ("refused" in read) {
			const ended = refusedUnsent(step);
			const fires = patched(ref.member, { steps: { ...current.steps, [ref.path]: ended } });
			return commit({ ...state, fires, log: logged(log, endedRow(current, ref.path, ended, read.refused)) });
		}
		const resolved = { ...frame.resolved, [ref.path]: read.action };
		const fires = patched(ref.member, { frames: { ...current.frames, [site]: { ...frame, resolved } } });
		return commit({ ...state, fires, log });
	}

	/** Holes filled, expressions read. */
	async function valuesOf(
		fire: Fire,
		at: ReachedStep,
		rows: RunRow[],
	): Promise<{ action: AutomationAction } | { refused: string }> {
		const names = scopeOf(fire, at);
		const filled = fillerOf(fire, rows, names);
		const spec = Object.hasOwn(AUTOMATION_ACTIONS, at.kind)
			? AUTOMATION_ACTIONS[at.kind as AutomationAction["kind"]]
			: null;
		const params: readonly AutomationActionParam[] = spec?.params ?? [];
		const raw: Record<string, unknown> = { kind: at.kind };
		for (const [name, arg] of Object.entries(at.step.args)) {
			if (arg.kind === "expression") {
				const value = await evaluated(arg.text, names);
				if (value === null) return { refused: VALUE_UNREAD };
				raw[name] = value.value;
				continue;
			}
			if (typeof arg.value !== "string") {
				raw[name] = arg.value;
				continue;
			}
			const max = params.find((held) => held.name === name && held.kind === "text")?.max;
			const text = await filled(arg.value, at.kind);
			raw[name] = max === undefined ? text : text.slice(0, max);
		}
		const parsed = AutomationActionSchema.safeParse(raw);
		if (!parsed.success || parsed.data.kind === "run_function") return { refused: STEP_UNFIT };
		const issue = isEffect(parsed.data) ? effectIssue(parsed.data, deps.actions) : null;
		return issue === null ? { action: parsed.data } : { refused: issue };
	}

	/** Null on failure. */
	const evaluated = async (source: string, names: FireNames): Promise<{ value: unknown } | null> => {
		try {
			return (await deps.holes?.()?.evaluate(source, names)) ?? null;
		} catch (error) {
			console.error(`[automations] a value read failed: ${errorName(error)}`);
			return null;
		}
	};

	/** Fills a text's holes; a failed hole prints a mark and logs once. */
	const fillerOf = (fire: Fire, rows: RunRow[], names: FireNames = fire.names ?? {}) => {
		const holes = deps.holes?.();
		let threw = false;
		return async (text: string, action: string): Promise<string> => {
			if (!hasHoles(text)) return unescapedText(text);
			if (!holes) {
				rows.push(fireRow(fire, "uncertain", "its holes cannot be read yet", action));
				return unreadText(text);
			}
			let read: Awaited<ReturnType<AutomationHoles["fill"]>>;
			try {
				read = await holes.fill(text, names);
			} catch (error) {
				// A thrown fill gives up.
				console.error(`[automations] a fill failed: ${errorName(error)}`);
				if (!threw) rows.push(fireRow(fire, "uncertain", "its holes could not be read", action));
				threw = true;
				return unreadText(text);
			}
			if (read.failed > 0) {
				rows.push(fireRow(fire, "uncertain", `${read.failed} of its holes could not be read`, action));
			}
			return read.text;
		};
	};

	/** One claimed effect; the pump lands its outcome. */
	async function runOne(fire: Fire, ref: StepRef): Promise<boolean> {
		const rows: RunRow[] = [];
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
		const filled = fillerOf(fire, rows);
		const texts: Record<string, string> = {};
		// Read at start.
		const written = callSiteOf(ref.path) === null ? holeTextsOf([effect]) : [];
		for (const { param, text } of written) {
			const params: readonly AutomationActionParam[] = spec.params;
			const max = params.find((held) => held.name === param)?.max ?? EFFECT_TEXT_MAX;
			texts[param] = (await filled(text, effect.kind)).slice(0, max);
		}
		if (!deps.actions) {
			spent.set(stepKey(ref), { ref, rows, attempt: { word: "refused" }, reason: NO_RUNNER });
			return true;
		}
		const attempt = await runEffect({ ...effect, ...texts }, deps.actions);
		spent.set(stepKey(ref), { ref, rows, attempt });
		return true;
	}

	/** A message's holes; false when nothing moved. */
	async function fill(fire: Fire, body: Automation): Promise<boolean> {
		const rows: RunRow[] = [];
		const filled = fillerOf(fire, rows);
		const written = tellPlan(body).messages;
		const messages: string[] = [];
		for (const message of written) messages.push(await filled(message, "tell_assistant"));
		const log = rows.reduce(logged, state.log);
		// The pump may have withdrawn it.
		const held = state.fires.find((stored) => stored.member === fire.member)?.tell;
		if (!held?.fill) return rows.length > 0 && commit({ ...state, log });
		const tell = { when: held.when, fields: withMessage(held.fields, messages, written) };
		return commit({ ...state, fires: patched(fire.member, { tell }), log });
	}

	/** Outcomes in one write. */
	const landSpent = (): void => {
		const landed = settle(state.fires, state, deps.now(), false);
		const fires = landed.fires.filter((fire) => !finished(fire));
		const next: State = { ...state, log: landed.log, ran: landed.ran, landedSets: landed.landedSets, fires };
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
		const slot = own(state.slots, record.id);
		const lastRanAt = own(state.ran, record.id);
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
			isHome: deps.isHome(),
			issue: (body) => automationIssue(body),
			callIssue,
			copyIdOf: (automationId, from) => derivedFunctionId("copy", automationId, from),
			carryIdOf: (from) => derivedFunctionId("carry", "", from),
			unreadAt: (id) => store.unreadOf(id, AUTOMATION_KIND) || store.unreadOf(id, FUNCTION_KIND),
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

	/** Every row lands, or none. */
	function write(intent: AutomationIntent): AutomationWritten {
		const held = records.list();
		const verdict = judged(intent, held);
		if (verdict.kind === "refused") {
			return {
				written: false,
				reason: verdict.reason,
				refusal: verdict.refusal,
				...(verdict.confirm ? { confirm: verdict.confirm } : {}),
			};
		}
		for (const { id, reason } of verdict.dropped) {
			console.warn(`[automations] ${intent.kind}: ${id} dropped: ${reason}`);
		}
		const result = store.batch(verdict.writes);
		if (!result.stored) {
			return {
				written: false,
				reason: result.reason,
				refusal: storeRefusal(result, verdict.writes[result.at]),
				...(result.record ? { record: result.record } : {}),
				...(result.issue ? { issue: result.issue } : {}),
			};
		}
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

	const storeRefusal = (
		refusal: Extract<OwnerBatchResult<StoredBody>, { stored: false }>,
		write: OwnerWrite | undefined,
	): AutomationSaveRefusal => {
		const kind = write?.op === "put" ? write.kind : (store.get(write?.id ?? "")?.kind ?? AUTOMATION_KIND);
		const record = kind === FUNCTION_KIND ? "function" : "automation";
		const { cause } = refusal;
		if (typeof cause === "object") {
			if (cause.cap === TOTAL_CAP) return { code: "full", max: cause.max };
			return { code: "full", kind: cause.cap === FUNCTION_KIND ? "function" : "automation", max: cause.max };
		}
		switch (cause) {
			case "invalid": {
				const hole = holeSpanOf(refusal.issue);
				if (hole)
					return {
						code: "hole",
						record,
						path: String(hole.action),
						param: hole.param,
						start: hole.start,
						end: hole.end,
					};
				const { issue } = refusal;
				if (!issue) return { code: "invalid", record, line: refusal.reason.slice(0, SAVE_LINE_MAX) };
				const path = issue.path.join(".");
				return issue.code === STEP_ISSUE_CODE
					? { code: "invalid", record, path, line: issue.message.slice(0, SAVE_LINE_MAX) }
					: { code: "invalid", record, path };
			}
			case "moved":
				return refusal.record
					? { code: "moved", record, revision: refusal.record.revision }
					: { code: "moved", record };
			case "newer_build":
				return record === "function"
					? { code: "newer_function", record, ...(write ? { id: write.id } : {}) }
					: { code: "newer_automation", ...(write ? { id: write.id } : {}) };
			case "spent":
				return { code: "invalid", record, path: "revision" };
			case "bad_id":
				return { code: "invalid", record, path: "id" };
			case "absent":
			case "removed":
				return { code: "gone", record };
			case "unsaved":
				return { code: "unwritten", record };
		}
	};

	/** One read; unused functions unlisted. */
	const listing = (): { automations: AutomationRow[]; functions: AutomationFunctionRow[] } => {
		const all = store.list();
		const automations = all.filter(isAutomationRecord);
		const functions = all.filter(isFunctionRecord).flatMap((record) => {
			const users = automations.filter((held) => pointerOf(held.body)?.function === record.id);
			if (users.length === 0) return [];
			const invalid = store.invalidOf(record.id);
			const reads = functionReads(record.body);
			return [
				{
					id: record.id,
					revision: record.revision,
					function: record.body,
					users: users.map((held) => held.id),
					moves: users.some((held) => movesWithHome(held.body)),
					reads: { names: [...reads.names], eventFields: [...reads.eventFields] },
					...(invalid === null ? {} : { invalid }),
				},
			];
		});
		return { automations: automations.map(rowOf), functions };
	};

	/** Both rows from one read. */
	function saveOp(op: Omit<Extract<ConsoleOp, { kind: "automation_save" }>, "kind">): ConsoleAutomationSaveResult {
		const saved = save({
			id: op.automationId,
			body: op.automation,
			base: op.automationBase,
			...(op.function ? { function: op.function } : {}),
			confirmed: op.confirmed === true,
		});
		if (!saved.stored) return { stored: false, refusal: saved.refusal };
		const listed = listing();
		const row = listed.automations.find((held) => held.id === saved.automation.id);
		const pointer = pointerOf(saved.automation.body);
		const fn = pointer ? listed.functions.find((held) => held.id === pointer.function) : undefined;
		return { stored: true, ...(row ? { automation: row } : {}), ...(fn ? { function: fn } : {}) };
	}

	function save(intent: Omit<Extract<AutomationIntent, { kind: "save" }>, "kind">): AutomationSaved {
		const result = write({ kind: "save", ...intent });
		if (!result.written) return { stored: false, refusal: result.refusal, reason: result.reason };
		const automation = result.records.find((record) => record?.id === intent.id);
		const fn = result.records.find((record) => record !== null && isFunctionRecord(record));
		if (!automation || !isAutomationRecord(automation))
			return { stored: false, refusal: { code: "gone", record: "automation" }, reason: "not saved; try again" };
		return { stored: true, automation, ...(fn && isFunctionRecord(fn) ? { function: fn } : {}) };
	}

	drain();
	tick();

	return {
		list: () => records.list(),
		/** Null when not held. */
		functionOf,
		rows: (): AutomationRow[] => records.list().map(rowOf),
		listing,
		saveOp,
		write,
		/** Why `write` would refuse it; writes nothing. */
		refusalOf(intent: AutomationIntent): { reason: string; full: boolean } | null {
			const verdict = judged(intent, records.list());
			if (verdict.kind === "refused") return { reason: verdict.reason, full: false };
			const refused = store.refusalOf(verdict.writes);
			return refused ? { reason: refused.reason, full: typeof refused.cause === "object" } : null;
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
				...(!result.written && holeSpanOf(result.issue) ? { hole: holeSpanOf(result.issue) } : {}),
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
				const runs = hasSteps(record.body) || tellPlan(record.body).when !== null;
				if (!runs || fired.includes(member)) continue;
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
				})
			)
				pump();
			else console.warn(`[automations] ${lost} event fires were not recorded and will not run`);
		},
		/** Resolves when idle. */
		async settled(): Promise<void> {
			while (running || filling || reading) await Promise.all([running?.done, filling, reading]);
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
		/** Current trigger names; throws what a put would. */
		namesNow(trigger: Exclude<AutomationTrigger, EventTrigger>): FireNames {
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
		},
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
			while (running || filling || reading) await Promise.all([running?.done, filling, reading]);
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
		eventsOf(sourceId: string): { id: string; trigger: EventTrigger; when: TellWhen | null }[] {
			return records.list().flatMap((record) => {
				const { trigger } = record.body;
				if (trigger.kind !== "event" || trigger.source !== sourceId || !armed(record)) return [];
				return [{ id: record.id, trigger, when: laneTellWhen(record.body) }];
			});
		},
		log: (): readonly RunRow[] => state.log,
		checkpoint: (id: string) => own(state.automations, id) ?? null,
		queued: () => state.queue,
		outbox,
	};
}

export type Automations = ReturnType<typeof createAutomations>;
