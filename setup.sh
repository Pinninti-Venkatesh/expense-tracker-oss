#!/bin/sh
# Starts your own copy of Expense Tracker with Docker, then tells you where to
# open it. There are no questions here: you set it up in the browser.
#
#   ./setup.sh
#
# Run it again any time to update to the latest version and restart.
set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Please install Docker Desktop first: https://www.docker.com/products/docker-desktop/"
  echo "Then open a terminal in this folder and run ./setup.sh again."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Open Docker Desktop, wait for it to start, then run ./setup.sh again."
  exit 1
fi

echo "Starting Expense Tracker (the first time takes a few minutes)…"
docker compose up -d --build

# Wait for it to answer, then show the setup code if it hasn't been set up yet.
i=0
until docker compose logs app 2>/dev/null | grep -q "Listening on"; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "It didn't start. Here is what it said:"
    docker compose logs --tail 30 app
    exit 1
  fi
  sleep 1
done

# Asked of the app itself, so a code from an earlier start is never shown once
# it has been set up.
NEEDED=$(docker compose exec -T app node -e "fetch('http://localhost:8080/api/session').then((r) => r.json()).then((s) => console.log(s.setup && s.setup.needed ? 'yes' : 'no')).catch(() => console.log('no'))" 2>/dev/null || echo no)
echo ""
echo "Running. Open http://localhost:8080"
if [ "$NEEDED" = "yes" ]; then
  CODE=$(docker compose logs app 2>/dev/null | sed -n 's/.*enter this setup code: \([0-9-]*\).*/\1/p' | tail -n 1)
  echo "It will ask for this setup code: $CODE"
fi
