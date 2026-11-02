import { DeviceScheduleSchema } from "../../../shared/schemasDevices.js";
import { DeviceDriverFailure, type DeviceSchedule, noteLanding } from "../driver.js";

type JsonRecord = Record<string, unknown>;
type KasaRule = JsonRecord;

function failUnreachable(detail: string): never {
	throw new DeviceDriverFailure({ kind: "unreachable", detail });
}

function refuse(code: number, message: string): never {
	throw new DeviceDriverFailure({ kind: "refused", code, message });
}

function numberField(record: JsonRecord, key: string): number | null {
	const value = record[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
	return null;
}

function flag(value: unknown): boolean | null {
	if (value === true || value === 1 || value === "1") return true;
	if (value === false || value === 0 || value === "0") return false;
	return null;
}

function padded(value: number): string {
	return String(value).padStart(2, "0");
}

function timeText(minutes: number): string {
	return `${padded(Math.floor(minutes / 60))}:${padded(minutes % 60)}`;
}

/** Unrepresentable rules stay untouched. */
function representableRule(rule: KasaRule): boolean {
	return scheduleRule(rule) !== null;
}

function scheduleRule(rule: KasaRule): DeviceSchedule["rules"][number] | null {
	if (numberField(rule, "stime_opt") !== 0 || numberField(rule, "repeat") !== 1) return null;
	const endOption = numberField(rule, "etime_opt");
	if (endOption !== null && endOption !== -1) return null;
	const smin = numberField(rule, "smin");
	const action = numberField(rule, "sact");
	const enabled = flag(rule.enable);
	if (
		smin === null ||
		!Number.isInteger(smin) ||
		smin < 0 ||
		smin >= 1440 ||
		(action !== 0 && action !== 1) ||
		enabled === null ||
		!Array.isArray(rule.wday) ||
		rule.wday.length !== 7 ||
		!rule.wday.every((day) => day === 0 || day === 1)
	) {
		return null;
	}
	return {
		...(typeof rule.id === "string" ? { id: rule.id } : {}),
		days: rule.wday.map((day) => day === 1),
		time: timeText(smin),
		action: action === 1 ? "on" : "off",
		enabled,
	};
}

export function rulesFromAnswer(answer: JsonRecord): KasaRule[] {
	const raw = answer.rule_list ?? answer.rules;
	if (!Array.isArray(raw) || !raw.every(isRecord)) failUnreachable("Kasa schedule response omitted its rule list");
	return raw;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deviceSchedule(answer: JsonRecord, rules: KasaRule[]): DeviceSchedule {
	const overall = flag(answer.enable ?? answer.overall_enable);
	if (overall === null) failUnreachable("Kasa schedule response omitted its overall enable state");
	const parsed = DeviceScheduleSchema.safeParse({
		enabled: overall,
		rules: rules.map(scheduleRule).filter((rule) => rule !== null),
	});
	if (!parsed.success) failUnreachable("Kasa returned an invalid schedule");
	return parsed.data;
}

function ruleMinutes(value: string): number {
	const [hour, minute] = value.split(":").map(Number);
	return hour! * 60 + minute!;
}

function kasaRule(rule: DeviceSchedule["rules"][number], name: string): KasaRule {
	return {
		stime_opt: 0,
		wday: rule.days.map((day) => (day ? 1 : 0)),
		smin: ruleMinutes(rule.time),
		enable: rule.enabled ? 1 : 0,
		repeat: 1,
		etime_opt: -1,
		name,
		eact: -1,
		sact: rule.action === "on" ? 1 : 0,
		month: 0,
		year: 0,
		day: 0,
		longitude: 0,
		force: 0,
		latitude: 0,
		emin: 0,
	};
}

export type ScheduleMutation = {
	name: "edit_rule" | "delete_rule" | "add_rule" | "set_overall_enable";
	args: JsonRecord;
};

export function reconcileSchedule(schedule: DeviceSchedule, current: KasaRule[]): ScheduleMutation[] {
	const editable = current.filter(representableRule);
	const existing = new Map(
		editable.flatMap((rule) => (typeof rule.id === "string" ? [[rule.id, rule] as const] : [])),
	);
	const retainedIds = new Set(schedule.rules.flatMap((rule) => (rule.id && existing.has(rule.id) ? [rule.id] : [])));
	const matchedIdless = new Set<number>();
	const mutations: ScheduleMutation[] = [];
	for (const rule of schedule.rules) {
		if (!rule.id || !existing.has(rule.id)) continue;
		const prior = existing.get(rule.id)!;
		const priorName = typeof prior.name === "string" ? prior.name : `Switchboard ${rule.id}`;
		mutations.push({
			name: "edit_rule",
			args: { ...kasaRule(rule, priorName), id: rule.id },
		});
	}
	for (const [index, rule] of schedule.rules.entries()) {
		if (rule.id) continue;
		const match = editable.find((candidate) => {
			if (typeof candidate.id !== "string" || retainedIds.has(candidate.id)) return false;
			const parsed = scheduleRule(candidate);
			if (parsed === null) return false;
			return (
				parsed.days.every((day, dayIndex) => day === rule.days[dayIndex]) &&
				parsed.time === rule.time &&
				parsed.action === rule.action &&
				parsed.enabled === rule.enabled
			);
		});
		if (match && typeof match.id === "string") {
			retainedIds.add(match.id);
			matchedIdless.add(index);
		}
	}
	for (const rule of editable) {
		if (typeof rule.id === "string" && !retainedIds.has(rule.id)) {
			mutations.push({ name: "delete_rule", args: { id: rule.id } });
		}
	}
	for (const [index, rule] of schedule.rules.entries()) {
		if (rule.id && existing.has(rule.id)) continue;
		if (!rule.id && matchedIdless.has(index)) continue;
		mutations.push({
			name: "add_rule",
			args: kasaRule(rule, `Switchboard ${index + 1}`),
		});
	}
	mutations.push({
		name: "set_overall_enable",
		args: { enable: schedule.enabled ? 1 : 0 },
	});
	return mutations;
}

export async function putSchedule(
	schedule: DeviceSchedule,
	io: {
		signal?: AbortSignal;
		getRules(): Promise<JsonRecord>;
		mutate(name: ScheduleMutation["name"], args: JsonRecord): Promise<JsonRecord>;
		readBack(): Promise<DeviceSchedule>;
	},
): Promise<DeviceSchedule> {
	const checked = DeviceScheduleSchema.safeParse(schedule);
	if (!checked.success) refuse(-1, "The schedule is invalid for this device");
	const answer = await io.getRules();
	const mutations = reconcileSchedule(checked.data, rulesFromAnswer(answer));
	let landed = 0;
	for (const mutation of mutations) {
		if (io.signal?.aborted) {
			throw withLanding(
				new DeviceDriverFailure({
					kind: "timeout",
					detail: "Kasa operation ended before the command was sent",
					sent: false,
				}),
				landed,
				mutations.length,
			);
		}
		try {
			await io.mutate(mutation.name, mutation.args);
			landed += 1;
		} catch (error) {
			throw withLanding(error, landed, mutations.length);
		}
	}
	try {
		return await io.readBack();
	} catch (error) {
		throw withLanding(error, landed, mutations.length);
	}
}

function withLanding(error: unknown, landed: number, total: number): unknown {
	return noteLanding(error, `${landed} of ${total} mutations landed; a devices read shows the plug's state`);
}
