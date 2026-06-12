#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
exec node "$PROJECT_ROOT/node_modules/tsx/dist/cli.cjs" src/dashboard/start-dashboard.ts "$@"
