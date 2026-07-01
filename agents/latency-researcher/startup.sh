#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
exec npx -y tsx src/eve-coral-agent.ts --role latency-researcher --max-messages 2
