import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLaunchCommand,
	ensureAssistantWorkdir,
	listHostDirs,
	resolveHostWorkdir,
	resolveWatchTarget,
	shouldGreetLaunch,
} from "../mcp/devcontainer/hostResolve.js";

const dc = { kind: "devcontainer" as const, name: "recipe-app", sessionName: "scratch" };

describe("a Copilot launch", () => {
	const id = "0f8b2a4c-1d3e-4f5a-9b6c-7d8e9f0a1b2c";
	const host = { kind: "host" as const, name: "host", sessionName: "cop" };

	it("runs copilot with full access, no questions, and its own session id, naming itself to the plugin", () => {
		const cmd = buildLaunchCommand(host, { harness: "copilot", resumeSessionId: id });

		expect(cmd).toContain(`copilot --allow-all --no-ask-user --session-id ${id}`);
		expect(cmd).toContain("export AGENT_TYPE=copilot;");
		expect(cmd).not.toContain("claude");
		expect(cmd).not.toContain("--dangerously-load-development-channels");
	});

	it("runs copilot.exe on Windows and carries AGENT_TYPE across the boundary", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "windows", sessionName: "cop" },
			{ harness: "copilot", resumeSessionId: id, workdir: "C:\\Users\\me" },
		);
		const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)'$/.exec(cmd)?.[1] ?? "";

		expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain(`copilot.exe --allow-all`);
		expect(cmd).toContain("AGENT_TYPE/w");
	});

	it("resumes only under an id of its own shape, where Claude takes a looser one", () => {
		const loose = "12345678";

		expect(buildLaunchCommand(host, { harness: "copilot", resumeSessionId: loose })).not.toContain("--session-id");
		expect(buildLaunchCommand(host, { harness: "claude", resumeSessionId: loose })).toContain(`--resume ${loose}`);
	});

	it("runs in a container under its own id, and refuses the assistant", () => {
		const id = "11111111-2222-4333-8444-555555555555";

		expect(buildLaunchCommand(dc, { harness: "copilot", resumeSessionId: id })).toContain(
			`cd /workspace/recipe-app; copilot --allow-all --no-ask-user --session-id ${id}; exec bash`,
		);
		expect(() =>
			buildLaunchCommand({ kind: "host", name: "host", sessionName: "assistant" }, { harness: "copilot" }),
		).toThrow();
	});
});

