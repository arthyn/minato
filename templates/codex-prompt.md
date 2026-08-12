Get a working Urbit moon before doing ship work, using the `minato` CLI.

Read @@SKILL@@ first — it is the canonical guide and covers the command surface, the MCP audit table, exit codes, and the safety rules. Follow it.

Quick orientation, so you know whether you need to read further:

```bash
minato list            # what's actually running, and on what port
minato doctor          # drift, including MCP entries vs live piers
minato start <moon>    # boot one, detached, on the port agents expect
minato mcp sync        # fix drifted ports in ~/.claude.json and ~/.codex/config.toml
```

Codex-specific notes:

- Your own MCP servers live in `~/.codex/config.toml` under `[mcp_servers.NAME]`. `minato` audits and repairs that file as well as Claude Code's, and labels every finding with which agent it came from.
- `minato mcp sync` rewrites **ports only** and preserves your `--headers` / API keys / cookies byte-for-byte. It backs the file up to `~/.codex/config.toml.minato-backup` first.
- A sync cannot help the session you are in — Codex connects MCP servers at startup. After a sync, tell the user to restart Codex; do not retry the tool and report it as still broken.
- Inside a sandbox `ps` is denied, so minato falls back to inferring liveness from `.vere.lock` and prints `LIVENESS INFERRED`. Piers shown as `unknown` are undetermined, **not** stopped, and `start`/`stop` refuse with exit 4. Never report "no moons are running" on that basis.
- Do not stop or restart a moon you did not start without asking. Other sessions depend on these ships.

$ARGUMENTS
