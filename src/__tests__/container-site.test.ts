import { describe, expect, it } from "vitest";
import {
	containerLaunchSite,
	containerRuntimeRoot,
	createRuntimePlacer,
	placeRuntime,
	type RuntimeCopy,
} from "../mcp/devcontainer/containerSite.js";
import type { TmuxTarget } from "../shared/host-op.js";
import { PLUGIN_ROOT_PARTS, VENDORED_PARSER_PATH } from "../shared/plugin-root.js";

const APP_A: TmuxTarget = { kind: "devcontainer", name: "app", sessionName: "a" };

describe("a container's launch site", () => {
	it("runs the container's bun from a root named by the build, and keeps status per session", async () => {
		const asked: string[][] = [];
		const site = containerLaunchSite("8.14.55", async (_target, argv) => {
			asked.push(argv);
			return `{"state":"ready","pid":7}`;
		});

		expect(site.runtime).toBe("/home/vscode/.bun/bin/bun");
		expect(site.root).toBe("/home/vscode/.cache/switchboard/runtime/8.14.55");
		expect(site.statusFile(APP_A)).toBe("/home/vscode/.cache/switchboard/launch/app.a.json");
		expect(await site.readStatus(APP_A)).toBe(`{"state":"ready","pid":7}`);
		await site.clearStatus(APP_A);
		expect(asked.every((argv) => argv.includes(site.statusFile(APP_A)))).toBe(true);
	});

	it("reads an unreadable status as none, and refuses a version that is not a plain path", async () => {
		const site = containerLaunchSite("8.14.55", async () => {
			throw new Error("No such file");
		});

		expect(await site.readStatus(APP_A)).toBeUndefined();
		expect(() => containerRuntimeRoot("1.0/../../etc")).toThrow();
	});
});

describe("placing the runtime in a container", () => {
	/** A container holding a whole copy once `package.json` lands. */
	function container(present: boolean) {
		const steps: string[] = [];
		const held = { present };
		const copy: RuntimeCopy = {
			exec: async (argv) => {
				steps.push(`exec ${argv[0]}`);
				if (argv[0] === "test" && !held.present) throw new Error("exit 1");
				return "";
			},
			docker: async (args) => {
				steps.push(`docker ${args.join(" ")}`);
				await new Promise((resolve) => setTimeout(resolve, 1));
				if (args[2]?.endsWith("package.json")) held.present = true;
			},
			container: "app_devcontainer-dev-1",
			source: "/srv/sb",
			version: "8.14.55",
		};
		return { copy, steps };
	}

	it("copies nothing when this version is already whole there", async () => {
		const c = container(true);

		expect(await placeRuntime(c.copy)).toBe("present");
		expect(c.steps).toEqual(["exec test"]);
	});

	it("starts a missing copy over, and copies package.json last as its mark", async () => {
		const c = container(false);
		const root = "app_devcontainer-dev-1:/home/vscode/.cache/switchboard/runtime/8.14.55";

		expect(await placeRuntime(c.copy)).toBe("copied");
		expect(c.steps).toEqual([
			"exec test",
			"exec sh",
			`docker cp -a /srv/sb/dist ${root}/dist`,
			`docker cp -a /srv/sb/launch ${root}/launch`,
			`docker cp -a /srv/sb/${VENDORED_PARSER_PATH} ${root}/${VENDORED_PARSER_PATH}`,
			`docker cp -a /srv/sb/package.json ${root}/package.json`,
		]);
	});

	it("copies once for two launches placing one version into one container at once", async () => {
		const c = container(false);
		const place = createRuntimePlacer();

		const answers = await Promise.all([place(c.copy), place(c.copy)]);

		expect(answers).toEqual(["copied", "copied"]);
		expect(c.steps.filter((step) => step.startsWith("docker"))).toHaveLength(PLUGIN_ROOT_PARTS.length);
		expect(await place(c.copy)).toBe("present");
	});
});