describe("an OpenCode launch", () => {
	const id = "ses_sb0f8b2a4c1d3e4f5a9b6c7d8e9f0a1b2c";
	const host = { kind: "host" as const, name: "host", sessionName: "oc" };
	const launcher = (root: string, greet = false) => ({
		runtime: path.join(root, "bun"),
		root,
		statusFile: path.join(root, "status.json"),
		greet,
	});

	it("runs the launcher under the daemon's bun, naming its session, its status file, and the greeting", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-launch-"));
		const out = path.join(base, "out");
		fs.writeFileSync(path.join(base, ".bashrc"), "");
		fs.writeFileSync(path.join(base, "bun"), `#!/bin/sh\nprintf '%s\\n' "$AGENT_TYPE" "$@" > "${out}"\n`, {
			mode: 0o755,
		});
		const run = (greet: boolean) => {
			const cmd = buildLaunchCommand(host, {
				harness: "opencode",
				resumeSessionId: id,
				launcher: launcher(base, greet),
			});
			execFileSync("bash", ["-c", cmd], {
				env: { HOME: base, PATH: process.env.PATH },
				stdio: ["ignore", "ignore", "ignore"],
				timeout: 10_000,
			});
			return fs.readFileSync(out, "utf8").trim().split("\n");
		};

		const greeted = run(true);
		const quiet = run(false);
		fs.rmSync(base, { recursive: true, force: true });

		expect(greeted).toEqual([
			"opencode",
			`--config=${base}/launch/bunfig.toml`,
			"--no-env-file",
			"--no-install",
			`${base}/dist/main-opencode-launch.js`,
			"--session",
			id,
			"--status",
			path.join(base, "status.json"),
			"--greet",
		]);
		expect(quiet).toEqual(greeted.slice(0, -1));
	});

	it("runs a container's launcher from the runtime copied into it, in the project's folder", () => {
		const root = "/home/vscode/.cache/switchboard/runtime/8.14.55";
		const cmd = buildLaunchCommand(dc, {
			harness: "opencode",
			resumeSessionId: id,
			launcher: {
				runtime: "/home/vscode/.bun/bin/bun",
				root,
				statusFile: "/home/vscode/.cache/switchboard/launch/recipe-app.scratch.json",
				greet: false,
			},
		});

		expect(cmd).toContain(
			`cd /workspace/recipe-app; "/home/vscode/.bun/bin/bun" --config="${root}/launch/bunfig.toml" --no-env-file --no-install "${root}/dist/main-opencode-launch.js" --session ${id}`,
		);
		expect(cmd).toContain("AGENT_TYPE=opencode");
	});

	it("refuses without a launcher or a minted id, and on the Windows shell", () => {
		const root = "/home/me/sb";
		const refusals = [
			() => buildLaunchCommand(host, { harness: "opencode", resumeSessionId: id }),
			() => buildLaunchCommand(host, { harness: "opencode", launcher: launcher(root) }),
			() => buildLaunchCommand(dc, { harness: "opencode", resumeSessionId: id }),
			() =>
				buildLaunchCommand(
					{ kind: "host", name: "windows", sessionName: "oc" },
					{ harness: "opencode", resumeSessionId: id, launcher: launcher(root), workdir: "C:\\Users\\me" },
				),
		];

		for (const refused of refusals) expect(refused).toThrow(/refusing to launch/);
	});

	it("refuses an id out of its shape and a launcher path the quoting cannot hold, rather than run either", () => {
		expect(() =>
			buildLaunchCommand(host, {
				harness: "opencode",
				resumeSessionId: `${id}; rm -rf ~`,
				launcher: launcher("/home/me/sb"),
			}),
		).toThrow(/minted id/);
		expect(() =>
			buildLaunchCommand(host, { harness: "opencode", resumeSessionId: id, launcher: launcher("/home/it's/sb") }),
		).toThrow(/plain absolute path/);
	});
});

