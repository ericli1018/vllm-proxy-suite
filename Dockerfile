FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node apps ./apps
COPY --chown=node:node packages ./packages
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node vllm-proxy-suite.js ./

USER node

CMD ["node", "/app/vllm-proxy-suite.js"]
