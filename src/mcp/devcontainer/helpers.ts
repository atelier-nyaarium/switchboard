import { exec, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODELS } from "../resolve-model.js";

////////////////////////////////
//  Interfaces & Types

export interface BuildAgentCommandParams {
	agent: string;
	model: string;
	sessionId: string;
	isFollowUp: boolean;
	promptFile: string;
	responseFile: string;
	stderrFile: string;
}

export interface ExecInContainerParams {
	projectPath: string;
	command: string[];
	timeoutMs?: number;
	stdin?: string;
}

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();

// CLI agent types for dispatch_cli (Claude uses channel-based communication instead)
export const CLI_AGENT_TYPES = ["cursor", "copilot", "codex"] as [string, ...string[]];
export const EFFORT_LEVELS = ["simple", "standard", "complex"] as [string, ...string[]];

export function resolveDevcontainerModel(agent: string, effort: string): string {
	const models = DEFAULT_MODELS[agent];
	if (!models) throw new Error(`Unknown agent '${agent}'. Valid: ${CLI_AGENT_TYPES.join(", ")}`);
	const model = models[effort];
	if (!model) throw new Error(`Unknown effort '${effort}'. Valid: ${EFFORT_LEVELS.join(", ")}`);
	return model;
}

// Devcontainer CLI discovery

let cachedBin: string | null = null;

function findDevcontainerBin(): string {
	const candidates = [path.join(HOME, ".devcontainers/bin/devcontainer"), "/usr/local/bin/devcontainer"];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	try {
		return execSync("which devcontainer", { encoding: "utf-8", timeout: 5000 }).trim();
	} catch {
		throw new Error(`devcontainer CLI not found.`);
	}
}

function devcontainerBin(): string {
	if (!cachedBin) cachedBin = findDevcontainerBin();
	return cachedBin;
}

// Environment & project validation

export function assertNotContainer(): void {
	if (fs.existsSync("/.dockerenv") || process.env.REMOTE_CONTAINERS) {
		throw new Error(`This tool runs on the host, not inside a container.`);
	}
}

export function resolveProject(projectPath: string): string {
	if (projectPath.includes("..")) {
		throw new Error(`Path must not contain '..'.`);
	}
	const resolved = path.isAbsolute(projectPath) ? projectPath : path.join(HOME, projectPath);
	if (!fs.existsSync(resolved)) {
		throw new Error(`Project not found: ${resolved}`);
	}
	if (!fs.existsSync(path.join(resolved, ".devcontainer", "devcontainer.json"))) {
		throw new Error(`No .devcontainer/devcontainer.json in ${resolved}`);
	}
	return resolved;
}

// Container lifecycle

function parseDevcontainerOutput(output: string, projectPath: string): void {
	const lines = output.trim().split("\n");
	const lastLine = lines[lines.length - 1];
	try {
		const result = JSON.parse(lastLine);
		if (result.outcome !== "success") {
			throw new Error(`devcontainer up returned outcome '${result.outcome}' for '${projectPath}'.`);
		}
	} catch (e) {
		if (e instanceof SyntaxError) {
			throw new Error(`devcontainer up returned unexpected output for '${projectPath}':\n${lastLine}`);
		}
		throw e;
	}
}

function isContainerReady(projectPath: string): boolean {
	try {
		execSync(`"${devcontainerBin()}" exec --workspace-folder "${projectPath}" echo ok`, {
			timeout: 15_000,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

export function ensureContainerUp(projectPath: string): void {
	if (isContainerReady(projectPath)) return;

	const bin = devcontainerBin();

	let output: string;
	try {
		output = execSync(`"${bin}" up --workspace-folder "${projectPath}"`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`devcontainer up failed for '${projectPath}':\n${msg}`);
	}

	parseDevcontainerOutput(output, projectPath);
}

export function ensureContainerUpAsync(projectPath: string): Promise<void> {
	if (isContainerReady(projectPath)) return Promise.resolve();

	const bin = devcontainerBin();

	return new Promise((resolve, reject) => {
		exec(
			`"${bin}" up --workspace-folder "${projectPath}"`,
			{ encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(new Error(`devcontainer up failed for '${projectPath}':\n${error.message}`));
					return;
				}

				try {
					parseDevcontainerOutput(stdout, projectPath);
				} catch (e) {
					reject(e);
					return;
				}

				resolve();
			},
		);
	});
}

// Agent command building

export function buildAgentCommand({
	agent,
	model,
	sessionId,
	isFollowUp,
	promptFile,
	responseFile,
	stderrFile,
}: BuildAgentCommandParams): string {
	switch (agent) {
		case "cursor":
			return `cursor-agent -f -p --model ${model} --resume=${sessionId} < ${promptFile} > ${responseFile} 2>${stderrFile}`;
		case "copilot":
			return `copilot -p "$(cat ${promptFile})" --yolo --no-ask-user --model ${model} --resume ${sessionId} -s > ${responseFile} 2>${stderrFile}`;
		case "codex": {
			if (isFollowUp) {
				return `codex exec resume ${sessionId} -m ${model} --dangerously-bypass-approvals-and-sandbox < ${promptFile} > ${responseFile} 2>${stderrFile}`;
			}
			return `codex exec -m ${model} --dangerously-bypass-approvals-and-sandbox < ${promptFile} > ${responseFile} 2>${stderrFile}`;
		}
		default:
			throw new Error(
				`Unknown CLI agent '${agent}'. Claude uses channel-based communication, so use crosstalk_send instead.`,
			);
	}
}

// Container execution

export function execInContainer({
	projectPath,
	command,
	timeoutMs = 120000,
	stdin,
}: ExecInContainerParams): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(devcontainerBin(), ["exec", "--workspace-folder", projectPath, ...command], {
			timeout: timeoutMs,
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => (stdout += d));
		proc.stderr.on("data", (d: Buffer) => (stderr += d));
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				const msg = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || "(no output)";
				reject(new Error(`Exit ${code}: ${msg}`));
			}
		});

		if (stdin != null) {
			proc.stdin.write(stdin);
			proc.stdin.end();
		}
	});
}
