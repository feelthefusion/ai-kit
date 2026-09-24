#!/usr/bin/env bash
# =============================================================================
# AI Kit — shared installer library (sourced by install.sh / hermes.sh / init-project.sh)
#
# LIVE BY DESIGN — nothing third-party is cloned or copied into this repo:
#   * kit skills       → SYMLINKED from this checkout (bootstrap pulls it every run)
#   * curated upstream → install/upstream-skills.tsv, ONE list for both hosts. Claude Code:
#                        shallow checkouts in $AI_UPSTREAM (pulled by ai-update on session
#                        start) SYMLINKED per repo by ai-init; Hermes: hub installs + `hermes
#                        skills update`. Only listed skills exist → nothing duplicates.
#   * vendor packs     → Claude Code: plugins from each vendor's own marketplace (project scope,
#                        enabled per repo by ai-init); Hermes: install/hermes-skills.tsv via the hub.
#   * MCP              → `ai-mcp site` (the app's own action registry, per repo) + optional hosted
#                        Hugging Face MCP (ai-settings hf on). No pinned servers.
#   * app packages     → never vendored: ai-init / ai-update --deps resolve `@latest` from npm.
# =============================================================================

AI_BIN="$HOME/.local/bin"
AI_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/ai-kit"
AI_SECRETS="${AI_SECRETS:-$AI_CONF/secrets.env}"
KIT_SKILLS="ai-kit llm-router site-agent visitor-intel ai-analytics ai-knowledge ai-channels ai-automations live-bus ai-evolve ml-lab"
KIT_BINS="ai-doctor ai-update ai-settings ai-models ai-mcp ai-report ai-eval ai-webhooks"
AI_UPSTREAM="${AI_UPSTREAM:-${XDG_DATA_HOME:-$HOME/.local/share}/ai-kit/upstream}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  · %s ✓\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }

find_claude() {
    command -v claude 2>/dev/null && return
    local d="$HOME/Library/Application Support/Claude/claude-code"
    [ -d "$d" ] && ls -d "$d"/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1
}

kit_self_update() {  # $1 = kit root
    local root="$1" before after
    [ "${KIT_NO_PULL:-0}" = 1 ] && { say "▶ self-update skipped (KIT_NO_PULL=1)"; return 0; }
    git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || { say "▶ self-update skipped — not a git clone"; return 0; }
    say "▶ self-update: pulling latest AI Kit"
    if [ -n "$(git -C "$root" status --porcelain)" ]; then warn "local changes — not pulling (commit/stash to get updates)"; return 0; fi
    before="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo none)"
    git -C "$root" pull --ff-only --quiet 2>/dev/null || { warn "pull failed (offline/diverged/no upstream yet) — using local copy"; return 0; }
    after="$(git -C "$root" rev-parse --short HEAD)"
    [ "$before" = "$after" ] && ok "already at latest ($after)" || ok "updated $before → $after"
}

# Symlink one kit skill dir into a host skills dir (live link, never a copy).
link_skill() {  # link_skill <src-dir> <dst-dir>
    local src="$1" dst="$2"
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then ok "$(basename "$dst") linked"; return 0; fi
    { [ -e "$dst" ] || [ -L "$dst" ]; } && rm -rf "$dst"   # replace stale copy / old link / broken symlink
    ln -sfn "$src" "$dst" && ok "$(basename "$dst") → $src"
}

# ---- curated upstream skills (install/upstream-skills.tsv) ----------------------------------
upstream_rows()  { grep -v '^#' "$1/install/upstream-skills.tsv" | awk -F'\t' 'NF>=3'; }   # ident hosts trust owns
upstream_repos() { upstream_rows "$1" | cut -f1 | cut -d/ -f1-2 | sort -u; }
upstream_dir()   { printf '%s/%s\n' "$AI_UPSTREAM" "$(printf '%s' "$1" | tr '/' '_')"; }

