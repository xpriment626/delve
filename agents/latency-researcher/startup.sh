#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
exec node dist/src/eve-coral-agent.js --role latency-researcher --max-messages 3
