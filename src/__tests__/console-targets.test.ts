import { describe, expect, it } from "vitest";
import { createConsoleTargets } from "../gateway/console/consoleTargets.js";
import { BOARD_REFUSED_PREFIX } from "../shared/board-authority.js";
import { DEFAULT_SESSION } from "../shared/session-id.js";

const targets = createConsoleTargets({
	localDomainId: "home",
	localGatewayId: "gw",
	isTrustedCatalogProject: (name) => name === "recipe-app",
});
const FOREIGN = "other.gw.app.dev";

describe("createConsoleTargets", () => {
	it("refuses the colliding-gateway foreign shape at every local-gated method", () => {
		expect(() => targets.boardSessionKey(FOREIGN)).toThrow(`${BOARD_REFUSED_PREFIX}session_missing`);
		expect(() => targets.requireLocalComposite(FOREIGN, "forget")).toThrow("another Gateway");
		expect(() => targets.localSpawn(FOREIGN)).toThrow("another Gateway");
		expect(() => targets.tmuxTarget(FOREIGN)).toThrow("another Gateway");
	});

	it("parse alone passes a foreign address through, for the ops that route cross-Gateway", () => {
		const t = targets.parse(FOREIGN);
		expect(t.domain).toBe("other");
		expect(t.gateway).toBe("gw");
	});

	it("refuses a bare name at every method, so nothing resolves it onto this Gateway", () => {
		for (const bare of ["app.dev", "app"]) {
			expect(() => targets.parse(bare)).toThrow("unqualified");
			expect(() => targets.boardSessionKey(bare)).toThrow("unqualified");
			expect(() => targets.requireLocalComposite(bare, "close")).toThrow("unqualified");
			expect(() => targets.tmuxTarget(bare)).toThrow("unqualified");
			expect(targets.tryLocalName(bare)).toBeNull();
		}
	});

	it("resolves a qualified local name to the bare key the board stores", () => {
		expect(targets.boardSessionKey("home.gw.app.dev")).toBe("app.dev");
		expect(targets.boardSessionKey("home.gw.app")).toBe(`app.${DEFAULT_SESSION}`);
		expect(targets.tryLocalName("home.gw.app.dev")).toBe("app.dev");
	});

	it("checks foreign before spawn-point, so a foreign spawn-point hears the refusal no session name could fix", () => {
		expect(() => targets.requireLocalComposite("other.gw.app", "close")).toThrow("another Gateway");
		expect(() => targets.requireLocalComposite("home.gw.app", "close")).toThrow("spawn-point");
	});

	it("resolves tmux targets by kind and refuses what has no pane", () => {
		expect(targets.tmuxTarget("home.gw.host.abc")).toEqual({ kind: "host", name: "host", sessionName: "abc" });
		expect(targets.tmuxTarget("home.gw.recipe-app.dev")).toEqual({
			kind: "devcontainer",
			name: "recipe-app",
			sessionName: "dev",
		});
		expect(() => targets.tmuxTarget("home.gw.stranger.dev")).toThrow("only the host and devcontainers");
	});

	it("does not classify a name known only through discovery", () => {
		const knownTeamPaths = new Map([["untrusted", "/tmp/untrusted"]]);
		const offlineCatalog = new Map<string, string>();
		const trustedTargets = createConsoleTargets({
			localDomainId: "home",
			localGatewayId: "gw",
			isTrustedCatalogProject: (name) => offlineCatalog.has(name),
		});

		expect(knownTeamPaths.has("untrusted")).toBe(true);
		expect(() => trustedTargets.tmuxTarget("home.gw.untrusted.dev")).toThrow("only the host and devcontainers");
	});
});
