import type { DeviceRecord } from "../../../shared/schemasDevices.js";
import { DeviceSettingPutSchema, DeviceSettingsSchema, normalizeDeviceMac } from "../../../shared/schemasDevices.js";
import {
	type DeviceConfirmedState,
	type DeviceDriver,
	DeviceDriverFailure,
	type DeviceOperationContext,
	type DeviceReadAnswer,
	type DeviceSchedule,
	type DeviceSetting,
	type DeviceSettings,
} from "../driver.js";
import { cloudBound, disconnectCloud, getCloudInfo } from "./cloud.js";
import { deviceSchedule, putSchedule, rulesFromAnswer } from "./schedule.js";
import { createKasaTransport, type KasaTransport } from "./transport.js";

type JsonRecord = Record<string, unknown>;

const TIMEZONE_NAMES = [
	"Etc/GMT+12",
	"Pacific/Samoa",
	"US/Hawaii",
	"US/Alaska",
	"Mexico/BajaNorte",
	"Etc/GMT+8",
	"PST8PDT",
	"US/Arizona",
	"America/Mazatlan",
	"MST",
	"MST7MDT",
	"Mexico/General",
	"Etc/GMT+6",
	"CST6CDT",
	"America/Monterrey",
	"Canada/Saskatchewan",
	"America/Bogota",
	"Etc/GMT+5",
	"America/New_York",
	"America/Indiana/Indianapolis",
	"America/Caracas",
	"America/Asuncion",
	"Etc/GMT+4",
	"Canada/Atlantic",
	"America/Cuiaba",
	"Brazil/West",
	"America/Santiago",
	"Canada/Newfoundland",
	"America/Sao_Paulo",
	"America/Argentina/Buenos_Aires",
	"America/Cayenne",
	"America/Miquelon",
	"America/Montevideo",
	"Chile/Continental",
	"Etc/GMT+2",
	"Atlantic/Azores",
	"Atlantic/Cape_Verde",
	"Africa/Casablanca",
	"UCT",
	"GB",
	"Africa/Monrovia",
	"Europe/Amsterdam",
	"Europe/Belgrade",
	"Europe/Brussels",
	"Europe/Sarajevo",
	"Africa/Lagos",
	"Africa/Windhoek",
	"Asia/Amman",
	"Europe/Athens",
	"Asia/Beirut",
	"Africa/Cairo",
	"Asia/Damascus",
	"EET",
	"Africa/Harare",
	"Europe/Helsinki",
	"Asia/Istanbul",
	"Asia/Jerusalem",
	"Europe/Kaliningrad",
	"Africa/Tripoli",
	"Asia/Baghdad",
	"Asia/Kuwait",
	"Europe/Minsk",
	"Europe/Moscow",
	"Africa/Nairobi",
	"Asia/Tehran",
	"Asia/Muscat",
	"Asia/Baku",
	"Europe/Samara",
	"Indian/Mauritius",
	"Asia/Tbilisi",
	"Asia/Yerevan",
	"Asia/Kabul",
	"Asia/Ashgabat",
	"Asia/Yekaterinburg",
	"Asia/Karachi",
	"Asia/Kolkata",
	"Asia/Colombo",
	"Asia/Kathmandu",
	"Asia/Almaty",
	"Asia/Dhaka",
	"Asia/Novosibirsk",
	"Asia/Rangoon",
	"Asia/Bangkok",
	"Asia/Krasnoyarsk",
	"Asia/Chongqing",
	"Asia/Irkutsk",
	"Asia/Singapore",
	"Australia/Perth",
	"Asia/Taipei",
	"Asia/Ulaanbaatar",
	"Asia/Tokyo",
	"Asia/Seoul",
	"Asia/Yakutsk",
	"Australia/Adelaide",
	"Australia/Darwin",
	"Australia/Brisbane",
	"Australia/Canberra",
	"Pacific/Guam",
	"Australia/Hobart",
	"Antarctica/DumontDUrville",
	"Asia/Magadan",
	"Asia/Srednekolymsk",
	"Etc/GMT-11",
	"Asia/Anadyr",
	"Pacific/Auckland",
	"Etc/GMT-12",
	"Pacific/Fiji",
	"Etc/GMT-13",
	"Pacific/Apia",
	"Etc/GMT-14",
] as const;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failUnreachable(detail: string): never {
	throw new DeviceDriverFailure({ kind: "unreachable", detail });
}

function refuse(code: number, message: string): never {
	throw new DeviceDriverFailure({ kind: "refused", code, message });
}

function errorMessage(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : "Kasa refused the command";
}

