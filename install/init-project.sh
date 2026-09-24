#!/usr/bin/env bash
# =============================================================================
# AI Kit — per-repo init.   cd <app repo> && ai-init      (idempotent; re-run anytime)
#
#   .agents/ai-stack.md          the site's AI map — surfaces, models per task, actions, data owners,
#                                live channels, tracking/analytics hand-offs — auto-drafted from the
#                                repo (deps, routes, tables, helix-style modules); edit it
#   .agents/ai-kit.env           per-repo tool env (gitignored)
#   evals/                       cases.json (the ai-evolve gate) + decisions.json (typed-decision suite)
#                                + promptfoo eval / red-team configs
#   AGENTS.md / CLAUDE.md        marked AI Kit block
#   .claude/settings.json        vendor plugins for THIS repo (Resend inbox, Telnyx AI)
#   .claude/skills/              curated upstream skills, linked live (git-excluded)
#   MCP ai-site                  the app's action registry as MCP (once package.json has ai:mcp)
#   verify.sh                    marked `AI guard tests` step (ai:test) IF the Starter Kit gate exists
#   sibling hand-offs            pointer blocks in Marketing Kit growth-stack / Security Kit context
#   .github/workflows/           webhook receiver for kit pushes → auto-re-sync PR
# =============================================================================
set -euo pipefail
SELF="${BASH_SOURCE[0]}"; while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
KIT_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
# shellcheck source=install/lib.sh
. "$KIT_ROOT/install/lib.sh"
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"
echo "── ai-init · $REPO"
mkdir -p .agents evals

# --- ai-stack.md (drafted once; yours afterwards) -------------------------------------------
if [ ! -f .agents/ai-stack.md ]; then
    python3 - "$REPO" > .agents/ai-stack.md <<'PY'
import json, os, re, sys
root = sys.argv[1]
pkg = {}
try: pkg = json.load(open(os.path.join(root, "package.json")))
except Exception: pass
deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
has = lambda *n: [x for x in n if x in deps]
src, files, tables, sse, ai_dirs = {}, [], set(), [], set()
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in ("node_modules", ".git", "dist", "build", ".next", ".claude", "worktrees", "migrations", "evals")]
    rel = os.path.relpath(dp, root)
    if re.search(r"(^|/)(assistant|ai|chat|chatbot|bot|copilot)$", rel): ai_dirs.add(rel)
    for f in fn:
        if not f.endswith((".ts", ".tsx", ".js")): continue
        p = os.path.join(dp, f)
        try: t = open(p, encoding="utf-8", errors="ignore").read()
        except Exception: continue
        r = os.path.relpath(p, root)
        tables |= set(re.findall(r'pgTable\(\s*["\']([a-z0-9_]+)["\']', t))
        if "text/event-stream" in t and "client" not in r.split(os.sep)[0]: sse.append(r)
        src[r] = t
