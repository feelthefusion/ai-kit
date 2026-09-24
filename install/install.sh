#!/usr/bin/env bash
# =============================================================================
# AI Kit — CLAUDE CODE installer.   bash install/install.sh   (re-run = update)
#
#   Kit skills        symlinked into ~/.claude/skills/ (live from this checkout)
#   Curated upstream  install/upstream-skills.tsv → shallow checkouts in $AI_UPSTREAM, linked per
#                     repo by ai-init, pulled on session start by ai-update
#   Vendor plugins    install/claude-plugins.tsv → marketplaces registered + refreshed here,
#                     enabled per repo by ai-init (project scope)
#   Map skill         ai-kit + always-on stanza in ~/.claude/CLAUDE.md
#   CLIs              ai-doctor ai-update ai-settings ai-models ai-mcp ai-report ai-eval ai-webhooks ai-init
#
# Hand-offs (not duplicated): Marketing Kit owns email/SMS sending + site-wide tracking; Security
# Kit owns attack loops; the Skill Starter Kit owns verify.sh, docs-freshness, browser-verify.
# =============================================================================
set -euo pipefail
SELF="${BASH_SOURCE[0]}"; while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
KIT_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
# shellcheck source=install/lib.sh
source "$KIT_ROOT/install/lib.sh"
CLAUDE_DIR="$HOME/.claude"; SKILLS_DIR="$CLAUDE_DIR/skills"

say "── AI Kit · Claude Code ───────────────────────────────"
kit_self_update "$KIT_ROOT"

say "▶ kit skills (symlinked — live from $KIT_ROOT)"
mkdir -p "$SKILLS_DIR"
for s in $KIT_SKILLS; do link_skill "$KIT_ROOT/skills/$s" "$SKILLS_DIR/$s"; done

say "▶ kit CLIs"
link_bins "$KIT_ROOT"
ensure_secrets_file; ok "secrets file $AI_SECRETS (chmod 600) — ai-settings key <ENV_NAME>"

say "▶ curated upstream skills (install/upstream-skills.tsv — one list for Claude Code + Hermes)"
sync_upstream_checkouts "$KIT_ROOT"
say "  · linked into each app repo's .claude/skills by ai-init (git-excluded); pulled on session start by ai-update"

say "▶ vendor plugins (each vendor's own marketplace — always latest)"
CLAUDE_BIN="$(find_claude || true)"
if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
    register_claude_plugins "$KIT_ROOT" "$CLAUDE_BIN"
    say "▶ optional MCP (your switches: ai-settings)"
    AI_CLAUDE_BIN="$CLAUDE_BIN" bash "$KIT_ROOT/bin/ai-settings" apply claude || true
else
    warn "claude CLI not found — inside Claude Code run, for each line of install/claude-plugins.tsv:"
    while IFS=$'\t' read -r plugin repo _ _; do case "$plugin" in ''|\#*) continue;; esac
        say "      /plugin marketplace add $repo   then   /plugin install $plugin"; done < "$KIT_ROOT/install/claude-plugins.tsv"
fi

say "▶ always-on stanza (~/.claude/CLAUDE.md)"
STANZA="$(mktemp)"; stanza > "$STANZA"
write_marked_block "$CLAUDE_DIR/CLAUDE.md" ai-kit "$STANZA"; rm -f "$STANZA"
ok "stanza written"

say "▶ living updates (session start = the event; no timers)"
case "$(wire_claude_update_hook "$CLAUDE_DIR")" in
    added) ok "SessionStart → ai-update --hook (existing hooks kept)" ;;
    present) ok "SessionStart → ai-update --hook already wired" ;;
    *) warn "could not wire SessionStart hook — add it by hand: ai-update --hook" ;;
esac
write_kit_version "$KIT_ROOT" "$CLAUDE_DIR"

n_up="$(upstream_rows "$KIT_ROOT" | awk -F'\t' '$2=="both"||$2=="claude"' | wc -l | tr -d ' ')"
say "─── done ───────────────────────────────────────────────"
say "✓ Everything is enabled — no manual steps."
say "  · $(echo $KIT_SKILLS | wc -w | tr -d ' ') kit skills + $n_up curated upstream skills, linked live (never copied)"
say "  · auto-updates itself + every skill on each session start (no timers, nothing to run)"
say "  · restart the app once for skills to load, then:  ai-doctor"
say "  · in each app repo (the only per-repo step):  ai-init"
