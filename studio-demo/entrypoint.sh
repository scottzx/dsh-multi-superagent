#!/bin/sh
# Demo container entrypoint: boot the DSH superagent profile (loopback), then
# front it with nginx on 0.0.0.0:7860. The docs site stays at /demo/.
set -e

mkdir -p /mnt/workspace/dsh-state

LOG=/tmp/dsh-web.log
dsh --profile superagent --no-open \
    --public-url https://scott887-dsh-superagent-demo.ms.show/ \
    --trusted-host scott887-dsh-superagent-demo.ms.show \
    --trusted-host 127.0.0.1:3082 \
    --trusted-host localhost:3082 >"$LOG" 2>&1 &
DSH_PID=$!
sleep 3
if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "[entrypoint] dsh exited with extra flags; retrying without them"
    dsh --profile superagent --no-open >"$LOG" 2>&1 &
    DSH_PID=$!
fi

# The web login token is printed on boot; bake it into the nginx config so a
# bare visit to / lands inside the panel.
TOKEN=""
i=0
while [ "$i" -lt 30 ]; do
    TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | head -n 1 | cut -d= -f2)
    [ -n "$TOKEN" ] && break
    i=$((i + 1))
    sleep 1
done

sed "s|{{TOKEN}}|$TOKEN|g" /opt/dsh-superagent/studio-demo/nginx.conf.template \
    > /etc/nginx/conf.d/dsh-demo.conf

if [ -n "$TOKEN" ]; then
    echo "[entrypoint] dsh web ready; panel token captured"
else
    echo "[entrypoint] WARN: no web token in $LOG yet; / redirects to a blank token"
fi
echo "[entrypoint] nginx listening on 7860 (panel at /, docs at /demo/)"
exec nginx -g 'daemon off;'