# Clone or fast-forward every upstream repo (shallow, one commit deep: always the latest HEAD).
# Big monorepos (vercel/ai, promptfoo) use a blobless sparse checkout of just the skill dirs.
sync_upstream_checkouts() {  # $1 = kit root
    local base="${AI_GIT_BASE:-https://github.com}" repo d paths
    mkdir -p "$AI_UPSTREAM"
    for repo in $(upstream_repos "$1"); do
        d="$(upstream_dir "$repo")"
        paths="$(upstream_rows "$1" | cut -f1 | awk -v r="$repo/" 'index($0, r)==1 {print substr($0, length(r)+1)}')"
        if [ -d "$d/.git" ]; then
            if git -C "$d" fetch --depth 1 --filter=blob:none --quiet origin HEAD 2>/dev/null && git -C "$d" reset --hard --quiet FETCH_HEAD; then
                ok "$repo @ $(git -C "$d" rev-parse --short HEAD)"
            else warn "$repo: fetch failed — keeping $(git -C "$d" rev-parse --short HEAD 2>/dev/null)"; fi
        elif git clone --depth 1 --filter=blob:none --sparse --quiet "$base/$repo.git" "$d" 2>/dev/null; then
            ok "$repo cloned @ $(git -C "$d" rev-parse --short HEAD)"
        else warn "$repo: clone failed (offline?) — re-run the installer"; continue; fi
        # shellcheck disable=SC2086
        [ -d "$d/.git" ] && git -C "$d" sparse-checkout set --no-cone $(printf '/%s/\n' $paths) >/dev/null 2>&1 || true
    done
}

