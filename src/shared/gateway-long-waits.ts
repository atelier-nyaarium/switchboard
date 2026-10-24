const LONG_WAITS = [
	"POST /send",
	"POST /task-board",
	"POST /vault/use",
	"POST /vault/collect",
	"POST /vault/capture",
	"POST /vault/askpass",
	"POST /assistant/send",
] as const;

export type GatewayLongWaitRoute = (typeof LONG_WAITS)[number];

export const GATEWAY_LONG_WAIT_ROUTES: ReadonlySet<GatewayLongWaitRoute> = new Set(LONG_WAITS);

/** Routes safe to replay. */
const REPLAYED_LONG_WAITS: ReadonlySet<GatewayLongWaitRoute> = new Set(["POST /task-board"]);

export function isGatewayLongWaitRoute(method: string, pathname: string): boolean {
	return method.toUpperCase() === "POST" && GATEWAY_LONG_WAIT_ROUTES.has(`POST ${pathname}` as GatewayLongWaitRoute);
}

export function resendsAfterFailure(method: string, pathname: string): boolean {
	if (!isGatewayLongWaitRoute(method, pathname)) return true;
	return REPLAYED_LONG_WAITS.has(`POST ${pathname}` as GatewayLongWaitRoute);
}