describe("buildLaunchCommand", () => {
	it("overrides PROJECT_NAME to the composite, cds to the workspace, and runs claude with a bash fallback", () => {
		const cmd = buildLaunchCommand(dc, { harness: "claude" });
		expect(cmd).toContain("export PROJECT_NAME=recipe-app.scratch");
		expect(cmd).toContain("cd /workspace/recipe-app; claude ");
		// A missing claude leaves a peekable pane rather than a dead tmux server.
		expect(cmd.endsWith("; exec bash'")).toBe(true);
		expect(cmd).not.toContain("--resume");
		// The override runs after sourcing bashrc so it wins over the image ENV.
		expect(cmd.indexOf("source ~/.bashrc")).toBeLessThan(cmd.indexOf("export PROJECT_NAME"));
	});

	it("names Claude to the plugin on a host and a devcontainer launch", () => {
		const host = { kind: "host" as const, name: "host", sessionName: "foo" };

		expect(buildLaunchCommand(host, { harness: "claude" })).toContain(
			"export PROJECT_NAME=host.foo; export AGENT_TYPE=claude; ",
		);
		expect(buildLaunchCommand(dc, { harness: "claude" })).toContain(
			"export PROJECT_NAME=recipe-app.scratch; export AGENT_TYPE=claude; ",
		);
	});

	describe("the assistant's launch", () => {
		const assistant = { kind: "host" as const, name: "host", sessionName: "assistant" };

		it("runs on the permission engine, and survives the shell with its settings intact", () => {
			const base = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-launch-"));
			const notes = path.join(base, "my notes");
			const bin = path.join(base, "bin");
			const argv = path.join(base, "argv");
			fs.mkdirSync(notes);
			fs.mkdirSync(bin);
			fs.writeFileSync(path.join(base, ".bashrc"), "");
			fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argv}"\n`, { mode: 0o755 });
			const cmd = buildLaunchCommand(assistant, { harness: "claude", workdir: notes, pathPrefix: bin });

			execFileSync("bash", ["-c", cmd], {
				env: { HOME: base, PATH: process.env.PATH },
				stdio: ["ignore", "ignore", "ignore"],
				timeout: 10_000,
			});
			const args = fs.readFileSync(argv, "utf8").trim().split("\n");
			const settings = JSON.parse(args[args.indexOf("--settings") + 1] as string);
			fs.rmSync(base, { recursive: true, force: true });

			expect(args).not.toContain("--dangerously-skip-permissions");
			expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
			expect(settings.permissions.allow).toContain(`Edit(/${notes}/**)`);
			expect(settings.permissions.deny).toContain("Edit(*/**/AGENTS.md)");
			expect(settings.permissions.deny).not.toContain("Edit(AGENTS.md)");
		});

		it("keeps every other session on the open profile", () => {
			expect(
				buildLaunchCommand({ kind: "host", name: "host", sessionName: "foo" }, { harness: "claude" }),
			).toContain("--dangerously-skip-permissions");
		});

		it("refuses rather than launch the assistant in home, a missing folder, a linked one, or one it cannot quote", () => {
			const base = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-link-"));
			const keys = path.join(base, "keys");
			const notes = path.join(base, "notes");
			fs.mkdirSync(keys);
			fs.symlinkSync(keys, notes);
			const launch = (workdir?: string) => () => buildLaunchCommand(assistant, { harness: "claude", workdir });

			expect(launch(notes)).toThrow();
			expect(launch(keys)).not.toThrow();
			expect(launch(os.homedir())).toThrow();
			expect(launch(path.join(os.tmpdir(), "no-such-notes"))).toThrow();
			expect(launch("/home/$USER/notes")).toThrow();
			expect(launch()).toThrow();
			fs.rmSync(base, { recursive: true, force: true });
		});

		it("creates a missing folder with its parents, and never home, above it, or a label", () => {
			const home = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-home-"));
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-outside-"));

			ensureAssistantWorkdir("~/notes/assistant", home);
			ensureAssistantWorkdir(path.join(outside, "a", "b"), home);
			ensureAssistantWorkdir("~", home);
			ensureAssistantWorkdir("notes-label", home);
			const made = path.join(home, "notes", "assistant");

			expect(fs.statSync(made).isDirectory()).toBe(true);
			expect(fs.statSync(path.join(outside, "a", "b")).isDirectory()).toBe(true);
			expect(fs.readdirSync(home)).toEqual(["notes"]);
			expect(() => buildLaunchCommand(assistant, { harness: "claude", workdir: made })).not.toThrow();
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		});
	});

	it("appends --resume for a uuid-shaped session id", () => {
		const cmd = buildLaunchCommand(dc, {
			harness: "claude",
			resumeSessionId: "12345678-1234-1234-1234-123456789abc",
		});
		expect(cmd).toContain("--resume 12345678-1234-1234-1234-123456789abc");
	});

	it("ignores a malformed resume id (no --resume injected)", () => {
		const cmd = buildLaunchCommand(dc, { harness: "claude", resumeSessionId: "x'; rm -rf /" });
		expect(cmd).not.toContain("--resume");
	});

	it("keeps a host session's pane alive with exec bash and does not cd into a workspace", () => {
		const cmd = buildLaunchCommand({ kind: "host", name: "host", sessionName: "foo" }, { harness: "claude" });
		expect(cmd).toContain("export PROJECT_NAME=host.foo");
		expect(cmd).toContain("; exec bash");
		expect(cmd).not.toContain("cd /workspace");
		expect(cmd).not.toContain('cd "');
	});

	it("cds a host session to its resolved workdir and resumes by id", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "nyaadot" },
			{
				harness: "claude",
				workdir: "/home/nyaarium/projects/nyaadot",
				resumeSessionId: "12345678-1234-1234-1234-123456789abc",
			},
		);
		expect(cmd).toContain('cd "/home/nyaarium/projects/nyaadot"');
		expect(cmd).toContain("--resume 12345678-1234-1234-1234-123456789abc");
		expect(cmd).toContain("; exec bash");
		expect(cmd).not.toContain("cd /workspace");
	});

	it("drops the cd when the workdir holds a single quote that would break the outer bash -c", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "foo" },
			{ harness: "claude", workdir: "/home/it's/projects/foo" },
		);
		expect(cmd).not.toContain('cd "');
		expect(cmd).not.toContain("it's");
	});

	it("drops the cd when the workdir holds a double quote that would break the cd's own quoting", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "foo" },
			{ harness: "claude", workdir: '/home/projects/a"; rm -rf ~ #' },
		);
		expect(cmd).not.toContain('cd "');
		expect(cmd).not.toContain("rm -rf");
	});

	it("puts the daemon's bin dir ahead of PATH after bashrc and before the identity exports", () => {
		const cmd = buildLaunchCommand(
			{ kind: "host", name: "host", sessionName: "foo" },
			{ harness: "claude", pathPrefix: "/home/me/.bun/bin", sessionToken: "0123456789abcdef" },
		);
		expect(cmd).toContain('export PATH="/home/me/.bun/bin:$PATH"; ');
		expect(cmd.indexOf("source ~/.bashrc")).toBeLessThan(cmd.indexOf("export PATH="));
		expect(cmd.indexOf("export PATH=")).toBeLessThan(cmd.indexOf("export PROJECT_NAME"));
	});

	it("exports the askpass helper into a host and a devcontainer session, after the token and before claude", () => {
		const host = { kind: "host" as const, name: "host", sessionName: "foo" };
		for (const cmd of [
			buildLaunchCommand(host, { harness: "claude", sessionToken: "0123456789abcdef" }),
			buildLaunchCommand(dc, { harness: "claude" }),
		]) {
			for (const name of ["SUDO_ASKPASS", "SSH_ASKPASS", "GIT_ASKPASS"]) {
				expect(cmd).toContain(`export ${name}="$HOME/.local/bin/vault-askpass"; `);
			}
			expect(cmd.indexOf("export PROJECT_NAME")).toBeLessThan(cmd.indexOf("SUDO_ASKPASS"));
			expect(cmd.indexOf("SUDO_ASKPASS")).toBeLessThan(cmd.indexOf("claude "));
		}
		// PowerShell runs no bash wrapper.
		const windows = buildLaunchCommand(
			{ kind: "host", name: "windows", sessionName: "foo" },
			{ harness: "claude", workdir: "C:\\Users\\me\\projects" },
		);
		expect(windows).not.toContain("ASKPASS");
	});

	it("drops a PATH prefix that is not a plain absolute path, and never applies one to a devcontainer", () => {
		const host = { kind: "host" as const, name: "host", sessionName: "foo" };
		const harness = "claude";
		expect(buildLaunchCommand(host, { harness, pathPrefix: "/home/it's/bin" })).not.toContain("export PATH=");
		expect(buildLaunchCommand(host, { harness, pathPrefix: "/x; rm -rf ~" })).not.toContain("export PATH=");
		expect(buildLaunchCommand(host, { harness, pathPrefix: "relative/bin" })).not.toContain("export PATH=");
		expect(buildLaunchCommand(dc, { harness, pathPrefix: "/home/me/.bun/bin" })).not.toContain("export PATH=");
	});
});

