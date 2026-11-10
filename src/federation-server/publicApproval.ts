import type { Clock } from "../shared/ambient.js";
import {
	type ConsoleApprovalOp,
	ConsoleApprovalOpSchema,
	type ConsoleApprovalResult,
} from "../shared/federation-lifecycle.js";
import { PublicLimiter } from "./publicLimiter.js";

export interface PublicApprovalParams {
	port: number;
	onApproval: (op: ConsoleApprovalOp) => ConsoleApprovalResult | Promise<ConsoleApprovalResult>;
	maxBodyBytes?: number;
	maxGlobalPerWindow?: number;
	maxPerIdPerWindow?: number;
	rateLimitWindowMs?: number;
	ambient: Clock;
}

const DEFAULT_MAX_BODY_BYTES = 8 * 1024;

const _MAX_PUBLIC_BODY_BYTES = 65_536;

export class PublicApproval {
	private readonly onApproval: (op: ConsoleApprovalOp) => ConsoleApprovalResult | Promise<ConsoleApprovalResult>;
	private readonly maxBodyBytes: number;
	private readonly limiter: PublicLimiter;

	public constructor({
		port,
		onApproval,
		maxBodyBytes,
		maxGlobalPerWindow,
		maxPerIdPerWindow,
		rateLimitWindowMs,
		ambient,
	}: PublicApprovalParams) {
		this.onApproval = onApproval;
		this.maxBodyBytes = maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
		this.limiter = new PublicLimiter(ambient, { maxGlobalPerWindow, maxPerIdPerWindow, rateLimitWindowMs });
		this.handleRequest = this.handleRequest.bind(this);
	}

	public start(): void {
		throw new Error("PublicApproval requires RouterServer");
	}

	public stop(): void {}

	public async handleRequest(req: Request): Promise<Response> {
		if (req.method !== "POST") return notFound();
		if (this.limiter.globalLimited()) return tooManyRequests();

		const contentLength = Number(req.headers.get("content-length") ?? 0);
		if (contentLength > this.maxBodyBytes) return payloadTooLarge();

		let raw: string;
		try {
			raw = await req.text();
		} catch {
			return notFound();
		}
		if (raw.length > this.maxBodyBytes) return payloadTooLarge();

		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return notFound();
		}

		const parsed = ConsoleApprovalOpSchema.safeParse(body);
		if (!parsed.success) return notFound();
		const op = parsed.data;
		if (op.step !== "join" && op.step !== "fetch") return notFound();

		if (this.limiter.idLimited(op.approvalId)) return tooManyRequests();

		const result = await this.onApproval(op);
		return json(result, 200);
	}
}

function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function notFound(): Response {
	return new Response("Not Found", { status: 404 });
}

function payloadTooLarge(): Response {
	return new Response("Payload Too Large", { status: 413 });
}

function tooManyRequests(): Response {
	return new Response("Too Many Requests", { status: 429 });
}
