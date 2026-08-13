# minato — notes for agents working in this repo

CLI that tracks local Urbit piers under the user's home directory, detects drift, and repairs MCP wiring for both Claude Code and Codex.

**Using** minato to get a moon running is documented in `skill/SKILL.md` — read that instead if the task is ship work rather than changing this code.

## Build and check

TypeScript run directly by Node ≥22.18 via native type stripping. **There is no build step and no runtime dependencies** — keep it that way.

```bash
npm install                     # dev-only: typescript, @types/node
./node_modules/.bin/tsc --noEmit
node src/cli.ts list            # or ./bin/minato, or just `minato` once installed
```

`bin/minato` resolves symlinks to find the repo, and picks a Node ≥22.18. It deliberately tries **absolute** Node paths before the PATH lookup: `node` on PATH is often a version-manager shim, shims need to write temp files, and agent sandboxes deny that — probing the shim first made the launcher produce no output at all inside Codex. Keep absolute candidates first.

`tsconfig.json` sets `erasableSyntaxOnly`, so no enums, no parameter properties, no namespaces. Imports must carry the `.ts` extension.

## Layout

| File | Role |
| --- | --- |
| `src/cli.ts` | arg parsing (`node:util.parseArgs`) and dispatch |
| `src/discover.ts` | pier discovery and state resolution — the core logic |
| `src/live.ts` | process table, ports, vere detection; no policy |
| `src/agents.ts` | per-agent MCP config adapters (Claude JSON, Codex TOML) |
| `src/eyre.ts` | Eyre auth, cookie cache, thread runner; ship-rank parsing |
| `src/vere.ts` | locating a local vere or downloading one |
| `src/mcp.ts` | audit and sync, format-agnostic |
| `src/config.ts` | `~/.minato/config.json` and `state.json` |
| `src/commands/` | one file per command |
| `skill/SKILL.md` | the agent-facing usage guide, installed into Claude Code and Codex |
| `planet-desk/` | Gall agent that mints moon tickets — the ship half of the unbuilt `new` |
| `docs/` | the planet ↔ minato allocator protocol |

## Environment facts this code depends on

Established by measurement against real piers, and several contradict what the design originally assumed. Do not "simplify" these away.

- A running ship is a **king** (`<pier>/.run --http-port N`) plus a **serf** child (`<pier>/.run work --snap-dir <pier>`). Duplicate-boot detection counts kings.
- `.vere.lock` holds the **serf** pid, and accumulates dead lines from earlier boots. It is not a liveness check.
- `.http.ports` and `.urb/conn.sock` both survive crashes. Neither proves a ship is up.
- Vere version comes from **inode identity** — `.run` is a hard link to the active binary in `.bin/live/`. Do not parse version strings for ordering.
- Port checks **bind**; they do not shell out to `lsof`, which reports nothing for privileged ports without root (a ship on port 80 reads as free).
- Metadata is keyed by **pier path**, not ship name — several piers can share a name (fakezods especially), so the name is not a unique key.
- Take one `ps` snapshot per run and answer every question from it, so a ship restarting mid-scan cannot read as two states.
- **`ps` is denied inside Codex sandboxes** (`read-only` *and* `workspace-write`). `processTable()` throws instead of returning `[]`. Never soften this back into an empty list: an empty table reads as "nothing is running", which is precisely when `start` would cause a duplicate boot.
- **`kill(pid, 0)` still discriminates inside the sandbox** — `EPERM` for a live process, `ESRCH` for a nonexistent one, because the kernel checks existence before permission. This is what `inferLiveness()` is built on. Network bind and connect are both `EPERM` there, so no port-based signal is available as corroboration.
- **Vere ARM builds are named `aarch64` on every platform, macOS included.** `macos-arm64` is not published by bootstrap.urbit.org and 403s, while Node's `os.arch()` reports `arm64` — do not pass that through. This is a live bug in the upstream `gen-moon.sh` this feature was adapted from.
- **The inference must stay one-directional.** It may conclude `running`; it must never conclude `stopped`. Unconfirmed piers are `unknown`. Preserving this direction is what makes the fallback safe, since the harmful error is believing a live ship is down.

## Invariants

- **Live state beats metadata**, always, for anything safety-critical.
- **Never escalate to SIGKILL.** `stop` sends SIGTERM, waits, and reports.
- **Never act on an `ambiguous` pier.** Refuse with exit 4.
- **`mcp sync` rewrites ports only.** Auth headers, API keys and cookies are preserved verbatim — minato cannot mint `%mcp` keys. Back up before writing.
- The Codex TOML adapter is a **scanner, not a parser**, so the user's comments and formatting survive. Keep edits surgical and range-based.
- **Secrets never reach argv or logs.** The `+code` is read without echo and sent in a form body; the moon key goes to a `0600` file in a private temp dir, is passed to vere by path, and is removed in a `finally`. Session cookies are cached `0600`. Do not print, log, or pass any of these as arguments.
- **Validate before prompting.** `new` checks shortname collisions and parent rank up front, so a doomed run never asks for a password.

## Testing against real piers

There is no test suite yet. Verify by hand, and prefer the paths that cannot disturb the user's ships:

```bash
node src/cli.ts start <running-moon>       # expect: no-op, exit 0
node src/cli.ts start <stopped> --port <bound-port>   # expect: refusal, exit 4
node src/cli.ts mcp sync --dry-run         # never writes
```

For adapter changes, round-trip against a **copy** of the config and `diff` it — a corrupt `~/.codex/config.toml` or `~/.claude.json` breaks the user's tooling.

## Not built yet

`new`, `swap`, `update`, `dojo`, archive/unarchive, interactive mode. Deferred deliberately — moons get created rarely and looked for constantly, so the inventory and wiring half came first.
