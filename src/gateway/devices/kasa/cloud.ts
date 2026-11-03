import { DeviceDriverFailure, withLanded } from "../driver.js";

type JsonRecord = Record<string, unknown>;
type KasaCommand = (module: string, name: string, args: JsonRecord) => Promise<JsonRecord>;
type CloudMutation = (name: "unbind" | "set_server_url", args: JsonRecord) => Promise<JsonRecord>;

function flag(value: unknown): boolean | null {
	if (value === true || value === 1 || value === "1") return true;
	if (value === false || value === 0 || value === "0") return false;
	return null;
}

export function cloudBound(info: JsonRecord): boolean {
	const boundField = flag(info.binded ?? info.cloud_binded);
	return (
		boundField ??
		Boolean(
			(typeof info.username === "string" && info.username.length > 0) ||
				(typeof info.server === "string" && info.server.length > 0 && info.server !== "0.0.0.0"),
		)
	);
}

export function getCloudInfo(command: KasaCommand): Promise<JsonRecord> {
	return command("cnCloud", "get_info", {});
}

export async function disconnectCloud(command: KasaCommand, mutate: CloudMutation): Promise<void> {
	const info = await getCloudInfo(command);
	const server = typeof info.server === "string" ? info.server : "";
	await mutate("unbind", {});
	if (server.length === 0) return;
	const unbound = { done: 1, total: 2 };
	try {
		await mutate("set_server_url", { server: "" });
	} catch (error) {
		if (!(error instanceof DeviceDriverFailure) || error.failure.kind !== "refused")
			throw withLanded(error, unbound);
		try {
			await mutate("set_server_url", { server: "0.0.0.0" });
		} catch (second) {
			throw withLanded(second, unbound);
		}
	}
}