# Link the curated skills for one host into a skills dir; prune links to skills no longer listed.
link_upstream_skills() {  # $1 = kit root  $2 = skills dir  $3 = host (claude|hermes)
    local ident hosts repo path n src linked=0 missing=0 l
    mkdir -p "$2"
    while IFS=$'\t' read -r ident hosts _; do
        case "$hosts" in both|"$3") ;; *) continue ;; esac
        repo="$(printf '%s' "$ident" | cut -d/ -f1-2)"; path="$(printf '%s' "$ident" | cut -d/ -f3-)"; n="${ident##*/}"
        src="$(upstream_dir "$repo")/$path"
        if [ ! -f "$src/SKILL.md" ]; then missing=$((missing+1)); continue; fi
        if [ -e "$2/$n" ] && [ ! -L "$2/$n" ]; then warn "$n: a real skill dir exists in $2 — left as is"; continue; fi
        ln -sfn "$src" "$2/$n"; linked=$((linked+1))
    done < <(upstream_rows "$1")
    for l in "$2"/*; do   # prune
        [ -L "$l" ] || continue
        case "$(readlink "$l")" in "$AI_UPSTREAM"/*) ;; *) continue ;; esac
        upstream_rows "$1" | cut -f1 | grep -q "/$(basename "$l")\$" || { rm -f "$l"; say "  · $(basename "$l") unlinked (no longer in the curated set)"; }
    done
    ok "$linked curated upstream skills linked into $2"
    [ "$missing" -gt 0 ] && warn "$missing listed skills not in the local checkouts — run the kit installer (it clones them)"
    return 0
}

# ---- vendor plugins (Claude Code) ---------------------------------------------------------
register_claude_plugins() {  # $1 = kit root  $2 = claude bin — marketplaces added + refreshed; enabled per repo by ai-init
    local plugin repo scope mkt mkts
    mkts="$("$2" plugin marketplace list 2>/dev/null || true)"
    while IFS=$'\t' read -r plugin repo scope _; do
        case "$plugin" in ''|\#*) continue ;; esac
        mkt="${plugin#*@}"
        if ! grep -q "❯ $mkt\$" <<<"$mkts"; then
            "$2" plugin marketplace add "$repo" >/dev/null 2>&1 && mkts="$mkts"$'\n'"  ❯ $mkt" || { warn "$mkt marketplace add failed ($repo)"; continue; }
        fi
        "$2" plugin marketplace update "$mkt" >/dev/null 2>&1 || true
        ok "$plugin marketplace current (enabled per repo by ai-init)"
    done < "$1/install/claude-plugins.tsv"
}

link_bins() {  # $1 = kit root
    mkdir -p "$AI_BIN"
    local b
    for b in $KIT_BINS; do chmod +x "$1/bin/$b"; ln -sfn "$1/bin/$b" "$AI_BIN/$b"; done
    chmod +x "$1/install/init-project.sh"; ln -sfn "$1/install/init-project.sh" "$AI_BIN/ai-init"
    ok "$KIT_BINS ai-init → $AI_BIN"
    case ":$PATH:" in *":$AI_BIN:"*) ;; *) warn "$AI_BIN is not on PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac
}

ensure_secrets_file() {
    mkdir -p "$AI_CONF"; chmod 700 "$AI_CONF"
    [ -f "$AI_SECRETS" ] || { printf '# AI Kit secrets for the CLIs (ai-models, ai-eval, ai-mcp). chmod 600. Set with: ai-settings key <ENV_NAME>\n' > "$AI_SECRETS"; }
    chmod 600 "$AI_SECRETS"
}

write_marked_block() {  # write_marked_block <file> <marker> <content-file>
    local f="$1" mk="$2" body="$3" tmp
    mkdir -p "$(dirname "$f")"; touch "$f"; tmp="$(mktemp)"
    awk -v s="<!-- $mk:start -->" -v e="<!-- $mk:end -->" '$0==s{skip=1} !skip{print} $0==e{skip=0}' "$f" > "$tmp"
    { printf '<!-- %s:start -->\n' "$mk"; cat "$body"; printf '<!-- %s:end -->\n' "$mk"; } >> "$tmp"
    mv "$tmp" "$f"
}

# Living updates: the session-start event runs `ai-update --hook`.
wire_claude_update_hook() {  # $1 = claude dir
    local f="$1/settings.json"; mkdir -p "$1"
    python3 - "$f" "$AI_BIN/ai-update --hook" <<'PY'
import json, os, sys
p, cmd = sys.argv[1:3]
s = json.load(open(p)) if os.path.exists(p) else {}
ss = s.setdefault("hooks", {}).setdefault("SessionStart", [])
if not any("ai-update" in h.get("command", "") for g in ss for h in g.get("hooks", [])):
    ss.append({"hooks": [{"type": "command", "command": cmd, "timeout": 10}]})
    json.dump(s, open(p, "w"), indent=2); open(p, "a").write("\n"); print("added")
else: print("present")
PY
}

wire_hermes_update_hook() {
    local cur merged
    cur="$(hermes config get --json hooks.on_session_start 2>/dev/null || echo null)"
    case "$cur" in *ai-update*) echo present; return ;; esac
    merged="$(python3 -c '
import json, sys
try: cur = json.loads(sys.argv[1]) or []
except Exception: cur = []
if not isinstance(cur, list): cur = []
cur.append({"command": sys.argv[2] + " --hook", "timeout": 10})
print(json.dumps(cur))' "$cur" "$AI_BIN/ai-update")"
    hermes config set hooks.on_session_start "$merged" >/dev/null 2>&1 && echo added || echo failed
}

write_kit_version() {  # $1 = kit root  $2 = dir
    mkdir -p "$2"
    printf 'revision: %s\ninstalled: %s\nsource: %s\n' \
        "$(git -C "$1" rev-parse --short HEAD 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$(git -C "$1" remote get-url origin 2>/dev/null || echo "$1")" > "$2/.ai-kit-version"
}

# The always-on stanza — one text for both hosts.
stanza() {
cat <<'MD'
# AI Kit (always on for chat bots, email/SMS bots, AI automations, LLMs, ML, tracking, analytics)
- One AI brain per site: `llm-router` (every model call; OpenRouter key OR per-provider keys, per-task model + fallbacks) → `site-agent` (the ONE agent: web chat, email/SMS bot, admin copilot, MCP) acting only through its action registry (zod-typed, permissioned, signed approvals for writes, audited) → `live-bus` (SSE + webhooks) → `ai-analytics` (the only writer of AI numbers) → `ai-evolve` + `ml-lab` (self-improving, eval-gated). Map: skill `ai-kit`.
- Customer-facing bots stay on THIS site only and never reveal what powers them — any "what model/AI are you" gets: a custom-built assistant developed for the site. Guard layers: preflight → persona → output scrub. Never put a model or vendor name in customer copy, prompts, metadata or errors.
- AI changes site data ONLY through `site-agent` actions (the customer id comes from the session, never the model). New capability = new action; never hand the model raw SQL/HTTP.
- Read `use-ai-sdk` before writing AI code (AI SDK v7 moves fast); `ai-models` for the live catalog. Tracking hands off to Marketing Kit `journey-analytics` when present; attacks on the bot hand off to Security Kit red-team + `promptfoo-redteam-*`.
- Freedom first: no legal/compliance gating, no T&Cs or policies, no content restrictions beyond the site-focus + identity rules above. Legal sections inside vendor/upstream skills are background only.
- Repo without `.agents/ai-stack.md`? Run `ai-init`. Health: `ai-doctor`.
MD
}
