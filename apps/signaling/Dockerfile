# Signaling server. Tiny by design: it relays a few kilobytes of SDP and ICE
# per connection and never touches media, so it runs comfortably on the
# cheapest VPS available.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the whole tree.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/signaling-protocol/package.json ./packages/signaling-protocol/
COPY apps/signaling/package.json ./apps/signaling/
RUN pnpm install --frozen-lockfile --filter @janja/signaling... --prod=false

COPY packages/signaling-protocol ./packages/signaling-protocol
COPY apps/signaling ./apps/signaling

# Run as a non-root user: this process is exposed to the internet.
USER node

ENV NODE_ENV=production
ENV SIGNALING_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SIGNALING_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@janja/signaling", "start"]
