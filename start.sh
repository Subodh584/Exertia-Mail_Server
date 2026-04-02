#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Exertia Mail Server — Start + Cloudflare Tunnel
#
# Usage:
#   chmod +x start.sh   (only once)
#   ./start.sh
#
# What it does:
#   1. Checks that .env exists (refuses to start without it)
#   2. Installs npm deps if node_modules is missing
#   3. Starts the Node server in the background
#   4. Runs `cloudflared tunnel --url http://localhost:PORT`
#   5. Watches cloudflared output — as soon as it prints the tunnel URL,
#      it automatically updates the `url` column in the `mail_url` Supabase table
#      so the iOS app instantly picks it up.
#   6. On Ctrl-C the script kills both the server and the tunnel cleanly.
# ─────────────────────────────────────────────────────────────────────────────

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 1. Check .env ─────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
    echo ""
    echo "❌  .env file not found!"
    echo "    Copy .env.example → .env and fill in your credentials."
    echo ""
    exit 1
fi

# Load env vars for Supabase auto-update
# Safely parses .env: skips blank lines, strips inline comments, handles special chars
while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comment lines
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Strip inline comment (anything after ' #' or '\t#')
    line="${line%%[[:space:]]#*}"
    # Only export lines that look like KEY=VALUE
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        export "$line"
    fi
done < .env
PORT="${PORT:-3000}"

# ── 2. Install deps if needed ─────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
    echo "📦  node_modules not found — running npm install…"
    npm install
fi

# ── 3. Check cloudflared is installed ─────────────────────────────────────────
if ! command -v cloudflared &> /dev/null; then
    echo ""
    echo "❌  cloudflared not found!"
    echo "    Install it with:  brew install cloudflared"
    echo "    Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/"
    echo ""
    exit 1
fi

# Use a local log file — Termux (and some Linux envs) block writes to /tmp
CF_LOG="$SCRIPT_DIR/.cf_out.txt"
SB_RESP="$SCRIPT_DIR/.sb_resp.txt"

# ── 5. Cleanup on exit ────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
    [ -f "$CF_LOG"  ] && rm -f "$CF_LOG"
    [ -f "$SB_RESP" ] && rm -f "$SB_RESP"
    echo "All processes stopped."
    exit 0
}
trap cleanup SIGINT SIGTERM

# ── 6. Start Node server ───────────────────────────────────────────────────────
echo ""
echo "   Starting Exertia Mail Server on port $PORT..."
node server.js &
SERVER_PID=$!
sleep 1   # give Node a moment to bind

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "❌  Node server failed to start. Check your .env and try again."
    exit 1
fi
echo "✅  Node server running (PID $SERVER_PID)"

# ── 7. Start Cloudflare tunnel ─────────────────────────────────────────────────
echo "🌐  Starting Cloudflare tunnel…"
cloudflared tunnel --url "http://localhost:$PORT" > "$CF_LOG" 2>&1 &
TUNNEL_PID=$!

# ── 8. Watch for the tunnel URL and push it to Supabase ──────────────────────
echo "⏳  Waiting for tunnel URL…"
TUNNEL_URL=""
for i in $(seq 1 30); do
    sleep 1
    TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
done

if [ -z "$TUNNEL_URL" ]; then
    echo ""
    echo "⚠️   Could not detect tunnel URL after 30s."
    echo "     Check .cf_out.txt in the mailServer folder for cloudflared output."
    echo "     Update the url column in Supabase mail_url table manually."
else
    echo ""
    echo "🔗  Tunnel URL: $TUNNEL_URL"

    # Push URL to Supabase via REST API
    if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ]; then
        echo "📡  Updating mail_url in Supabase…"
        HTTP_STATUS=$(curl -s -o "$SB_RESP" -w "%{http_code}" \
            -X PATCH \
            "${SUPABASE_URL}/rest/v1/mail_url?id=eq.1" \
            -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
            -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
            -H "Content-Type: application/json" \
            -H "Prefer: return=minimal" \
            -d "{\"url\": \"${TUNNEL_URL}\"}")

        if [ "$HTTP_STATUS" = "204" ] || [ "$HTTP_STATUS" = "200" ]; then
            echo "✅  Supabase mail_url updated → $TUNNEL_URL"
        else
            echo "⚠️   Supabase update returned HTTP $HTTP_STATUS"
            echo "     Response: $(cat "$SB_RESP" 2>/dev/null)"
            echo "     Update manually: set url = '$TUNNEL_URL' in the mail_url table."
        fi
    else
        echo "⚠️   SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env"
        echo "     Update mail_url manually: $TUNNEL_URL"
    fi
fi

echo ""
echo "────────────────────────────────────────────────────"
echo "  ✉️   Exertia Mail Server is LIVE"
echo "  🌐  Tunnel : $TUNNEL_URL"
echo "  🖥️   Local  : http://localhost:$PORT"
echo "  Press Ctrl-C to stop."
echo "────────────────────────────────────────────────────"
echo ""

# ── 9. Stream logs from both processes ────────────────────────────────────────
tail -f "$CF_LOG" 2>/dev/null &
wait "$SERVER_PID"
