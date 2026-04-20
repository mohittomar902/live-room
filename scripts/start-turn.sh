#!/bin/zsh
set -euo pipefail

CONFIG_PATH="${1:-$(dirname "$0")/../turn/turnserver.conf}"

exec /opt/homebrew/opt/coturn/bin/turnserver -c "$CONFIG_PATH"
