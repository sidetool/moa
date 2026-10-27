FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS styles
WORKDIR /app
COPY login.scss ./
RUN npx --yes --package sass@1.106.0 sass --no-source-map login.scss dist/login.css

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY --chown=node:node server.mjs accounts.mjs state.mjs moa-setup-code moa-admin setup.html join.html login.html login.js icon.svg ./
COPY --from=styles --chown=node:node /app/dist ./dist
COPY LICENSE NOTICE ./
RUN mkdir -p /data /config && chown node:node /data /config && chmod 700 /data /config \
    && chmod +x /app/moa-setup-code /app/moa-admin \
    && ln -s /app/moa-setup-code /usr/local/bin/moa-setup-code \
    && ln -s /app/moa-admin /usr/local/bin/moa-admin
USER node
ENV PORT=8789 DATA_DIR=/data
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8789/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
