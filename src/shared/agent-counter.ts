import { z } from "zod";

export const AgentCounterKindSchema = z.enum(["shell", "edit", "read", "other"]);
export type AgentCounterKind = z.infer<typeof AgentCounterKindSchema>;

export interface AgentProgressCounts {
	modelTurns?: number;
	filesChanged?: number;
	toolCalls: number;
	shell: number;
	edits: number;
	reads: number;
	other: number;
}

/** A tool call's kind, read off its name. */
export function counterKindOfTool(toolName: string): AgentCounterKind {
	const name = toolName.toLowerCase();
	if (/shell|bash|terminal|command|run/.test(name)) return "shell";
	if (/edit|write|patch|create_file/.test(name)) return "edit";
	if (/read|view|list/.test(name)) return "read";
	return "other";
}

export function emptyAgentProgressCounts(): AgentProgressCounts {
	return { modelTurns: 0, toolCalls: 0, shell: 0, edits: 0, reads: 0, other: 0 };
}

export function addAgentProgressCounts(target: AgentProgressCounts, source: AgentProgressCounts): AgentProgressCounts {
	return {
		...(target.modelTurns === undefined || source.modelTurns === undefined
			? {}
			: { modelTurns: target.modelTurns + source.modelTurns }),
		...(target.filesChanged === undefined && source.filesChanged === undefined
			? {}
			: { filesChanged: (target.filesChanged ?? 0) + (source.filesChanged ?? 0) }),
		toolCalls: target.toolCalls + source.toolCalls,
		shell: target.shell + source.shell,
		edits: target.edits + source.edits,
		reads: target.reads + source.reads,
		other: target.other + source.other,
	};
}

export function deltaAgentProgressCounts(
	current: AgentProgressCounts,
	previous: AgentProgressCounts,
): AgentProgressCounts {
	return {
		...(current.modelTurns === undefined
			? {}
			: { modelTurns: Math.max(0, current.modelTurns - (previous.modelTurns ?? 0)) }),
		...(current.filesChanged === undefined
			? {}
			: { filesChanged: Math.max(0, current.filesChanged - (previous.filesChanged ?? 0)) }),
		toolCalls: Math.max(0, current.toolCalls - previous.toolCalls),
		shell: Math.max(0, current.shell - previous.shell),
		edits: Math.max(0, current.edits - previous.edits),
		reads: Math.max(0, current.reads - previous.reads),
		other: Math.max(0, current.other - previous.other),
	};
}

export function formatAgentProgressCounts(counts: AgentProgressCounts): string {
	const parts: string[] = [];
	if (counts.modelTurns !== undefined && counts.modelTurns > 0) {
		parts.push(`${counts.modelTurns} model turn${counts.modelTurns === 1 ? "" : "s"}`);
	}
	if (counts.toolCalls > 0) {
		const kinds = [
			counts.shell > 0 ? `${counts.shell} shell` : "",
			counts.edits > 0 ? `${counts.edits} edit${counts.edits === 1 ? "" : "s"}` : "",
			counts.reads > 0 ? `${counts.reads} read` : "",
			counts.other > 0 ? `${counts.other} other` : "",
		].filter(Boolean);
		parts.push(
			`${counts.toolCalls} tool call${counts.toolCalls === 1 ? "" : "s"}${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}`,
		);
	}
	if (counts.filesChanged !== undefined && counts.filesChanged > 0) {
		parts.push(`${counts.filesChanged} file${counts.filesChanged === 1 ? "" : "s"} changed`);
	}
	return parts.join(", ") || "no activity";
}
