FROM node:22-slim

# Everyday tools for the agent's shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates python3 python3-pip jq \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev --omit=optional
COPY src ./src
COPY public ./public
COPY crew ./crew
COPY marketplace ./marketplace
COPY quests ./quests
COPY legal ./legal
COPY LICENSE SECURITY.md THIRD_PARTY_NOTICES.md ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8787 TALQAVA_DATA_DIR=/app/data
EXPOSE 8787
CMD ["node", "src/local/main.ts"]
