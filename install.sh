#!/bin/sh
# Install minato: link the CLI onto PATH, and optionally wire up the agent
# integrations. Idempotent — safe to re-run after a git pull.
#
# Everything it touches is inside $HOME, and every change is printed first.

set -e

REPO=$(cd "$(dirname "$0")" && pwd)
CLI_ONLY=0
ASSUME_YES=0

usage() {
  cat <<EOF
minato installer

usage: ./install.sh [options]

  --cli-only    install just the CLI; skip Claude Code and Codex integration
  --bin-dir DIR install the launcher into DIR (default: first writable dir on
                PATH among ~/bin, ~/.local/bin, /usr/local/bin)
  -y, --yes     do not prompt; accept the agent integrations
  -h, --help    this text

Installs:
  <bin-dir>/minato                     symlink to the launcher
  ~/.claude/skills/minato/SKILL.md     symlink (Claude Code skill)
  ~/.codex/prompts/minato.md           Codex /minato prompt
  ~/.codex/AGENTS.md                   one-paragraph pointer, appended

Nothing is written outside \$HOME.
EOF
}

BIN_DIR=
while [ $# -gt 0 ]; do
  case $1 in
    --cli-only) CLI_ONLY=1 ;;
    --bin-dir) BIN_DIR=$2; shift ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }

ask() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1   # non-interactive: decline optional extras
  printf '%s [y/N] ' "$1"
  read -r reply
  case $reply in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# --- Node check -------------------------------------------------------------
# The launcher does this too, but failing here gives a far clearer message than
# a syntax error from an old Node trying to parse type annotations.
supports_ts() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}
NODE_OK=0
for candidate in "$MINATO_NODE" /opt/homebrew/bin/node /usr/local/bin/node node; do
  [ -n "$candidate" ] || continue
  resolved=$(command -v "$candidate" 2>/dev/null) || continue
  if supports_ts "$resolved"; then NODE_OK=1; break; fi
done
if [ "$NODE_OK" = 0 ]; then
  say "minato needs Node >= 22.18 (for native TypeScript support); none found."
  say "Install a newer Node, or set MINATO_NODE to a suitable binary."
  exit 2
fi

# --- CLI --------------------------------------------------------------------
if [ -z "$BIN_DIR" ]; then
  for d in "$HOME/bin" "$HOME/.local/bin" /usr/local/bin; do
    case ":$PATH:" in *":$d:"*) ;; *) continue ;; esac
    if [ -d "$d" ] && [ -w "$d" ]; then BIN_DIR=$d; break; fi
  done
fi
if [ -z "$BIN_DIR" ]; then
  say "No writable directory on PATH found (tried ~/bin, ~/.local/bin, /usr/local/bin)."
  say "Create one and add it to PATH, or pass --bin-dir DIR."
  exit 2
fi

say "Installing minato from $REPO"
step "link  $BIN_DIR/minato"
mkdir -p "$BIN_DIR"
ln -sf "$REPO/bin/minato" "$BIN_DIR/minato"
chmod +x "$REPO/bin/minato"

if [ "$CLI_ONLY" = 1 ]; then
  say ""
  say "Done. Run: minato list"
  exit 0
fi

# --- Claude Code skill ------------------------------------------------------
# Symlinked rather than copied so a git pull updates the skill as well.
CLAUDE_SKILL_DIR="$HOME/.claude/skills/minato"
if [ -d "$HOME/.claude" ]; then
  if ask "Install the Claude Code skill into $CLAUDE_SKILL_DIR?"; then
    mkdir -p "$CLAUDE_SKILL_DIR"
    ln -sf "$REPO/skill/SKILL.md" "$CLAUDE_SKILL_DIR/SKILL.md"
    step "link  $CLAUDE_SKILL_DIR/SKILL.md"
  fi
fi

# --- Codex prompt and pointer ----------------------------------------------
CODEX_DIR="$HOME/.codex"
if [ -d "$CODEX_DIR" ]; then
  if ask "Install the Codex /minato prompt and AGENTS.md pointer?"; then
    mkdir -p "$CODEX_DIR/prompts"
    sed "s|@@SKILL@@|$REPO/skill/SKILL.md|g; s|@@REPO@@|$REPO|g" \
      "$REPO/templates/codex-prompt.md" > "$CODEX_DIR/prompts/minato.md"
    step "write $CODEX_DIR/prompts/minato.md"

    # Appended, never overwritten — this file is the user's, and may already
    # carry unrelated global instructions.
    AGENTS="$CODEX_DIR/AGENTS.md"
    if [ -f "$AGENTS" ] && grep -q "minato" "$AGENTS" 2>/dev/null; then
      step "skip  $AGENTS (already mentions minato)"
    else
      {
        printf '\n## Urbit moons\n\n'
        printf 'Local moons/piers are managed with `minato`. Before any task that needs a running\n'
        printf 'ship or its MCP tools — compiling or committing a desk, scrying, poking an agent,\n'
        printf 'or when a ship-backed MCP server is failing — read %s\n' "$REPO/skill/SKILL.md"
        printf 'and follow it. Start with `minato list` and `minato doctor`. Do not stop or restart\n'
        printf 'a moon you did not start without asking; other sessions depend on these ships.\n'
      } >> "$AGENTS"
      step "append $AGENTS"
    fi
  fi
fi

say ""
say "Done. Try:"
say "  minato list"
say "  minato doctor"