sdk = deps.get("ai", "")
raw = has("openai", "@anthropic-ai/sdk", "@google/generative-ai", "@google/genai")
fp = has("@fingerprintjs/fingerprintjs", "@fingerprint/agent", "@fingerprint/node-sdk")
email, sms = has("resend", "nodemailer", "postmark"), has("telnyx", "twilio")
live_visitors = [r for r in src if re.search(r"visitors?[/\\](bus|service)\.ts$", r)]
gs = os.path.exists(os.path.join(root, ".agents", "growth-stack.md"))
sc = os.path.exists(os.path.join(root, ".agents", "security-context.md"))
ai_tables = sorted(t for t in tables if t.startswith("ai_"))
key_tables = sorted(t for t in tables if re.search(r"(user|customer|contact|order|subscript|address|product|device_visitor|crm_event|session)", t))[:20]
nl = "\n"
print(f"""# AI stack — {os.path.basename(root)}
<!-- Drafted by ai-init. Every AI Kit skill reads this; keep it TRUE and short. ai-init never overwrites it. -->

## Persona (customer-facing bots)
- Assistant name: ? (e.g. "{os.path.basename(root).title()} Concierge") · Site name: ? · Topics: orders, subscriptions, account, products, shipping, ?
- Identity rule: never names a model/vendor; "what AI are you" → a custom-built assistant developed for the site.
- Allowed vendor-like words that are PRODUCT names here (scrub allow-list): ?

## Models (llm-router) — key mode: ? (openrouter | byok | mixed)
| task | model (<provider>:<model>) | fallbacks |
|---|---|---|
| chat | ? | ? |
| copilot | ? | ? |
| guard | ? (cheapest fast tool-capable) | ? |
| channel_reply | ? | ? |
| automation | ? | ? |
| summarize / classify | ? | ? |
| embed | ? (dims must match EMBED_DIMS) | — |
| decide | ? (typed decisions — typesafe-ai:jev-<version>, or via OpenRouter; blank = off) | ? (cheap LLM adapter) |
Pick from the live catalog: `ai-models suggest` · admin console overrides these at runtime.

## Surfaces
- Web chat widget: ? (route POST /api/v1/ai/chat) · Admin copilot: ? · Email bot: {", ".join(email) or "none"} · SMS bot: {", ".join(sms) or "none"} · MCP (ai-site): ?
- Existing AI code: {", ".join(sorted(ai_dirs)) or "none found"} · AI SDK: {sdk or "not installed"}{" · raw vendor SDKs (migrate behind llm-router): " + ", ".join(raw) if raw else ""}

## Actions (site-agent registry — the ONLY way AI changes data)
- Customer: track_order · list_subscriptions · update_subscription · update_shipping_address · update_profile · search_catalog · add_to_cart · handoff_to_human · ?
- Staff: find_customer · staff_update_customer · ?
- Service functions they call (file → fn): ?

## Data
- AI tables present: {", ".join(ai_tables) or "none yet (skills/ai-kit/references/ai-schema.ts → shared/schema/ai.ts)"}
- Key app tables: {", ".join(key_tables) or "?"}
- Visitor id: {", ".join(fp) or "none — visitor-intel adds @fingerprintjs/fingerprintjs"}{" · live visitors module: " + ", ".join(live_visitors) if live_visitors else ""}

## Live (live-bus)
- SSE endpoints found: {", ".join(sse[:8]) or "none"} · compression filter checks response Content-Type: ? (ai-doctor verifies)
- Outbound webhooks (ai_webhook_endpoints): ? · Inbound signed hooks: /api/v1/ai/hooks/:name ?

## Tracking + analytics
- Site-wide events: {"Marketing Kit journey-analytics (crm_events) — AI events are forwarded, never duplicated" if gs else "ai-analytics' own collector (no Marketing Kit growth-stack found)"}
- AI numbers: ai_calls / ai_conversations / ai_actions / ai_feedback (ai-analytics is the only writer) · `ai-report`
- Attribution window for AI-assisted orders: 24h (?)

## Evolve
- ai-settings evolve: auto · eval gate: evals/cases.json (min score AI_EVAL_MIN=0.9) · canary 10%
- Security Kit context: {"present — AI surface block appended" if sc else "not initialised (optional: sec-init)"}
""")
PY
    echo "  · .agents/ai-stack.md drafted — fill the ? lines ✓"
else
    # kept — except drafted "not found" lines that are no longer true (a line you edited is never touched)
    python3 - .agents/ai-stack.md <<'PY'
import os, sys
p = sys.argv[1]; s = open(p).read(); o = s
if os.path.exists(".agents/growth-stack.md"):
    s = s.replace("ai-analytics' own collector (no Marketing Kit growth-stack found)",
                  "Marketing Kit journey-analytics (crm_events) — AI events are forwarded, never duplicated")
if os.path.exists(".agents/security-context.md"):
    s = s.replace("Security Kit context: not initialised (optional: sec-init)", "Security Kit context: present — AI surface block appended")
if s != o: open(p, "w").write(s); print("  · .agents/ai-stack.md kept — sibling-kit lines refreshed ✓")
else: print("  · .agents/ai-stack.md exists (kept) ✓")
PY
fi