describe("resolveHostWorkdir", () => {
	it("picks the first projectDir/<hint> that exists, else home", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		fs.mkdirSync(path.join(base, "myproj"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		expect(resolveHostWorkdir("myproj", [base], home)).toBe(path.join(base, "myproj"));
		expect(resolveHostWorkdir("absent", [base], home)).toBe(home);
	});

	it("falls back to home for a missing hint or one that is not a single path segment", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		fs.mkdirSync(path.join(base, "myproj"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		expect(resolveHostWorkdir(undefined, [base], home)).toBe(home);
		expect(resolveHostWorkdir("", [base], home)).toBe(home);
		expect(resolveHostWorkdir(".", [base], home)).toBe(home);
		expect(resolveHostWorkdir("..", [base], home)).toBe(home);
		expect(resolveHostWorkdir("../myproj", [base], home)).toBe(home);
		expect(resolveHostWorkdir("sub/dir", [base], home)).toBe(home);
	});

	it("uses a picked absolute path verbatim when it is a real directory, else home", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		const real = path.join(base, "some", "deep", "dir");
		fs.mkdirSync(real, { recursive: true });
		expect(resolveHostWorkdir(real, [base], home)).toBe(real);
		expect(resolveHostWorkdir(path.join(base, "gone"), [base], home)).toBe(home);
	});

	it("expands a ~-rooted picked path against home; bare ~ is home itself", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		fs.mkdirSync(path.join(home, "Downloads"));
		expect(resolveHostWorkdir("~/Downloads", [base], home)).toBe(path.join(home, "Downloads"));
		expect(resolveHostWorkdir("~", [base], home)).toBe(home);
		expect(resolveHostWorkdir("~/absent", [base], home)).toBe(home);
	});

	it("drops a picked path bearing a launch-breakout character to home, even if the dir exists", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "hostwd-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
		const quoted = path.join(base, "it's");
		fs.mkdirSync(quoted);
		expect(resolveHostWorkdir(quoted, [base], home)).toBe(home);
		expect(resolveHostWorkdir(`${base}/a\`b`, [base], home)).toBe(home);
		expect(resolveHostWorkdir(`${base}/a$b`, [base], home)).toBe(home);
	});
});

