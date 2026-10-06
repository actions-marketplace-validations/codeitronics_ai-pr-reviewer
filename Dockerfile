FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY bin ./bin
COPY dist/cli.js ./dist/cli.js
COPY ui ./ui
USER node
EXPOSE 4600
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4600/healthz || exit 1
CMD ["node", "bin/ai-pr-reviewer.js", "ui", "--host", "0.0.0.0", "--port", "4600"]
