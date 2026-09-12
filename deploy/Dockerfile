FROM node:24-bookworm-slim
WORKDIR /app
COPY service/ /app/service/
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data PORT=8788 LISTEN_HOST=0.0.0.0 BEHIND_TLS_PROXY=1 OWNER_KEY_FILE=/run/secrets/owner_key
EXPOSE 8788
CMD ["node", "service/server.mjs"]
