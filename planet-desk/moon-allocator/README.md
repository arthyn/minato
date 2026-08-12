# %moon-allocator (planet desk scaffold)

Tiny Gall agent desk for moon allocation authority on the planet.

## Intent

- Minato asks this agent to `ensure` allocation for a `shortname`.
- Agent is the allocation source of truth.
- Minato stores local operational cache and reconciles from agent export.

## Current scaffold status

This is **scaffold code**:
- state model + idempotent `ensure` path shape
- trusted source checks (`src.bowl == our.bowl`)
- scry export/list/get paths
- allocation execution is still a TODO hook (`alloc-unimplemented`)
- temporary `%ingest` action for manually recording `[short moon ticket]` while real allocator hook is being wired

## Files

- `app/moon-allocator.hoon` — Gall agent scaffold
- `desk.bill` — starts `%moon-allocator`
- `sys.kelvin` — desk kelvin pin

## Install (on planet)

```dojo
|new-desk %moon-allocator
|mount %moon-allocator
```

Copy these files into mounted desk, then:

```dojo
|commit %moon-allocator
|install our %moon-allocator
|start %moon-allocator
```

## Noun API (temporary)

Pokes (`%noun`):

- `[%ensure short=@tas]`
- `[%allocate short=@tas]`
- `[%set-note short=@tas note=@t]`
- `[%ingest short=@tas moon=@p ticket=@t]` (temporary bootstrap path)

Facts emitted (`%noun`):

- `[%ok alloc=[id=@ud short=@tas moon=@p ticket=@t issued=@da issuer=@p note=(unit @t)]]`
- `[%err code=@tas msg=@t]`

Scries:

- `/alloc/list`
- `/alloc/by-short/<shortname>`
- `/alloc/export`

## Next implementation step

Wire `++do-allocate` to a real allocator thread/bridge that can produce `(moon_ship, ticket)` from planet authority.

Planned bridge shape:
- `%moon-allocator` starts a controlled thread (`/ted/moon-allocator/allocate`) with `shortname`
- thread performs authority action and returns `(unit [moon=@p ticket=@t])`
- agent stores the allocation and emits `%ok` fact
