# minato

Lifecycle and MCP wiring for local Urbit moons. Answers the question "what is running, on what port, and can my agents reach it?" from live system truth rather than from stored metadata.

v0 scope: inventory, drift detection, safe start/stop, and MCP endpoint repair. Moon creation (`minato new`) is not implemented yet.

If you run several moons for agent work and lose track of which are up, on what port, and whether your agents can still reach them, this is for that.

## Install

macOS, and Node ≥ 22.18 — TypeScript runs directly via native type stripping, so there is no build step and no runtime dependencies.

```sh
git clone https://github.com/arthyn/minato.git
cd minato
./install.sh
```

`install.sh` links `minato` onto your `PATH`, and offers to install the agent integrations (Claude Code skill, Codex prompt). It is idempotent — re-run it after `git pull`. `./install.sh --help` lists the flags; `--cli-only` skips the agent parts.

Nothing is installed outside your home directory, and the script prints every change before making it.

To install by hand instead:

```sh
ln -sf "$PWD/bin/minato" ~/bin/minato   # any writable dir on PATH
```

`bin/minato` resolves its own location through symlinks, so it can be linked from anywhere.

It also selects the Node it runs on. Absolute installs (`/opt/homebrew/bin/node`, `/usr/local/bin/node`) are tried **before** the PATH lookup, because `node` on PATH is often a version-manager shim, and shims need to write temp files — which agent sandboxes deny, making the probe fail or hang. Set `MINATO_NODE` to override. If nothing new enough is found it exits 2 with an explanation, rather than letting an old Node fail on the type annotations.

## Commands

```
minato new [shortname] [--planet <ship|url>] [--dir <path>] [--port <n>]
           [--hosted] [--desk <desk>] [--dry-run] [--yes]
minato list [--state <s>] [--size] [--all] [--json]
minato inspect <moon>
minato doctor [moon] [--json]
minato name <moon|pier-path> <shortname>
minato start <moon> [--port <n>] [--yes]
minato stop <moon> [--yes] [--timeout <s>]
minato restart <moon> [--port <n>] [--yes]
minato mcp status [--json]
minato mcp sync [--dry-run] [--yes]
```

Exit codes: `0` ok, `2` bad input, `4` safety refusal, `5` operation failed.

## How liveness is determined

Metadata is advisory; the process table wins. Every command takes one `ps` snapshot and answers all questions from it, so a ship restarting mid-scan cannot read as two different states.

For each pier, the processes referencing it are split into **kings** (`<pier>/.run --http-port N`) and **serfs** (`<pier>/.run work --snap-dir <pier>`). A healthy ship is exactly one king with one serf child.

- **two kings → `ambiguous`**, reported as a duplicate boot. `start`, `stop`, and `restart` all refuse; minato will not choose which instance to kill.
- **serf with no king → `ambiguous`** (orphaned worker).
- **one king → `running`**.

Three files that look authoritative are not, and are treated as corroborating evidence only:

| File | What it actually is |
| --- | --- |
| `.vere.lock` | The **serf** pid, plus leftover lines from earlier boots. Not the king. |
| `.http.ports` | Written at boot, removed on clean exit. Survives a crash. |
| `.urb/conn.sock` | Frequently left behind by an unclean shutdown. Never evidence of liveness. |

Port availability is probed by attempting a bind rather than by `lsof`, which reports nothing for privileged ports without root — a ship on port 80 reads as "port free" under `lsof` while it is actually serving.

Vere version comes from inode identity: `.run` is a hard link to the active binary under `.bin/live/`, so filenames never have to be parsed for ordering.

## Inferred liveness, for sandboxed agents

`ps` is denied inside Codex's sandboxes — both `read-only` and `workspace-write`. `processTable()` therefore **throws** rather than returning an empty list, because an empty table would read as "nothing is running", the exact condition under which `start` would boot a second instance of a live ship.

Rather than give up, minato falls back to a second source. Measured behaviour inside the sandbox:

