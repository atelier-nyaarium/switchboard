import crypto from "node:crypto";
import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import { AGENT_PROMPT_MAX_BYTES } from "../../shared/agent-record.js";
import { type HostOp, type HostOpResult, HostReadSkillResultSchema } from "../../shared/host-op.js";
import type { PendingCall } from "./dispatchCore.js";
import { byteLength, type HostFailure, hostFailure, skillRows, thrownHostFailure } from "./dispatchCore.js";
import type { WorkflowDispatchOutcome } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import { PROJECT_INSTRUCTION_FILES } from "./workflowSchemas.js";

export const SKILL_MARKER_START = "--- BEGIN WORKFLOW SKILL: ";
export const SKILL_MARKER_END = "--- END WORKFLOW SKILL: ";

interface DispatchPromptDeps {
	runner: WorkflowRunner;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
}

/** Owns workflow prompts. */
export function createWorkflowPrompt(
	deps: DispatchPromptDeps,
	settle: (task: PendingCall, outcome: WorkflowDispatchOutcome) => void,
	isStopped: () => boolean,
) {
	function applyFailure(task: PendingCall, failure: HostFailure): void {
		if ("waitFor" in failure) task.waitFor = failure.waitFor;
		else settle(task, failure.outcome);
	}
	function currentPrompt(task: PendingCall): string {
		if (task.prompt !== undefined) return task.prompt;
		const correction = task.issued.correction;
		if (!correction) return task.issued.prompt;
		return `${task.issued.prompt}\n\nCorrect the previous answer for the supplied schema.\nPrevious answer: ${JSON.stringify(correction.answer)}\nSchema errors:\n${correction.errors.join("\n")}`;
	}
	async function composePrompt(
		task: PendingCall,
		target: AgentExecutionTarget,
		fresh: boolean,
	): Promise<string | null> {
		const paths = fresh ? (task.issued.options.skills ?? []) : [];
		if (paths.length === 0) return currentPrompt(task);
		const textByPath = skillRows(task.issued.runId, deps.runner);
		const skills: Array<{ path: string; text: string }> = [];
		for (const skillPath of paths) {
			let text = textByPath.get(skillPath);
			if (text === undefined) {
				const result = await deps.relayToHost({ kind: "readSkill", target, path: skillPath });
				if (isStopped() || task.done) return null;
				if (!result.ok) {
					applyFailure(task, hostFailure(`skill ${skillPath}`, result.error, result.errorKind));
					return null;
				}
				const checked = HostReadSkillResultSchema.safeParse(result.result);
				if (!checked.success) {
					settle(task, { outcome: "failed", answer: null, reason: `skill ${skillPath}: invalid host reply` });
					return null;
				}
				const read = checked.data;
				if (read?.kind === "refused") {
					const reason = `skill ${skillPath}: ${read.code}`;
					settle(task, { outcome: "rejected", answer: null, reason });
					return null;
				}
				text = read.text;
				if (!appendSkillText(task.issued.runId, skillPath, text)) {
					settle(task, {
						outcome: "failed",
						answer: null,
						reason: `skill ${skillPath} could not be journaled`,
					});
					return null;
				}
			}
			skills.push({ path: skillPath, text });
		}
		const body = skills
			.map(({ path, text }) => `${SKILL_MARKER_START}${path} ---\n${text}\n${SKILL_MARKER_END}${path} ---`)
			.join("\n\n");
		const composed = `${body}\n\n${currentPrompt(task)}`;
		if (byteLength(composed) > AGENT_PROMPT_MAX_BYTES) {
			settle(task, { outcome: "failed", answer: null, reason: "prompt plus skills exceeds the limit" });
			return null;
		}
		return composed;
	}
	function appendSkillText(runId: string, path: string, text: string): boolean {
		const sha256 = crypto.createHash("sha256").update(text, "utf8").digest("hex");
		const rows = deps.runner.rows(runId);
		const alreadyStored = rows.some(
			(row) => row.kind === "skill_text" && row.sha256 === sha256 && row.text !== undefined,
		);
		return deps.runner.append(runId, {
			kind: "skill_text",
			path,
			sha256,
			...(alreadyStored ? {} : { text }),
		});
	}
	/** Project guidance for fresh sessions. */
	async function projectLead(task: PendingCall, target: AgentExecutionTarget): Promise<string | null | undefined> {
		for (const path of PROJECT_INSTRUCTION_FILES) {
			let result: HostOpResult;
			try {
				result = await deps.relayToHost({ kind: "readSkill", target, path });
			} catch (error) {
				applyFailure(task, thrownHostFailure(error));
				return undefined;
			}
			if (isStopped() || task.done) return undefined;
			if (!result.ok) {
				applyFailure(task, hostFailure(`project instructions ${path}`, result.error, result.errorKind));
				return undefined;
			}
			const checked = HostReadSkillResultSchema.safeParse(result.result);
			if (!checked.success) {
				settle(task, { outcome: "failed", answer: null, reason: "project instructions: invalid host reply" });
				return undefined;
			}
			// Too large to read here, still readable by Claude.
			if (checked.data.kind === "read" || checked.data.code === "too_large") return `Read ${path} first.`;
		}
		return null;
	}
	return { composePrompt, appendSkillText, projectLead };
}
