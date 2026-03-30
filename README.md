# minato (v0 scaffold)

CLI-first moon ops scaffold.

## Quick start

```bash
cd ~/Projects/minato
npm link
minato
```

## Implemented now

- `minato` interactive menu
- `minato new <shortname>`
- `minato list`
- `minato inspect <moon>`
- `minato start|stop|restart <moon>` with safety preflight (3-signal runtime checks)
  - `start` launches `pier/.run` in detached `screen` when preflight is clean
  - `stop` sends graceful `|exit` via `screen` (never force-kills)
  - `restart` orchestrates `stop` → runtime verification → `start` (still no force-kill)
- `minato swap <moon> [workspace]`
- `minato update [moon|--all]` (stub)
- `minato doctor [moon]` (basic checks)
- `minato sync [moon|--all]` (stub)
- `minato dojo <moon>` (stub)

State file:

`~/.config/minato/state.json`
