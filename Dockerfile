# syntax=docker/dockerfile:1.7

# --- builder ----------------------------------------------------------------
# Runs `tsc` against the full source tree. devDependencies (tsx, typescript,
# @types/*) are needed at this stage to type-check and emit dist/, then thrown
# away before we ship the runtime image.
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies in place so the runtime stage can copy node_modules
# wholesale without duplicating the install.
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# The Streamable-HTTP transport listens here by default; the chart sets the
# same value via the PORT env so the Service's targetPort and the
# containerPort line up automatically when both are overridden together.
EXPOSE 8787

# Don't run as root — the base image ships a `node` user.
USER node

CMD ["node", "dist/http.js"]
