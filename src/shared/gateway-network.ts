/**
 * External to the Gateway's compose, so `compose down` never pulls it from an attached devcontainer.
 * `docker-compose.yml` and `start-gateway.sh` spell it too.
 */
export const GATEWAY_NETWORK = "switchboard";
