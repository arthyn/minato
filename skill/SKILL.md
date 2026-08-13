---
name: minato
description: Find, start, and verify local Urbit moons before doing ship work. Use when a task needs a running moon or its MCP tools — compiling or committing a desk, scrying, poking an agent, testing on a dev ship — or when a ship-backed MCP server is failing, missing, or pointing at the wrong port. Also use to answer "which moons are running", "what port is <ship> on", or "why can't I reach <ship>".
---

# minato — get a working moon before doing ship work

`minato` is a CLI that tracks the local Urbit piers under the user's home directory. Use it instead of hand-rolling `ps`/`lsof`/`find` checks. It reads live process state, not stored metadata.

It is installed on `PATH`. If a restricted environment cannot resolve it, fall back to `<install-dir>/bin/minato`.

## The normal flow

**1. Find out what's actually up.**

```bash
minato list                  # human table
minato list --state running  # just what's live
minato list --json           # for parsing
```

**2. Resolve the moon you need.** Moons are addressed by shortname (the first phoneme of the ship, e.g. `sampel`), full ship name, or pier path. If a shortname is ambiguous the command errors and lists the candidates — pass a full path instead.

```bash
minato inspect <moon>        # state, port, pids, vere, issues
```

**3. If it's down, start it.**

```bash
minato start <moon>          # reuses the port agents already expect
```

**4. Check the wiring before assuming an MCP tool is broken.**

```bash
minato mcp status            # every local MCP entry vs live pier state
minato doctor                # that, plus pier-level drift
```

## Creating a moon

```bash
minato new [shortname] --planet <ship-or-url>    # mints from a parent, boots it
minato new --dry-run --planet <ship-or-url>      # plan only, mints nothing
```

**Treat this as user-initiated.** Minting is not reversible — the parent records the moon's keys, and the name is derived randomly rather than chosen, so the same moon cannot be re-created. Never run it to "get a ship to test on"; ask, or use an existing moon.

It prompts for the parent's `+code` on a terminal. In a non-interactive or sandboxed context that prompt cannot be answered, so the command will fail — that is expected, not a bug to route around. Never ask the user to paste a `+code` into the conversation.

## Reading the MCP audit

`minato` audits **both** agent configs: `~/.claude.json` (Claude Code, global + per-project) and `~/.codex/config.toml` (Codex). Entries are labelled by which agent they came from. Remote endpoints are ignored.

| Status | Meaning | What to do |
| --- | --- | --- |
| `ok` | Entry points at a running moon on the right port | nothing |
| `port-drift` | Right moon, wrong port | `minato mcp sync` |
| `endpoint-down` | Named moon isn't running | `minato start <moon>` |
| `misnamed` | That port is served by a *different* pier | tell the user; don't guess |
| `orphan` | Nothing serves the port, no pier by that name | tell the user; likely a dead entry |

```bash
minato mcp sync --dry-run    # show what would change
minato mcp sync --yes        # apply
```

**A sync does not fix the session you are in.** MCP servers are connected at agent startup, so after `minato mcp sync` the corrected endpoint is only available to a *newly started* Claude Code or Codex session. Say so explicitly rather than retrying the tool and reporting it as still broken.

`mcp sync` rewrites **ports only**. It cannot mint `%mcp` API keys or refresh an expired `urbauth` cookie — if a moon is running on the right port but its MCP tools still return auth errors, the credential is stale and the user has to reissue it. That is not something to work around silently.

## Inferred liveness (inside a sandbox)

`minato` normally reads the process table. Agent sandboxes — Codex's `read-only` and `workspace-write` both — deny `ps`. minato then falls back to `.vere.lock`, and prints `LIVENESS INFERRED`.

In this mode:

- Ships shown as `running*` **are** running. That is confirmed, and their ports are accurate.
- Piers shown as `unknown` are **undetermined, not stopped.** Never report them as "not running" — say they could not be assessed.
- `start`, `stop`, and `restart` **refuse with exit 4**, because a duplicate boot cannot be detected without the process table and the lock file names the serf rather than the supervising process. Do not work around this; ask the user to run it in their terminal.
- `--json` returns an **object** rather than the usual array — `{ "liveness": "inferred", "message": ..., "undetermined": [...], "piers": [...] }`. Check the shape before indexing.

The inference is one-directional by design: it can prove a ship is up, never that one is down. So an empty or partial result is never license to start anything.

## Rules

- **Never stop or restart a moon that you did not start, without asking.** Other sessions, agents, and the user's own terminals depend on these ships. `minato stop` and `minato restart` are user-initiated actions.
- **Never `kill -9` a ship.** `minato stop` sends SIGTERM and waits; a killed serf can lose events. If it times out, report that and stop — the user decides whether to force it.
- **Never boot an `archived` pier, and never suggest `unarchive` to get past a refusal.** Archived means the pier is a copy of a ship whose live instance runs elsewhere; booting it can corrupt that live ship. `minato` refuses with exit 4 and `--yes` does not override it. Report the refusal and stop.
- **Never act on an `ambiguous` pier.** That means a duplicate boot or an orphaned worker. `minato` deliberately refuses; so should you. Surface the issue and let the user resolve it.
- Booting a long-stale ship can trigger an OTA. If `minato list` shows the moon is months idle, say so before starting it.
- Ships started from a terminal tab die with that tab (`doctor` flags this as `terminal-bound`). Ships started by `minato start` are detached and survive.

## Exit codes

`0` ok · `2` bad input · `4` safety refusal (ambiguous state, liveness unknown, or port already bound) · `5` operation failed

`doctor` and `mcp status` exit `1` when they find problems, so `minato doctor >/dev/null && echo clean` is a valid health gate.

## JSON shape

`minato list --json` returns an array of piers:

```json
{ "ship": "doznec-doznec-sampel-palnet", "shortname": "doznec", "path": "...",
  "state": "running", "ports": { "loopback": 12321, "public": 8080 },
  "pids": [4210, 4211], "kingPid": 4210, "vere": "v4.6",
  "lastActivity": "2026-01-02T03:04:05.000Z",
  "issues": [ { "level": "warn", "code": "terminal-bound", "message": "...", "fix": "..." } ] }
```

`state` is one of `running` · `stopped` · `stale` (idle past the threshold, default 14 days) · `ambiguous` · `unknown` · `archived`. Each pier also carries `livenessSource`: `process-table` (confirmed), `inferred` (lock file only), or `none` (undetermined).

Inside a sandbox `--json` returns an **object** instead of an array — check the shape first:

```json
{ "liveness": "inferred", "message": "...", "undetermined": ["sampel", ...], "piers": [ ... ] }
```

## Related

`minato` reports on ships; it does not commit desks or drive Clay. Full design and the environment facts it encodes are in the project README.
