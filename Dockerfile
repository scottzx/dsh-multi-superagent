# ModelScope Studio demo: DSH runtime + dsh-superagent bundle + docs site.
# DSH panel at / (token login), docs site at /demo/. Must listen on 0.0.0.0:7860.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux python3 nginx ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

# DSH runtime, version pinned by docs/006-deployment.md; pnpm pinned by packageManager.
RUN npm install -g @deepseek-ai/dsh@0.2.1-rc.3 pnpm@11.7.0

WORKDIR /opt/dsh-superagent
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Profile "superagent" from the shipped Web template, with this bundle linked in.
ENV DSH_HOME=/opt/dsh-home
RUN dsh superagent --from-default-profile web --dump-config > /dev/null \
 && dsh plugin --profile superagent add "link:/opt/dsh-superagent"
COPY studio-demo/profile.cordis.patch.yml /opt/dsh-home/profiles/superagent/cordis.patch.yml

COPY studio-demo/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860
CMD ["/entrypoint.sh"]
