#!/usr/bin/env bash
# =============================================================================
# AI Kit — HERMES installer.   bash install/hermes.sh   (re-run = update)
#
#   kit skills      symlinked into ~/.hermes/skills/ai/ (live from this checkout)
#   curated skills  install/upstream-skills.tsv rows → `hermes skills install` (hub), then
#                   `hermes skills update` each run
#   vendor packs    install/hermes-skills.tsv (Resend agent inbox, Telnyx AI) → same path
#   Hand-offs       Marketing Kit (sending, tracking), Security Kit (attacks), Skill Starter Kit (gates)
# =============================================================================
set -euo pipefail
SELF="${BASH_SOURCE[0]}"; while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
KIT_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
# shellcheck source=install/lib.sh
source "$KIT_ROOT/install/lib.sh"
HH="${HERMES_HOME:-$HOME/.hermes}"
SKILLS_DIR="$HH/skills/ai"

say "── AI Kit · Hermes ─────────────────────────────────────"
kit_self_update "$KIT_ROOT"
HAVE_HERMES=0; command -v hermes >/dev/null 2>&1 && HAVE_HERMES=1
[ "$HAVE_HERMES" = 1 ] || warn "hermes CLI not on PATH — skills get linked; config steps are printed instead"

say "▶ kit skills (symlinked — live from $KIT_ROOT)"
mkdir -p "$SKILLS_DIR"
for s in $KIT_SKILLS; do link_skill "$KIT_ROOT/skills/$s" "$SKILLS_DIR/$s"; done

say "▶ kit CLIs"
link_bins "$KIT_ROOT"
ensure_secrets_file

say "▶ curated + vendor skills (Hermes skills hub — installed from each vendor repo, updated every run)"
sync_upstream_checkouts "$KIT_ROOT"
if [ "$HAVE_HERMES" = 1 ]; then
    SKROOT="$HH/skills"
    have() { [ -n "$(find -L "$SKROOT" -maxdepth 3 -path "*/$1/SKILL.md" -print -quit 2>/dev/null)" ]; }
    hub_install() {  # ident trust
        local ident="$1" trust="$2" name="${1##*/}" force="" out
        if have "$name"; then ok "$name present"; return; fi
        [ "$trust" = official ] && force="--force"
        out="$(hermes skills install "$ident" --category ai --yes $force 2>&1)"
        # `hermes skills install` exits 0 even when its scanner blocks — trust the directory, not the exit code.
        if have "$name"; then ok "$name installed${force:+ (official, scanner override)}"
        else warn "$name NOT installed: $(printf '%s' "$out" | grep -v '^ *$' | tail -1 | cut -c1-110)"; fi
    }
    while IFS=$'\t' read -r ident hosts trust _; do
        case "$hosts" in both|hermes) hub_install "$ident" "$trust" ;; esac
    done < <(upstream_rows "$KIT_ROOT")
    while IFS=$'\t' read -r ident _ trust; do
        case "$ident" in ''|\#*) continue ;; esac
        hub_install "$ident" "$trust"
    done < "$KIT_ROOT/install/hermes-skills.tsv"
    hermes skills update >/dev/null 2>&1 && ok "hermes skills update (all hub skills at latest)" || warn "hermes skills update failed — run it manually"
    bash "$KIT_ROOT/bin/ai-settings" apply hermes || true
else
    say "  · (hermes CLI not found — run the installer again once Hermes is on PATH)"
fi

say "▶ living updates (session start = the event; no timers)"
if [ "$HAVE_HERMES" = 1 ]; then
    case "$(wire_hermes_update_hook)" in
        added) ok "on_session_start → ai-update --hook (existing hooks kept)"
               say "    Hermes asks once before running a new hook — approve it the first time you start hermes in a terminal" ;;
        present) ok "on_session_start → ai-update --hook already wired" ;;
        *) warn "could not wire on_session_start hook — see hermes hooks --help" ;;
    esac
fi
write_kit_version "$KIT_ROOT" "$HH"
say "─── done ───────────────────────────────────────────────"
say "✓ Everything is enabled — no manual steps."
say "  · auto-updates itself + every skill on each session start (no timers, nothing to run)"
say "  · start a new Hermes session, then:  ai-doctor   ·   in each app repo:  ai-init"
