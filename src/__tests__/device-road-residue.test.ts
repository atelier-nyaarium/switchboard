import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the device road is the only way to a store or a driver", () => {
	it("keeps the stage off the store and the drivers", () => {
		const source = fs.readFileSync(path.join(REPO_ROOT, "src/gateway/compose/composeDevices.ts"), "utf8");
		expect(source).not.toMatch(/openDeviceStore|createKasaDriver|\bcatch\s*[({]/);
	});

	it("routes both reading handlers through the road", () => {
		const devices = fs.readFileSync(path.join(REPO_ROOT, "src/gateway/compose/composeDevices.ts"), "utf8");
		const sockets = fs.readFileSync(path.join(REPO_ROOT, "src/gateway/compose/composeWebSockets.ts"), "utf8");
		const websocket = fs.readFileSync(path.join(REPO_ROOT, "src/gateway/websocket.ts"), "utf8");
		const gateway = fs.readFileSync(path.join(REPO_ROOT, "src/gateway/composeGateway.ts"), "utf8");

		expect(devices).toMatch(/const ingest = .*road\.ingest\(mac, advert, at, radio\)/s);
		expect(devices).toMatch(/ingestGatewayAdvert = .*ingest\(mac, advert, at, "gateway"\)/s);
		expect(devices).toMatch(/device_reading_post: .*ingest\(op\.id, op\.advert, op\.at, "phones"\)/s);
		expect(devices).not.toMatch(/createReadingsHold|readingsHold/);
		expect(sockets).toMatch(/ingestDeviceAdvertFromCurrentHost/);
		expect(websocket).toMatch(/DeviceAdvertFrameSchema\.safeParse/);
		expect(gateway).toMatch(/devices\?\.ingestGatewayAdvert/);
	});
});
