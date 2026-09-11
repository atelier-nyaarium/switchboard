import { describe, expect, it } from "vitest";
import { createAddressing } from "../gateway/routes/addressing.js";
import { DEFAULT_SESSION } from "../shared/session-id.js";

const addressing = createAddressing({ config: { localGatewayId: "gw", localDomainId: "home" } });

describe("the MCP door's local grammar", () => {
	it("fills this Gateway's Domain and id into a local field, and keeps a qualified address as given", () => {
		expect(addressing.localAddress("app.dev").canonical).toBe("home.gw.app.dev");
		expect(addressing.localAddress("app").canonical).toBe(`home.gw.app.${DEFAULT_SESSION}`);
		expect(addressing.resolveLocalTarget("app.dev")).toMatchObject({ name: "app.dev" });
		expect(addressing.resolveLocalTarget("home.gw.app.dev")).toMatchObject({ name: "app.dev" });
	});

	it("resolves nothing for a spawn point or a session on another Gateway or Domain", () => {
		expect(addressing.resolveLocalTarget("app")).toBeNull();
		expect(addressing.resolveLocalTarget("home.gw.app")).toBeNull();
		expect(addressing.resolveLocalTarget("home.other.app.dev")).toBeNull();
		expect(addressing.resolveLocalTarget("away.gw.app.dev")).toBeNull();
		expect(addressing.tryLocalAddress("not a slug")).toBeNull();
	});
});
