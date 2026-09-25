#!/bin/sh
set -eu

mkdir -p /app/data/uploads
chown -R node:node /app/data
exec su -s /bin/sh node -c "exec $*"
