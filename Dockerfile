FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

# No apt: firewalls block it.
WORKDIR /app
COPY package.json bun.lock ./
# Install runs the postinstall, which links nothing without lexicon/ in the image.
COPY scripts/link-lexicon.mjs scripts/
# CA bundle as a secret, never in a layer.
RUN --mount=type=secret,id=ssl_cert \
	if [ -s /run/secrets/ssl_cert ]; then \
		export SSL_CERT_FILE=/run/secrets/ssl_cert NODE_EXTRA_CA_CERTS=/run/secrets/ssl_cert; \
	fi; \
	bun install --frozen-lockfile --production
COPY src/ src/
COPY tsconfig.json ./

CMD ["bun", "run", "src/main-gateway.ts"]
