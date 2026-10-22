// Shared token, rate limit.

import type { PollAnswer } from "./watcher.js";

export const GITHUB_API = "https://api.github.com";
/** GitHub's default poll interval. */
export const GITHUB_FLOOR_MS = 60_000;
export const GITHUB_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Token read result. */
export type TokenRead =
	/** Validator grant key. */
	| { kind: "token"; value: string; key: string }
	| { kind: "stopped"; reason: string }
	| { kind: "backoff"; reason: string };

export type GithubRefusal = Extract<PollAnswer, { kind: "stopped" | "backoff" }>;

export interface GithubToken {
	value: string;
	key: string;
}

export interface GithubClientDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** Watcher's grant per call. */
	token: () => Promise<TokenRead>;
	now: () => number;
}

export interface GithubClient {
	/** Token or refusal. */
	token(signal: AbortSignal): Promise<GithubToken | GithubRefusal>;
	/** Remaining limit, milliseconds. */
	waitLeft(): number;
	/** GitHub API only; caller reads 404. */
	request(
		token: GithubToken,
		path: string,
		init: { method?: "GET" | "PATCH" | "DELETE"; since?: string | null },
		signal: AbortSignal,
	): Promise<Response | GithubRefusal>;
}

export const isRefusal = (answer: object): answer is GithubRefusal => "kind" in answer;

/** Fetch errors can echo tokens. */
const TOKEN_RE = /^[!-~]+$/;
const NOT_A_TOKEN = "the secret is not a GitHub token";
/** Secondary limit fallback. */
const SECONDARY_WAIT_MS = 5 * 60_000;
const SCOPE = "the token needs the notifications scope";

export const githubWait = (ms: number) => Math.min(GITHUB_MAX_WAIT_MS, Math.max(GITHUB_FLOOR_MS, Math.ceil(ms)));

/** Auth stops; rate limits back off. */
async function refusalOf(response: Response, now: number): Promise<GithubRefusal | null> {
	if (response.status === 401) return { kind: "stopped", reason: "GitHub refused the token" };
	if (response.status !== 403 && response.status !== 429) return null;
	const retryAfter = Number(response.headers.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) {
		return { kind: "backoff", retryMs: githubWait(retryAfter * 1000), reason: "GitHub rate limit" };
	}
	const reset = Number(response.headers.get("x-ratelimit-reset"));
	if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) {
		return { kind: "backoff", retryMs: githubWait(reset * 1000 - now), reason: "GitHub rate limit" };
	}
	const body = response.status === 403 ? await response.text().catch(() => "") : "";
	if (response.status === 429 || /rate limit/i.test(body)) {
		return { kind: "backoff", retryMs: SECONDARY_WAIT_MS, reason: "GitHub secondary rate limit" };
	}
	return { kind: "stopped", reason: `GitHub refused access to notifications; ${SCOPE}` };
}

/** Hidden-resource refusal. */
export const HIDDEN: GithubRefusal = { kind: "stopped", reason: `GitHub hid the notifications; ${SCOPE}` };

export function createGithubClient(deps: GithubClientDeps): GithubClient {
	let limitedUntil = 0;
	return {
		async token(signal) {
			// Abort cannot cancel the vault read.
			const token = await new Promise<TokenRead>((resolve, reject) => {
				const aborted = () => reject(new Error("aborted reading the token"));
				if (signal.aborted) return aborted();
				signal.addEventListener("abort", aborted, { once: true });
				deps.token()
					.then(resolve, reject)
					.finally(() => signal.removeEventListener("abort", aborted));
			});
			if (token.kind === "stopped") return { kind: "stopped", reason: token.reason };
			if (token.kind === "backoff") return { kind: "backoff", retryMs: GITHUB_FLOOR_MS, reason: token.reason };
			const value = token.value.trim();
			if (!TOKEN_RE.test(value)) return { kind: "stopped", reason: NOT_A_TOKEN };
			return { value, key: token.key };
		},
		waitLeft: () => Math.max(0, limitedUntil - deps.now()),
		async request(token, path, init, signal) {
			const left = limitedUntil - deps.now();
			if (left > 0) return { kind: "backoff", retryMs: githubWait(left), reason: "GitHub rate limit" };
			// GitHub-only requests.
			const url = path.startsWith("/") ? `${GITHUB_API}${path}` : path;
			if (!url.startsWith(`${GITHUB_API}/`)) throw new Error("not a GitHub API URL");
			const response = await deps.fetch(url, {
				method: init.method ?? "GET",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token.value}`,
					"User-Agent": "switchboard-assistant",
					"X-GitHub-Api-Version": "2022-11-28",
					...(init.since ? { "If-Modified-Since": init.since } : {}),
				},
				signal,
			});
			const refusal = await refusalOf(response, deps.now());
			if (refusal?.kind === "backoff") limitedUntil = Math.max(limitedUntil, deps.now() + refusal.retryMs);
			return refusal ?? response;
		},
	};
}
