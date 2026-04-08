#!/bin/bash
set -e

echo "═══ flightterm v2 deployment ═══"
echo ""

# 1. Generate shared secret
SECRET=$(openssl rand -hex 32)
echo "✓ Generated internal secret"

# 2. Set secret on main app
fly secrets set SWIM_INTERNAL_SECRET="$SECRET" -a flighttermv2 2>/dev/null
echo "✓ Set secret on flighttermv2"

# 3. Deploy main app
echo ""
echo "── Deploying flighttermv2 (main app) ──"
fly deploy -c fly.v2.toml

# 4. Create worker app (ignore error if already exists)
echo ""
echo "── Setting up flightterm-swim (worker) ──"
fly apps create flightterm-swim 2>/dev/null || echo "  (app already exists)"

# 5. Copy SWIM secrets from flightterm to worker
fly ssh console -a flightterm -C "env" 2>&1 | grep -E "^SWIM_" | fly secrets import -a flightterm-swim 2>/dev/null
fly secrets set SWIM_INTERNAL_SECRET="$SECRET" MAIN_APP_URL="http://flighttermv2.internal:3001" -a flightterm-swim 2>/dev/null
echo "✓ Set secrets on flightterm-swim"

# 6. Deploy worker
echo ""
echo "── Deploying flightterm-swim (worker) ──"
fly deploy -c fly.swim.toml

echo ""
echo "═══ Done ═══"
echo "  Main:   https://flighttermv2.fly.dev"
echo "  Worker: https://flightterm-swim.fly.dev/health"
echo ""
echo "  To tear down: fly apps destroy flightterm-swim && fly apps destroy flighttermv2"
