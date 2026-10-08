import { describe, expect, it } from "vitest";
import { type DockerRun, joinGatewayNetwork } from "../mcp/devcontainer/helpers.js";
import { GATEWAY_NETWORK } from "../shared/gateway-network.js";

const PROJECT = "/home/owner/projects/halo-explorer";

/** A docker CLI holding one container for PROJECT, on the given networks. */
function docker(networks: string[], running = true) {
	const calls: string[][] = [];
	const run: DockerRun = (args) => {
		calls.push(args);
		if (args[0] === "ps") return running ? "c0ffee\n" : "";
		if (args[0] === "inspect") return JSON.stringify(Object.fromEntries(networks.map((name) => [name, {}])));
		if (args[0] === "network") networks.push(args[4] as string);
		return "";
	};
	return { run, calls, networks };
}

describe("a woken devcontainer joins the Gateway's network", () => {
	it("joins it aliased as the project, finding the container by its folder", () => {
		const d = docker(["halo-explorer_devcontainer_default"]);

		joinGatewayNetwork(PROJECT, d.run);

		expect(d.calls[0]).toEqual(["ps", "-q", "--filter", `label=devcontainer.local_folder=${PROJECT}`]);
		expect(d.calls.at(-1)).toEqual(["network", "connect", "--alias", "halo-explorer", GATEWAY_NETWORK, "c0ffee"]);
	});

	it("leaves a container already on it alone", () => {
		const d = docker(["halo-explorer_devcontainer_default", GATEWAY_NETWORK]);

		joinGatewayNetwork(PROJECT, d.run);

		expect(d.calls.some((args) => args[0] === "network")).toBe(false);
	});

	it("refuses when no container is running for the project", () => {
		const d = docker([], false);

		expect(() => joinGatewayNetwork(PROJECT, d.run)).toThrow();
	});
});
