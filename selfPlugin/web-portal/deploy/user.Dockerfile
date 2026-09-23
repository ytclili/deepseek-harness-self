ARG BASE_IMAGE=deepseek-harness-runtime:node24
FROM ${BASE_IMAGE}

# Build from the Harness root on the Linux host, preserving its offline workspace dependencies.
COPY payload/ /app/
RUN chmod -R a+rX /app && mkdir -p /home/node/.dsh /workspace && chown -R 1000:1000 /home/node /workspace
ENV HOME=/home/node DSH_HOME=/home/node/.dsh NODE_ENV=production
WORKDIR /workspace
USER 1000:1000
EXPOSE 3080
ENTRYPOINT ["node", "/app/selfPlugin/web-portal/scripts/user-entrypoint.mjs"]
