# Build context is the Actor root (integrations/apify-captchano/).
# Stage 1: compile TypeScript.
FROM apify/actor-node:22 AS builder

COPY --chown=myuser:myuser package*.json ./
RUN npm ci --include=dev --audit=false --fund=false

COPY --chown=myuser:myuser tsconfig.json ./
COPY --chown=myuser:myuser src ./src
RUN npm run build

# Stage 2: production image with runtime dependencies only.
FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./
RUN npm ci --omit=dev --omit=optional --audit=false --fund=false \
    && echo "Node.js: $(node --version)" \
    && echo "npm: $(npm --version)" \
    && rm -rf ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist
COPY --chown=myuser:myuser .actor ./.actor

CMD ["npm", "run", "start", "--silent"]
