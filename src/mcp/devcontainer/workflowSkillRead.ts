import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentExecutionTarget, AgentExecutionTargetSchema } from "../../shared/agent-execution-target.js";
import type { HostReadSkillResult } from "../../shared/host-op.js";

const SKILL_MAX_BYTES = 64 * 1024;
const CONTAINER_READ = `
const fs = require("node:fs");
const path = require("node:path");
const requested = process.argv[1];
const home = process.env.HOME || "/home/vscode";
const cwd = process.cwd();
const candidate = requested === "~" ? home : requested.startsWith("~/") ? path.join(home, requested.slice(2)) : path.resolve(cwd, requested);
const inside = (root, value) => { const relative = path.relative(root, value); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
try {
  const real = fs.realpathSync(candidate);
  const roots = [fs.realpathSync(home), fs.realpathSync(cwd)];
  if (!roots.some(root => inside(root, real))) process.stdout.write(JSON.stringify({kind:"refused",code:"outside_target"}));
  else if (!fs.statSync(real).isFile()) process.stdout.write(JSON.stringify({kind:"refused",code:"non_regular"}));
  else {
    const bytes = fs.readFileSync(real);
    if (bytes.byteLength > 65536) process.stdout.write(JSON.stringify({kind:"refused",code:"too_large"}));
    else {
      try { process.stdout.write(JSON.stringify({kind:"read",text:new TextDecoder("utf-8",{fatal:true}).decode(bytes)})); }
      catch { process.stdout.write(JSON.stringify({kind:"refused",code:"non_utf8"})); }
    }
  }
} catch (error) {
  process.stdout.write(JSON.stringify({kind:"refused",code:error && error.code === "ENOENT" ? "missing" : "non_regular"}));
}
`;

function inside(root: string, value: string): boolean {
	const relative = path.relative(root, value);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function candidatePath(base: string, home: string, requested: string): string {
	if (requested === "~") return home;
	if (requested.startsWith("~/")) return path.resolve(home, requested.slice(2));
	return path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(base, requested);
}

function readHost(base: string, home: string, requested: string): HostReadSkillResult {
	try {
		const resolvedBase = candidatePath(home, home, base);
		const candidate = candidatePath(resolvedBase, home, requested);
		const real = fs.realpathSync(candidate);
		const roots = [fs.realpathSync(home), fs.realpathSync(resolvedBase)];
		if (!roots.some((root) => inside(root, real))) return { kind: "refused", code: "outside_target" };
		if (!fs.statSync(real).isFile()) return { kind: "refused", code: "non_regular" };
		const bytes = fs.readFileSync(real);
		if (bytes.byteLength > SKILL_MAX_BYTES) return { kind: "refused", code: "too_large" };
		try {
			return { kind: "read", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
		} catch {
			return { kind: "refused", code: "non_utf8" };
		}
	} catch (error) {
		return {
			kind: "refused",
			code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "non_regular",
		};
	}
}

export function readWorkflowSkill(target: AgentExecutionTarget, requested: string): HostReadSkillResult {
	const checkedTarget = AgentExecutionTargetSchema.safeParse(target);
	if (!checkedTarget.success) return { kind: "refused", code: "outside_target" };
	if (requested.length === 0 || requested.length > 4096) return { kind: "refused", code: "outside_target" };
	if (checkedTarget.data.kind === "host") return readHost(checkedTarget.data.workdirHint, os.homedir(), requested);
	target = checkedTarget.data;
	const args = [
		"exec",
		"-u",
		"vscode",
		"-w",
		`/workspace/${target.project}`,
		`${target.project}_devcontainer-dev-1`,
		"node",
		"-e",
		CONTAINER_READ,
		"--",
		requested,
	];
	const output = execFileSync("docker", args, {
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: SKILL_MAX_BYTES + 4096,
	});
	const value = JSON.parse(output) as HostReadSkillResult;
	if (value.kind === "read" && typeof value.text === "string") return value;
	if (
		value.kind === "refused" &&
		["missing", "non_regular", "non_utf8", "too_large", "outside_target"].includes(value.code)
	) {
		return value;
	}
	throw new Error("container skill read returned an invalid result");
}