function codeOf(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function responseBody(response: unknown, module: string, name: string): JsonRecord {
	if (!isRecord(response) || !isRecord(response[module])) failUnreachable(`Kasa omitted the ${module} response`);
	const section = response[module];
	const moduleCode = codeOf(section.err_code);
	if (moduleCode !== null && moduleCode !== 0) refuse(moduleCode, errorMessage(section.err_msg));
	const answer = section[name];
	if (!isRecord(answer)) failUnreachable(`Kasa omitted ${module}.${name}`);
	const answerCode = codeOf(answer.err_code);
	if (answerCode !== null && answerCode !== 0) refuse(answerCode, errorMessage(answer.err_msg));
	return answer;
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

function clockNumber(record: JsonRecord, key: string): number {
	const value = numberField(record, key);
	if (value === null || !Number.isInteger(value)) failUnreachable(`Kasa clock omitted ${key}`);
	return value;
}

function padded(value: number): string {
	return String(value).padStart(2, "0");
}

function zoneOffset(timeZone: string, epoch: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(epoch));
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const localAsUtc = Date.UTC(
		Number(values.year),
		Number(values.month) - 1,
		Number(values.day),
		Number(values.hour),
		Number(values.minute),
		Number(values.second),
	);
	return localAsUtc - epoch;
}

function clockValue(time: JsonRecord, timezone: JsonRecord): { time: string; zone: string } {
	const year = clockNumber(time, "year");
	const month = clockNumber(time, "month");
	const day = clockNumber(time, "mday");
	const hour = clockNumber(time, "hour");
	const minute = clockNumber(time, "min");
	const second = clockNumber(time, "sec");
	const index = numberField(timezone, "index");
	const zone =
		(typeof timezone.timezone === "string" && timezone.timezone) ||
		(typeof timezone.zone === "string" && timezone.zone) ||
		(index !== null && index >= 0 && index < TIMEZONE_NAMES.length ? TIMEZONE_NAMES[index] : "Etc/UTC");
	const wallEpoch = Date.UTC(year, month - 1, day, hour, minute, second);
	let offset = 0;
	try {
		offset = zoneOffset(zone, wallEpoch);
		offset = zoneOffset(zone, wallEpoch - offset);
	} catch {
		offset = 0;
	}
	const sign = offset < 0 ? "-" : "+";
	const absOffsetMinutes = Math.abs(Math.trunc(offset / 60_000));
	const offsetText = `${sign}${padded(Math.floor(absOffsetMinutes / 60))}:${padded(absOffsetMinutes % 60)}`;
	const iso = `${String(year).padStart(4, "0")}-${padded(month)}-${padded(day)}T${padded(hour)}:${padded(minute)}:${padded(second)}${offsetText}`;
	return { time: iso, zone };
}

function normalizeSysinfo(info: JsonRecord): JsonRecord {
	return isRecord(info.system) ? info.system : info;
}

function stateFromSysinfo(info: JsonRecord): "on" | "off" {
	const relay = flag(info.relay_state);
	if (relay === null) failUnreachable("Kasa system info omitted relay_state");
	return relay ? "on" : "off";
}

function sysinfoMac(info: JsonRecord): string {
	if (typeof info.mac !== "string") failUnreachable("Kasa system info omitted its MAC address");
	const mac = normalizeDeviceMac(info.mac);
	if (!mac) failUnreachable("Kasa returned an invalid MAC address");
	return mac;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "Kasa request failed";
}

export function createKasaDriver(options: { transport?: KasaTransport; port?: number } = {}): DeviceDriver {
	const transport = options.transport ?? createKasaTransport(options.port);

	const command = async (
		address: string,
		module: string,
		name: string,
		args: JsonRecord,
		signal: AbortSignal,
	): Promise<JsonRecord> => {
		try {
			const response = await transport.request(address, { [module]: { [name]: args } }, signal);
			return responseBody(response, module, name);
		} catch (error) {
			if (error instanceof DeviceDriverFailure) throw error;
			throw new DeviceDriverFailure({ kind: "unreachable", detail: messageOf(error) });
		}
	};

	const sysinfo = (address: string, signal: AbortSignal) =>
		command(address, "system", "get_sysinfo", {}, signal).then(normalizeSysinfo);

	const identifyInfo = async (record: DeviceRecord, ctx: DeviceOperationContext): Promise<JsonRecord> => {
		const info = await sysinfo(record.address, ctx.signal);
		const actual = sysinfoMac(info);
		if (actual !== record.id) {
			throw new DeviceDriverFailure({
				kind: "unreachable",
				detail: `Kasa identity mismatch at ${record.address}: expected ${record.id}, received ${actual}`,
			});
		}
		return info;
	};

	const mutateWithIdentity = async <T>(
		record: DeviceRecord,
		module: string,
		name: string,
		build: (identity: JsonRecord) => { args: JsonRecord; value: T },
		ctx: DeviceOperationContext,
	): Promise<{ response: JsonRecord; value: T }> => {
		const identity = await identifyInfo(record, ctx);
		const mutation = build(identity);
		ctx.effect.mark();
		let response: JsonRecord;
		try {
			response = await command(record.address, module, name, mutation.args, ctx.signal);
		} catch (error) {
			if (error instanceof DeviceDriverFailure) {
				const failure = error.failure;
				if (failure.kind === "refused" || failure.sent === false) ctx.effect.none();
			}
			throw error;
		}
		return { response, value: mutation.value };
	};

	const mutate = async (
		record: DeviceRecord,
		module: string,
		name: string,
		args: JsonRecord,
		ctx: DeviceOperationContext,
	): Promise<JsonRecord> => {
		return (await mutateWithIdentity(record, module, name, () => ({ args, value: undefined }), ctx)).response;
	};

	const readScheduleVerified = async (record: DeviceRecord, ctx: DeviceOperationContext) => {
		const answer = await command(record.address, "schedule", "get_rules", {}, ctx.signal);
		return deviceSchedule(answer, rulesFromAnswer(answer));
	};

	const readSettingsVerified = async (
		record: DeviceRecord,
		ctx: DeviceOperationContext,
		info: JsonRecord,
	): Promise<DeviceSettings> => {
		const ledOff = flag(info.led_off);
		if (ledOff === null) failUnreachable("Kasa system info omitted led_off");
		const time = await command(record.address, "time", "get_time", {}, ctx.signal);
		const timezone = await command(record.address, "time", "get_timezone", {}, ctx.signal);
		const cloud = await getCloudInfo((module, name, args) =>
			command(record.address, module, name, args, ctx.signal),
		);
		const clock = clockValue(time, timezone);
		const parsed = DeviceSettingsSchema.safeParse({
			driver: "kasa",
			led: !ledOff,
			clock,
			cloud: cloudBound(cloud) ? "bound" : "disconnected",
		});
		if (!parsed.success) failUnreachable("Kasa returned invalid settings");
		return parsed.data;
	};

	const readSettings = async (record: DeviceRecord, ctx: DeviceOperationContext): Promise<DeviceSettings> => {
		const info = await identifyInfo(record, ctx);
		return readSettingsVerified(record, ctx, info);
	};

	const scheduleAccess = (record: DeviceRecord, ctx: DeviceOperationContext) => ({
		read: async () => {
			await identifyInfo(record, ctx);
			return readScheduleVerified(record, ctx);
		},
		put: async (schedule: DeviceSchedule) => {
			await identifyInfo(record, ctx);
			return putSchedule(schedule, {
				signal: ctx.signal,
				getRules: () => command(record.address, "schedule", "get_rules", {}, ctx.signal),
				mutate: (name, args) => mutate(record, "schedule", name, args, ctx),
				readBack: async () => {
					await identifyInfo(record, ctx);
					return readScheduleVerified(record, ctx);
				},
			});
		},
	});

	const settingsAccess = (record: DeviceRecord, ctx: DeviceOperationContext) => ({
		read: () => readSettings(record, ctx),
		put: async (setting: DeviceSetting) => {
			const checked = DeviceSettingPutSchema.safeParse(setting);
			if (!checked.success || checked.data.driver !== "kasa")
				refuse(-1, "The setting is invalid for this device");
			const put = checked.data.setting;
			if (put.key === "cloud" && put.value === "bound") {
				refuse(-1, "The Kasa app binds a plug");
			}
			await identifyInfo(record, ctx);
			if (put.key === "led") {
				await mutate(record, "system", "set_led_off", { off: put.value ? 0 : 1 }, ctx);
			} else {
				await disconnectCloud(
					(module, name, args) => command(record.address, module, name, args, ctx.signal),
					(name, args) => mutate(record, "cnCloud", name, args, ctx),
				);
			}
			return readSettings(record, ctx);
		},
	});

	return {
		kinds: () => ["switch"],
		identify: async (address, ctx) => sysinfoMac(await sysinfo(address, ctx.signal)),
		read: async (record, ctx): Promise<DeviceReadAnswer> => {
			const info = await identifyInfo(record, ctx);
			const state = stateFromSysinfo(info);
			const schedule = await readScheduleVerified(record, ctx);
			return { state: { state, readAt: ctx.ambient.now() }, schedule };
		},
		set: async (record, verb, ctx): Promise<DeviceConfirmedState> => {
			const { value: desired } = await mutateWithIdentity(
				record,
				"system",
				"set_relay_state",
				(identity) => {
					const current = stateFromSysinfo(identity);
					const target = verb === "toggle" ? (current === "on" ? "off" : "on") : verb;
					return { args: { state: target === "on" ? 1 : 0 }, value: target };
				},
				ctx,
			);
			const confirmedInfo = await identifyInfo(record, ctx);
			const confirmed = stateFromSysinfo(confirmedInfo);
			if (confirmed !== desired) failUnreachable(`Kasa answered ${confirmed} after a request to set ${desired}`);
			return { state: confirmed, readAt: ctx.ambient.now() };
		},
		rename: async (record, name, ctx) => {
			const { value: previous } = await mutateWithIdentity(
				record,
				"system",
				"set_dev_alias",
				(identity) => ({
					args: { alias: name },
					value: typeof identity.alias === "string" ? identity.alias : null,
				}),
				ctx,
			);
			return { previous };
		},
		schedule: scheduleAccess,
		settings: settingsAccess,
	} satisfies DeviceDriver;
}

export const kasaDriver = createKasaDriver();
