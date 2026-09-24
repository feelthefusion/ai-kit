#!/usr/bin/env bash
# =============================================================================
# AI Kit — remote bootstrap (always latest, one command = everything)
#   curl -fsSL https://raw.githubusercontent.com/feelthefusion/ai-kit/main/install/bootstrap.sh | bash
#   ... | bash -s -- claude          # Claude Code only
#   ... | bash -s -- hermes          # Hermes only
# Clones to ~/.ai-kit (or pulls), then installs BOTH hosts by default — no flags, no follow-up.
# Kit skills are SYMLINKS into this checkout, so every re-run updates them in place; a
# session-start hook keeps everything current.
# =============================================================================
set -euo pipefail
TARGET="${1:-both}"
KIT_DIR="${KIT_DIR:-$HOME/.ai-kit}"
REPO="https://github.com/feelthefusion/ai-kit.git"
command -v git >/dev/null 2>&1 || { echo "✗ git required"; exit 1; }
if [ -d "$KIT_DIR/.git" ]; then echo "▶ updating $KIT_DIR"; git -C "$KIT_DIR" pull --ff-only --quiet || echo "  ⚠ pull failed — using local checkout"
else echo "▶ cloning into $KIT_DIR"; git clone --quiet "$REPO" "$KIT_DIR"; fi
export KIT_NO_PULL=1   # just pulled
case "$TARGET" in
    claude) exec bash "$KIT_DIR/install/install.sh" ;;
    hermes) exec bash "$KIT_DIR/install/hermes.sh" ;;
    both)   bash "$KIT_DIR/install/install.sh" && exec bash "$KIT_DIR/install/hermes.sh" ;;
    *) echo "✗ unknown target '$TARGET' (claude | hermes | both)"; exit 1 ;;
esac