| Signal | Sandboxed result |
| --- | --- |
| `ps` | denied |
| network bind / connect | `EPERM` |
| reading `.vere.lock`, `.http.ports` | works |
| `kill(livePid, 0)` | `EPERM` |
| `kill(deadPid, 0)` | `ESRCH` |

The last two rows are what make this possible: the kernel checks process existence **before** permission, so `EPERM` and `ESRCH` still distinguish a live pid from a nonexistent one where `ps` cannot. `.vere.lock` names the serf of every boot, and a running ship always has a live serf listed, so checking those pids confirms the ship is up.

**The inference is deliberately one-directional.** It can prove a ship is running; it can never conclude one is stopped. Piers it cannot confirm report `state: "unknown"` — undetermined, not down. The dangerous error is believing a live ship is stopped, and this fallback cannot produce it.

What stays unavailable: duplicate-boot detection needs the full process table, and the lock file names the serf rather than the king there is no supervising pid to signal. So `start`, `stop`, and `restart` still refuse with exit 4 under inference. `list`, `inspect`, `doctor`, and `mcp status` all work.

Degraded runs print `LIVENESS INFERRED`, mark confirmed ships `running*`, and switch `--json` from an array to an object carrying `liveness`, `message`, and `undetermined`, so a parsing caller cannot mistake a partial answer for a full one.

## Checks `doctor` performs

- **duplicate-boot** — a pier booted more than once (error).
- **orphaned-serf** — a worker running with no supervisor (error).
- **terminal-bound** — the ship's supervisor is a login shell, so closing that terminal tab kills it. This is the common way a moon an agent depends on disappears without explanation.
- **port-mismatch** — launched with a `--http-port` that disagrees with `.http.ports`, usually meaning mid-restart.
- **stale-lock** / **stale-conn-sock** — leftovers from unclean exits, with the `rm` to clear them.
- **shortname collisions** — shortnames must be globally unique or shorthand commands cannot resolve; fix with `minato name`.
- **MCP endpoints** — every locally-pointed entry in **both** agent configs is cross-referenced against live pier state, and each finding is labelled with the agent it came from:
  - `~/.claude.json` — Claude Code, global `mcpServers` plus per-project blocks (JSON)
  - `~/.codex/config.toml` — Codex, `[mcp_servers.NAME]` tables (TOML)

  Statuses:
  - `port-drift` — names a known moon, wrong port. Fixable by `minato mcp sync`.
  - `endpoint-down` — names a moon that isn't running.
  - `misnamed` — the port is served by a pier with a different name.
  - `orphan` — nothing serves the port and no pier has that name.

Remote endpoints are ignored entirely; minato only claims local moons.

## Archived piers (never boot)

A pier that is a copy of a ship whose live instance runs somewhere else must never be booted: two instances of the same ship on the network can corrupt the live one. Mark those piers as archived.

```sh
minato archive <moon> --note "copy of the hosted planet"
minato unarchive <moon>     # deliberate, prompts with the risk
```

`start`, `stop`, and `restart` all refuse for an archived pier with exit 4, and **`--yes` does not override it** — the only way through is `unarchive`.

`doctor` finds these for you. A ship reached at a **remote** address by one of your agent configs, which also has a pier on this machine, is reported as an `ARCHIVE RISK` error:

```
ARCHIVE RISK
  error  ~sampel-palnet runs remotely, but a local pier exists
    /Users/you/sampel-palnet
    booting it would put a second instance of a live ship on the network
    fix: minato archive sampel
```

Ship names come from the `urbauth-~<ship>` cookie on remote MCP entries, so this works without any extra configuration.

## Safety

Enforced in code rather than by convention:

- `stop` sends **SIGTERM only** and waits. It never escalates to SIGKILL — a killed serf can lose events — and prints the manual `kill -9` if the timeout expires.
- `start` refuses when the pier is ambiguous, or when the target port is already bound.
- `restart` boots again only if the stop was confirmed successful.
- `mcp sync` backs each agent config up to `<path>.minato-backup` before writing, and only rewrites the **port** of drifted entries. Auth headers, API keys, and cookies are preserved verbatim — minato cannot mint `%mcp` API keys or refresh an `urbauth` cookie, so entries needing new credentials are reported, never guessed at. The Codex adapter is a scanner rather than a TOML parser, so comments, ordering, and formatting survive byte-for-byte.