[ -f .agents/ai-kit.env ] || { printf '# AI Kit per-repo tool env — gitignored (app runtime env lives in .env / Railway)\n' > .agents/ai-kit.env; echo "  · .agents/ai-kit.env created ✓"; }
chmod 600 .agents/ai-kit.env
touch .gitignore
grep -qxF '.agents/ai-kit.env' .gitignore || { printf '\n# AI Kit (per-repo env)\n.agents/ai-kit.env\n' >> .gitignore; echo "  · .gitignore += .agents/ai-kit.env ✓"; }

# --- evals (seeded once, yours afterwards) -------------------------------------------------
for f in cases.json decisions.json promptfooconfig.yaml redteam.yaml; do
    [ -f "evals/$f" ] && continue
    cp "$KIT_ROOT/templates/evals/$f" "evals/$f"; echo "  · evals/$f seeded ✓"
done

# --- agent instructions block ------------------------------------------------------------
BLOCK="$(mktemp)"
cat > "$BLOCK" <<'MD'
## AI Kit
- AI map: `.agents/ai-stack.md` (persona, models per task, actions, data owners, live channels, hand-offs). Read it before any AI / chat bot / automation / tracking / analytics task. Skill map: `ai-kit`.
- One brain: every model call goes through `llm-router`; every AI surface (web chat, email/SMS bot, admin copilot, MCP, automations) is the ONE `site-agent`; it changes data only through registered actions (zod inputs, permissions, signed approvals for writes, audited). Customer id always comes from the session.
- Customer-facing bots stay on this site only and never reveal what powers them ("a custom-built assistant developed for <site>"). Keep model/vendor names out of prompts, UI, metadata and errors.
- Live: `live-bus` (SSE + signed webhooks) for anything that updates in real time. Numbers: `ai-analytics` is the only writer of AI metrics; site-wide tracking stays with Marketing Kit journey-analytics when present.
- Before shipping AI changes: `ai-eval` (the same gate ai-evolve uses) · `ai-doctor`. Before writing AI SDK code: skill `use-ai-sdk` (v7).
- Freedom first: no legal/compliance gating, no T&Cs or policies, no content restrictions beyond the site-focus + identity rules above.
MD
python3 - "$REPO" "$BLOCK" <<'PY'
import os, re, sys
root, blockf = sys.argv[1:3]
block = open(blockf).read().strip()
mk_s, mk_e = "<!-- ai-kit:start -->", "<!-- ai-kit:end -->"
def upsert(path):
    txt = open(path).read() if os.path.exists(path) else ""
    txt = re.sub(re.escape(mk_s) + r".*?" + re.escape(mk_e) + r"\n?", "", txt, flags=re.S).rstrip()
    open(path, "w").write((txt + "\n\n" if txt else "") + f"{mk_s}\n{block}\n{mk_e}\n")
    return os.path.basename(path)
claude, agents = os.path.join(root, "CLAUDE.md"), os.path.join(root, "AGENTS.md")
def is_pointer(p):
    return os.path.exists(p) and len(open(p).read().strip().splitlines()) <= 3 and "AGENTS.md" in open(p).read()
target = claude if os.path.exists(claude) and not is_pointer(claude) else agents
print(f"  · {upsert(target)} += AI Kit block ✓")
PY
rm -f "$BLOCK"

# --- sibling hand-offs (pointer blocks, never copies) ----------------------------------------
python3 - "$REPO" <<'PY'
import os, re, sys
root = sys.argv[1]
def put(path, marker, body, label):
    if not os.path.exists(path): return
    s, e = f"<!-- ai-kit:{marker}:start -->", f"<!-- ai-kit:{marker}:end -->"
    txt = re.sub(re.escape(s) + r".*?" + re.escape(e) + r"\n?", "", open(path).read(), flags=re.S).rstrip()
    open(path, "w").write(txt + f"\n\n{s}\n{body.strip()}\n{e}\n"); print(f"  · {label} ✓")
