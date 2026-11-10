import { describe, expect, it } from "vitest";
import { composeFilesOf, composeProjectOf, parseJsonc, pickDevContainers } from "../mcp/devcontainer/containers.js";

const CATALOG = [
	{ team: "alpha", projectPath: "/home/u/projects/alpha" },
	{ team: "beta", projectPath: "/home/u/projects/beta" },
];

function row(id: string, folder: string, running: boolean, created: string, compose?: string) {
	return {
		Id: id,
		Name: `/${id}-name`,
		Created: created,
		State: { Running: running },
		Config: {
			Labels: {
				"devcontainer.local_folder": folder,
				...(compose ? { "com.docker.compose.project": compose } : {}),
			},
		},
	};
}

describe("devcontainer.json compose files", () => {
	it("reads JSONC and resolves every entry in order", () => {
		const text = `{
			// comment, with "quotes"
			"name": "a // not a comment, }",
			/* block */ "dockerComposeFile": ["compose.yml", "../extra.yml",],
		}`;
		expect(composeFilesOf("/p/.devcontainer", parseJsonc(text))).toEqual([
			"/p/.devcontainer/compose.yml",
			"/p/extra.yml",
		]);
		expect(composeFilesOf("/p/.devcontainer", parseJsonc(`{"dockerComposeFile": "c.yml"}`))).toEqual([
			"/p/.devcontainer/c.yml",
		]);
		expect(composeFilesOf("/p/.devcontainer", parseJsonc(`{"image": "x"}`))).toEqual([]);
	});
});

describe("finding a compose project by its files", () => {
	const FILES = ["/p/.devcontainer/compose.yml", "/p/extra.yml"];
	const built = "/p/.devcontainer/compose.yml,/p/extra.yml,/tmp/devcontainercli/build-1.yml";

	it("answers the one project built from every file, sidecars included", () => {
		const rows = [`p_devcontainer\t${built}`, `p_devcontainer\t${built}`, "other\t/p/extra.yml"].join("\n");
		expect(composeProjectOf(rows, FILES)).toBe("p_devcontainer");
	});

	it("answers nothing when two projects match, none does, or no file is named", () => {
		const two = [`p_devcontainer\t${built}`, `devcontainer\t${FILES.join(",")}`].join("\n");
		expect(composeProjectOf(two, FILES)).toBeUndefined();
		expect(composeProjectOf("other\t/p/extra.yml", FILES)).toBeUndefined();
		expect(composeProjectOf(`p_devcontainer\t${built}`, [])).toBeUndefined();
	});
});

describe("picking a project's dev container", () => {
	it("prefers a running container, then the newest, and skips projects outside the catalog", () => {
		const view = pickDevContainers(
			[
				row("old", "/home/u/projects/alpha", false, "2026-01-01T00:00:00Z", "alpha_devcontainer"),
				row("live", "/home/u/projects/alpha", true, "2025-01-01T00:00:00Z", "alpha_devcontainer"),
				row("b1", "/home/u/projects/beta/", false, "2026-01-01T00:00:00Z"),
				row("b2", "/home/u/projects/beta", false, "2026-02-01T00:00:00Z"),
				row("stray", "/elsewhere/gamma", true, "2026-01-01T00:00:00Z"),
			],
			CATALOG,
		);
		expect(Object.fromEntries(view)).toEqual({
			alpha: { id: "live", name: "live-name", compose: "alpha_devcontainer", running: true },
			beta: { id: "b2", name: "b2-name", running: false },
		});
	});
});
