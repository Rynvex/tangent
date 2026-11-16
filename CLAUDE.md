# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Tangent is an embeddable Go library for AI conversations with tree-structured
branches: branch off any message, talk it through in the branch, and return to
the parent line with a structured conclusion card. It is designed to embed cleanly
into any Go + Postgres host service, and ships with a reference server and web UI
in the same repository.

**`docs/DESIGN.md` is the contract.** Read it before changing anything. If code
and the design disagree, fix the code or update the design first; never let
them drift. `docs/ROADMAP.md` lists the steps and their gates.

## Layout

```
domain/          pure types and logic; stdlib + google/uuid only, no IO
store/           Postgres: embedded migrations, sqlc queries, every transaction
store/db/        sqlc output, do not edit by hand (make sqlc)
tangent/         Engine: turn protocol, prompts, events, delta buffer, host hooks
httpapi/         mountable http.Handler (stdlib ServeMux) + SSE hub
runner/          Runner implementations (fake, openai-compatible, anthropic), net/http only
tangenttest/     test helpers: fresh schema per test, fake runner, event recorder
cmd/tangent-server/  reference server
web/             pnpm workspace: packages/client, packages/react, apps/demo
docs/devlog/     one log per step
```

Dependency direction: `domain` ← `store` ← `tangent` ← `httpapi` ← `cmd`.
`domain` never imports another package of this repo.

## Commands

```bash
make db-up        # Postgres on :5444 (dbs tangent, tangent_test)
make sqlc         # regenerate store/db after editing store/queries or migrations
make vet
make test         # go test ./... -count=1 (DB tests skip if :5444 is unreachable)
make check        # vet + test (+ web checks once web/ exists)
make serve        # reference server on :8120
```

## Rules

- Keep the invariants in DESIGN.md §5 exactly. Lock order is root → parent →
  child, sets in id order. Events are published only after commit.
- Ordering within a line is always by `seq`, never by `created_at`.
- The library never decides how an AI turn runs: `BeginTurn` / `CompleteTurn`
  are the contract, `RunTurn` and `NewRunnerDispatcher` are conveniences.
- No auth, accounts, git, worktrees or attachments in the library. Hosts put
  their own data in `host_meta`.
- Error codes follow the canonical table in `docs/API.md`.
- Code comments are English only. Docs may be Traditional Chinese.
- Record intentional design deviations in the step's devlog.
- Ports: Postgres 5444, server 8120, web dev 5183.
- Commit messages: conventional commits, no AI attribution lines.

## Coordination workflow

New sessions start from `docs/HANDOFF.md`. When verifying changes, run Go gates
plus smoke tests, `pnpm -C web typecheck`, `npx vitest run` in each web package
separately, and both web production builds (`mock` and `VITE_TANGENT_API=http`).