## Agent integration

One canonical file, `skill/SKILL.md`, serves both agents. `install.sh` wires it up:

- **Claude Code** — symlinked to `~/.claude/skills/minato/SKILL.md`, so it loads as the `minato` skill. Because it is a symlink, `git pull` updates the skill too.
- **Codex** — `~/.codex/prompts/minato.md` provides `/minato`, and a short pointer is appended to `~/.codex/AGENTS.md` for automatic pickup.

The guide teaches agents the operational rules — never restart a ship you did not start, never `kill -9`, never act on an ambiguous pier — plus the fact that `mcp sync` cannot help the session that ran it, since MCP servers connect at agent startup.

`AGENTS.md` in this repo is separate; it covers working on minato itself.

## State

- `~/.minato/config.json` — scan roots, scan depth, staleness threshold (default 14 days), agent config paths, parent planet.
- `~/.minato/cookies/` — cached Eyre sessions, `0600`. Delete to force re-authentication.
- `~/.minato/vere/` — vere binaries downloaded for booting new moons.
- `~/.minato/state.json` — per-pier metadata, **keyed by pier path**, not ship name: several piers can share a name (fakezods especially), so the name is not a unique key.

## Creating moons

```sh
minato new [shortname] --planet <ship-or-url> [--dir <path>] [--port <n>]
```

This authenticates to a parent ship over Eyre, runs the `gen-moon` thread to mint a moon, boots it detached, and records it. Adapted from [`gen-moon.sh`](https://github.com/tloncorp/tlon-apps/blob/mp/steward-crons/backend/gen-moon.sh) in tlon-apps.

- `--planet` takes a **full URL** for a self-hosted ship, or a bare ship name, which resolves to `<ship>.arvo.network` (`--hosted` for `tlon.network`). The parent that works is remembered, so later runs need no flag.
- The parent must be a planet, star, or galaxy — a moon cannot issue moons, and that is checked before you are asked for a password.
- **The moon's name is derived randomly by the parent, not chosen.** `shortname` is only a local alias; leave it off and one is derived from the ship name.
- `--dry-run` prints the plan and mints nothing. Minting is not reversible: the parent records the moon's keys, and since the name is random you cannot re-create the same one.
- The `+code` is prompted for without echo, sent in a form body rather than argv, and the session cookie is cached `0600` under `~/.minato/cookies/`.
- The returned key is written to a `0600` file in a private temp dir, passed to vere by path, and deleted once the boot finishes.
- The thread lives in the `%groups` desk by default; override with `--desk`.

Booting uses the newest vere already present in another pier, so a new moon lands on a version you are known to run. With no pier to borrow from, it downloads one into `~/.minato/vere/`.

`minato` does not install desks, so `%mcp` is not put on the moon for you. After creating one, install it on the ship and add its endpoint to your agent config.

### The unused allocator desk

`planet-desk/moon-allocator/` is an earlier, different approach: a Gall agent with its own append-only allocation ledger and idempotency by shortname, described in `docs/moon-allocator-protocol.md`. `minato new` does **not** use it — the `gen-moon` thread needs nothing installed on the parent beyond the `%groups` desk. The desk is kept because it offers a named, auditable allocation record, which `gen-moon` does not.

## Status

Works, and used daily against a couple dozen piers. No test suite yet; `AGENTS.md` documents the manual verification paths that cannot disturb a running ship. macOS only so far — the pier and process logic is not deeply platform-specific, but nothing has been verified on Linux.

An earlier v0 scaffold (March 2026) drove ships through `screen`. That approach was abandoned because ships in practice run as bare detached `.run` processes with no `screen` involved, which made every liveness check unreliable. It remains in the git history.

## License

MIT
