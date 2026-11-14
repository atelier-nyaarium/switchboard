import { z } from "zod";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import { type TemperatureUnit, TemperatureUnitSchema } from "../../shared/schemasAssistant.js";

const SnapshotSchema = z.object({ v: z.literal(1), temperatureUnit: TemperatureUnitSchema });

export function createTemperatureUnitStore(store: Pick<DurableStore, "load" | "saveChecked">) {
	const loaded = SnapshotSchema.safeParse(store.load());
	let temperatureUnit: TemperatureUnit = loaded.success ? loaded.data.temperatureUnit : "C";
	return {
		temperatureUnit: (): TemperatureUnit => temperatureUnit,
		set: (next: TemperatureUnit): boolean =>
			commitChecked(
				store,
				{ v: 1, temperatureUnit: next },
				() => {
					temperatureUnit = next;
				},
				{ label: "assistant temperature unit" },
			).landed,
	};
}

export type TemperatureUnitStore = ReturnType<typeof createTemperatureUnitStore>;
