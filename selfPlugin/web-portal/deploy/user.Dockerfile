FROM deepseek-harness-runtime:node24

# Build from the Harness root on the Linux host, preserving its offline workspace dependencies.
COPY . /app
RUN mkdir -p /home/node/.dsh /workspace && chown -R 1000:1000 /home/node /workspace
ENV HOME=/home/node DSH_HOME=/home/node/.dsh NODE_ENV=production
WORKDIR /workspace
USER 1000:1000
EXPOSE 3080
ENTRYPOINT ["node", "/app/selfPlugin/web-portal/scripts/user-entrypoint.mjs"]
