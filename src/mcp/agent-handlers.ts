import { spawn } from "node:child_process";

////////////////////////////////
//  Interfaces & Types

export interface AgentHandler {
	createSession(sessionId: string): Promise<string>;
	sendMessage(sessionId: string, message: string, model: string, isFollowUp?: boolean): Promise<string>;
}

////////////////////////////////
//  Functions & Helpers

const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || "600000", 10);

// Maps bridge session IDs to codex thread IDs for follow-ups
const codexThreadIds = new Map<string, string>();

function runAgent(command: string, args: string[], input: string | null): Promise<string> {
	const env = { ...process.env };
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		const extra = [`${home}/.local/bin`, `${home}/bin`].join(":");
		env.PATH = [env.PATH, extra].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
	}

	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			timeout: AGENT_TIMEOUT_MS,
			cwd: process.cwd(),
			env,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d: Buffer) => (stdout += d));
		proc.stderr.on("data", (d: Buffer) => (stderr += d));

		proc.on("error", (err: Error) => {
			reject(err);
		});

		if (input) {
			proc.stdin.write(input);
			proc.stdin.end();
		}

		proc.on("close", (code: number | null) => {
			const outTrimmed = stdout.trim();
			const errTrimmed = stderr.trim();
			if (code === 0) {
				resolve(outTrimmed);
			} else {
				const errText = [errTrimmed, outTrimmed].filter(Boolean).join("\n") || "(no output)";
				reject(new Error(`Agent exited ${code}: ${errText}`));
			}
		});
	});
}

export const AGENT_HANDLERS: Record<string, AgentHandler> = {
	claude: {
		async createSession(sessionId) {
			return sessionId;
		},
		async sendMessage(sessionId, message, model, isFollowUp) {
			const sessionFlag = isFollowUp ? "--resume" : "--session-id";
			const args = ["-p", "--dangerously-skip-permissions", "--model", model, sessionFlag, sessionId];
			return runAgent("claude", args, message);
		},
	},

	cursor: {
		async createSession() {
			const id = await runAgent("cursor-agent", ["create-chat", "-f"], null);
			return id.trim();
		},
		async sendMessage(sessionId, message, model) {
			const args = ["-f", "-p", "--model", model, `--resume=${sessionId}`];
			return runAgent("cursor-agent", args, message);
		},
	},

	copilot: {
		async createSession(sessionId) {
			return sessionId;
		},
		async sendMessage(sessionId, message, model) {
			const args = ["-p", message, "--yolo", "--no-ask-user", "--model", model, "--resume", sessionId, "-s"];
			return runAgent("copilot", args, null);
		},
	},

	codex: {
		async createSession(sessionId) {
			return sessionId;
		},
		async sendMessage(sessionId, message, model, isFollowUp) {
			const threadId = codexThreadIds.get(sessionId);

			if (isFollowUp && threadId) {
				const args = ["exec", "resume", threadId, "-m", model, "--dangerously-bypass-approvals-and-sandbox"];
				return runAgent("codex", args, message);
			}

			// New session: use --json to capture thread_id from the first JSONL line
			const args = ["exec", "-m", model, "--dangerously-bypass-approvals-and-sandbox", "--json"];
			const output = await runAgent("codex", args, message);

			try {
				const firstLine = output.split("\n")[0];
				const parsed = JSON.parse(firstLine);
				if (parsed.thread_id) {
					codexThreadIds.set(sessionId, parsed.thread_id);
				}
			} catch {
				// Best effort, thread_id extraction is optional
			}

			return output;
		},
	},
};