describe("listHostDirs", () => {
	it("lists immediate subdirectories only (no files), sorted case-insensitively", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		fs.mkdirSync(path.join(home, "beta"));
		fs.mkdirSync(path.join(home, "Alpha"));
		fs.writeFileSync(path.join(home, "notes.txt"), "x");
		expect(listHostDirs(home, home)).toEqual({ entries: ["Alpha", "beta"] });
	});

	it("expands ~/ against home and includes dot dirs (the console handles their placement)", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		fs.mkdirSync(path.join(home, "sub"));
		fs.mkdirSync(path.join(home, "sub", ".config"));
		fs.mkdirSync(path.join(home, "sub", "projects"));
		expect(listHostDirs("~/sub", home)).toEqual({ entries: [".config", "projects"] });
	});

	it("follows a symlink to a directory but skips one to a file", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		fs.mkdirSync(path.join(home, "real"));
		fs.writeFileSync(path.join(home, "file.txt"), "x");
		fs.symlinkSync(path.join(home, "real"), path.join(home, "dirlink"));
		fs.symlinkSync(path.join(home, "file.txt"), path.join(home, "filelink"));
		fs.symlinkSync(path.join(home, "nowhere"), path.join(home, "dangling"));
		expect(listHostDirs(home, home)).toEqual({ entries: ["dirlink", "real"] });
	});

	it("returns empty for a missing path or a non-path shape rather than erroring", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "lshome-"));
		expect(listHostDirs(path.join(home, "gone"), home)).toEqual({ entries: [] });
		expect(listHostDirs("not-a-path", home)).toEqual({ entries: [] });
	});
});

describe("resolveWatchTarget", () => {
	it("resolves a devcontainer composite to a docker-exec target", () => {
		expect(resolveWatchTarget("recipe-app.scratch")).toEqual({
			kind: "devcontainer",
			name: "recipe-app",
			sessionName: "scratch",
		});
	});

	it("resolves a host composite to the bare-tmux target", () => {
		expect(resolveWatchTarget("host.nyaadot")).toEqual({ kind: "host", name: "host", sessionName: "nyaadot" });
	});

	it("refuses the daemon's own reserved supervisor session", () => {
		expect(resolveWatchTarget("host.host-daemon")).toBeUndefined();
	});

	it("refuses a malformed (non-slug) project or session segment", () => {
		expect(resolveWatchTarget("Recipe App.scratch")).toBeUndefined();
		expect(resolveWatchTarget("recipe-app.$(rm -rf)")).toBeUndefined();
	});
});

describe("shouldGreetLaunch", () => {
	it("greets a first-time create", () => {
		expect(shouldGreetLaunch({ created: true, ready: true })).toBe(true);
	});

	it("skips a reattach", () => {
		expect(shouldGreetLaunch({ created: false, ready: true })).toBe(false);
	});

	it("skips a wake resuming a transcript", () => {
		expect(
			shouldGreetLaunch({ created: true, ready: true, resumeSessionId: "12345678-1234-1234-1234-123456789abc" }),
		).toBe(false);
	});

	it("skips a pane with no composer", () => {
		expect(shouldGreetLaunch({ created: true, ready: false })).toBe(false);
	});

	it("greets a fresh launch that already holds its id, once created and ready", () => {
		const held = { created: true, ready: true, resumeSessionId: "12345678-1234-1234-1234-123456789abc" };

		expect(shouldGreetLaunch({ ...held, fresh: true })).toBe(true);
		expect(shouldGreetLaunch(held)).toBe(false);
		expect(shouldGreetLaunch({ ...held, fresh: true, ready: false })).toBe(false);
		expect(shouldGreetLaunch({ ...held, fresh: true, created: false })).toBe(false);
	});
});
