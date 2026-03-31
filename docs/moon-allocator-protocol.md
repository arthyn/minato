# Moon Allocator Protocol (Planet Desk <-> Minato)

Status: draft v0

Goal: one small desk on the planet that can mint moon tickets and expose allocator state to Minato.

## Trust Model

- Accept requests only from trusted ships (default: `our.bowl` only).
- No generic command execution.
- Idempotent by `shortname`.
- Allocation ledger is append-only.

## Data Model

```hoon
+$  shortname  @tas
+$  alloc-id   @ud
+
+$  allocation
  $:  id=alloc-id
      shortname=shortname
      moon_ship=@p
      ticket=@t
      issued-at=@da
      issuer=@p
      notes=(unit @t)
  ==
+
+$  allocator-state
  $:  next-id=alloc-id
      by-short=(map shortname allocation)
      events=(list allocation)
  ==
```

Notes:
- `ticket` can be stored raw initially for operational simplicity.
- If desired later, swap to `ticket-hash=@uv` + encrypted blob.

## Action Mark (poke)

Mark: `%moon-alloc-action`

```hoon
+$  action
  $%  [%allocate shortname=shortname]
      [%ensure shortname=shortname]              :: return existing or allocate
      [%set-note shortname=shortname note=@t]
  ==
```

Auth rule in `on-poke`:
- allow only when `src.bowl` is trusted (initially `=(src.bowl our.bowl)`).

Semantics:
- `%allocate`:
  - if `shortname` already exists -> nack `%already-exists`
  - else allocate new moon + ticket and store record
- `%ensure`:
  - if exists -> return existing record
  - else allocate and store
- `%set-note`:
  - mutate notes for existing record

## Reply / Fact Mark

Mark: `%moon-alloc-result`

```hoon
+$  result
  $%  [%ok allocation]
      [%err code=@tas msg=@t]
  ==
```

Common error codes:
- `%forbidden`
- `%invalid-shortname`
- `%already-exists`
- `%alloc-failed`
- `%not-found`

## Scry API (for Minato sync)

Agent app name suggestion: `%moon-allocator`

Paths:

- `/alloc/list` -> `(list allocation)`
- `/alloc/by-short/<shortname>` -> `(unit allocation)`
- `/alloc/export` -> `allocator-state`

All scries are read-only and can be gated by source policy if desired.

## Idempotency Rules

For `%ensure`:
- same shortname always returns the same allocation once created.
- never mints a second moon for an existing shortname.

For `%allocate`:
- explicit failure if already allocated (`%already-exists`).

## Minato Client Contract (v0)

`minato new <shortname> --auto` flow:
1. Poke allocator with `%ensure` for shortname.
2. Parse `%ok allocation`.
3. Boot moon locally from returned ticket.
4. Persist local state fields:
   - `shortname`
   - `moon_ship`
   - `pier_hint`
   - `last_booted_at`
   - `allocator_id`
5. `minato sync` can pull `/alloc/export` and reconcile local cache.

## Reconciliation Strategy

Local state is an operational cache.
Planet allocator desk is allocation source of truth.

Conflict policy:
- If local `moon_ship` differs from allocator record -> prefer allocator and flag warning.
- If local record missing but allocator has it -> import it.
- Never auto-delete local records from allocator absence without explicit user command.

## Suggested Validation

`shortname`:
- lowercase only
- `@tas` compatible
- length 2..20
- reject whitespace/symbols

## Minimal Event Log

Append every successful allocation to `events` list.

Useful for:
- audit
- debugging dupes
- replay/export

## Future Extensions

- ticket encryption at rest
- revoke/retire allocations
- remote moon health snapshots
- signed export for backup