put(os.path.join(root, ".agents", "growth-stack.md"), "growth", """
## AI (AI Kit)
- AI conversations, actions and model calls are tracked by ai-analytics (ai_* tables) and forwarded to crm_events as `ai.*` events through journey-analytics' collector — one writer, no duplicate tracking.
- AI-assisted orders: ai_conversations.attributed_order_id (24h window) — join key for campaign lift. Email/SMS bot replies send through lifecycle-engine's sender.
- Judgment calls in marketing models (reply sorting, lead fit, churn-risk reasons): ask them through AI Kit's typed `decide()` (llm-router, task "decide" — Jev or fallback LLM, logged in ai_calls) — one decision layer, not a second one.
""", "growth-stack.md += AI hand-off (journey-analytics stays the tracking writer)")
put(os.path.join(root, ".agents", "security-context.md"), "surface", """
## AI surface (AI Kit) — red-team these
- POST /api/v1/ai/chat (streams; guest + customer) · GET /api/v1/ai/chat/:id(/live) · POST /api/v1/ai/eval (bearer AI_EVAL_TOKEN) · /api/v1/ai/mcp (bearer AI_MCP_TOKENS) · /api/v1/ai/hooks/:name (Standard Webhooks sig) · /api/v1/admin/ai/* (staff)
- Invariants to attack: customer id from session only · write actions need an HMAC-signed approval (AI_APPROVAL_SECRET) · staff tools never exposed to customers · no model/vendor name leaks · guest conversations bound to an httpOnly cookie, not the (client-claimed) visitor id
- Typed-decision seams (when a decide task is set): guard stage 2 passes turns it is unsure about (confidence < AI_GUARD_MIN) by design — probe for low-confidence bypasses; channel triage drops mail it scores "not a person" — probe for suppressed real customers; automation gates skip below min
- Tools: ai-eval redteam (promptfoo) · evals/cases.json + evals/decisions.json regressions
""", "security-context.md += AI attack surface")
PY

