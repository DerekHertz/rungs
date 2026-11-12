#!/bin/bash
# Stop the local server listening on one port: scripts/stop-server.sh <port>
# Finds the process by the port it listens on, so it never matches the shell running this.
set -euo pipefail
port=$1
pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
if [ -z "$pids" ]; then echo "nothing listens on port $port"; exit 0; fi
kill $pids
echo "stopped $pids (port $port)"
