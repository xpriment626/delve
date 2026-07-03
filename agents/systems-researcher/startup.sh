#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
node_bin="${DELVE_NODE_BIN:-node}"
exec "$node_bin" dist/src/eve-coral-agent.js --role systems-researcher --max-messages 3