# --- Claude Code: per-repo vendor plugins --------------------------------------------------
CLAUDE_BIN="$(find_claude || true)"
if [ "${AI_NO_PLUGINS:-0}" != 1 ] && [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
    while IFS=$'\t' read -r plugin _ scope _; do
        case "$plugin" in ''|\#*) continue ;; esac
        [ "$scope" = project ] || continue
        if grep -q "\"$plugin\": *true" .claude/settings.json 2>/dev/null; then
            "$CLAUDE_BIN" plugin update "$plugin" --scope project >/dev/null 2>&1; echo "  · $plugin enabled for this repo (updated) ✓"
        elif "$CLAUDE_BIN" plugin install "$plugin" --scope project >/dev/null 2>&1; then echo "  · $plugin enabled for this repo ✓"
        else echo "  ⚠ $plugin: run the kit installer first (registers the marketplace), then ai-init again"; fi
    done < "$KIT_ROOT/install/claude-plugins.tsv"
elif [ "${AI_NO_PLUGINS:-0}" != 1 ]; then
    mkdir -p .claude
    python3 - "$KIT_ROOT/install/claude-plugins.tsv" <<'PY'
import json, os, sys
p = ".claude/settings.json"
s = json.load(open(p)) if os.path.exists(p) else {}
ep = s.setdefault("enabledPlugins", {})
want = [f[0] for f in (l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")) if len(f) >= 3 and f[2] == "project"]
missing = [w for w in want if ep.get(w) is not True]
if missing:
    for w in missing: ep[w] = True
    json.dump(s, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
    echo "  · claude CLI not found — project plugins enabled in .claude/settings.json (installed on first Claude Code open) ✓"
fi

# --- curated upstream skills (link into THIS repo only) ---------------------------------------
if [ "${AI_NO_PLUGINS:-0}" != 1 ]; then
    [ -d "$AI_UPSTREAM" ] || { echo "  · curated upstream skills: first run — cloning"; sync_upstream_checkouts "$KIT_ROOT" >/dev/null; }
    link_upstream_skills "$KIT_ROOT" .claude/skills claude
    if git rev-parse --git-dir >/dev/null 2>&1; then
        EXCL="$(git rev-parse --git-path info/exclude)"; mkdir -p "$(dirname "$EXCL")"; touch "$EXCL"
        python3 - "$EXCL" "$KIT_ROOT/install/upstream-skills.tsv" <<'PY'
import re, sys
p, man = sys.argv[1], sys.argv[2]
names = sorted({l.split("\t")[0].rsplit("/", 1)[-1] for l in open(man) if l.strip() and not l.startswith("#")})
s, e = "# >>> ai-kit curated skills (symlinks into ~/.local/share/ai-kit)", "# <<< ai-kit curated skills"
txt = re.sub(re.escape(s) + r".*?" + re.escape(e) + r"\n?", "", open(p).read(), flags=re.S).rstrip("\n")
open(p, "w").write((txt + "\n" if txt else "") + s + "\n" + "".join(f"/.claude/skills/{n}\n" for n in names) + e + "\n")
PY
        echo "  · curated skill links git-excluded (.git/info/exclude) ✓"
    fi
fi

# --- MCP: the site's own action registry --------------------------------------------------
if grep -q '"ai:mcp"' package.json 2>/dev/null; then
    if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] && [ "${AI_NO_PLUGINS:-0}" != 1 ]; then
        "$CLAUDE_BIN" mcp remove -s local ai-site >/dev/null 2>&1 || true
        "$CLAUDE_BIN" mcp add -s local ai-site -- "$(command -v ai-mcp || echo "$KIT_ROOT/bin/ai-mcp")" site >/dev/null 2>&1 \
            && echo "  · ai-site MCP registered for this repo (the app's actions, staff identity AI_MCP_STAFF) ✓" \
            || echo "  ⚠ ai-site MCP add failed — claude mcp add -s local ai-site -- ai-mcp site"
    fi
else
    echo "  · ai-site MCP: add an \"ai:mcp\" script (site-agent mcp.ts → serveStdio) and re-run ai-init to register it"
fi

# --- Skill Starter Kit verify gate -------------------------------------------------------------
if [ -f verify.sh ]; then
    python3 - verify.sh <<'PY'
import re, sys
p = sys.argv[1]; txt = open(p).read()
s, e = "# >>> ai-kit", "# <<< ai-kit"
txt = re.sub(re.escape(s) + r".*?" + re.escape(e) + r"\n*", "", txt, flags=re.S)
block = f'''{s}
if grep -q '"ai:test"' package.json 2>/dev/null; then
  step "AI guard tests"    # AI Kit: identity lock, scope lock, signed approvals, scrub — mock models, offline
  npm run -s ai:test || exit 1
fi
{e}
'''
m = re.search(r"^printf '\\n✓ verify passed.*$", txt, flags=re.M)
txt = txt[:m.start()] + block + "\n" + txt[m.start():] if m else txt.rstrip() + "\n\n" + block
open(p, "w").write(txt)
print("  · verify.sh += AI guard tests step (runs when package.json has ai:test) ✓")
PY
else
    echo "  · no verify.sh (Skill Starter Kit gate) — run AI tests separately"
fi

# --- GitHub webhook receiver --------------------------------------------------------------
if git remote get-url origin 2>/dev/null | grep -q "github.com"; then
    KIT_SLUG="$( (git -C "$KIT_ROOT" remote get-url origin 2>/dev/null || true) | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"; KIT_SLUG="${KIT_SLUG:-feelthefusion/ai-kit}"
    mkdir -p .github/workflows
    sed "s#__KIT_REPO__#${KIT_SLUG:-feelthefusion/ai-kit}#" "$KIT_ROOT/templates/github/ai-kit-sync.yml" > .github/workflows/ai-kit-sync.yml
    echo "  · .github/workflows/ai-kit-sync.yml (webhook receiver) ✓"
fi

git -C "$KIT_ROOT" rev-parse --short=12 HEAD > .agents/.ai-kit-version 2>/dev/null || true
echo "Next: fill the ? lines in .agents/ai-stack.md · ai-models suggest · ai-doctor"
