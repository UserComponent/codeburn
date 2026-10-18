# Happy Agent

Happy Agent (`@slopus/happy-agent`) — a multi-vendor agent runtime, not a wrapper over the vendor CLIs.

- **Source:** `src/providers/happy.ts`
- **Loading:** eager (`src/providers/index.ts`)
- **Test:** `tests/providers/happy.test.ts`

## Why this provider exists

Happy Agent talks to Anthropic, OpenAI, xAI, and other vendors directly
through its own provider library (including the Claude Agent SDK for
Anthropic), rather than shelling out to `claude`, `copilot`, or any other
installed CLI. It never writes those CLIs' own on-disk session formats, so
the `claude` and `copilot` providers never see usage run through Happy, no
matter how the underlying CLI tools are configured on the same machine.

Instead, every session Happy runs — across every model it routes to,
including subagents and workflow runs inside Happy's own workspaces — is
recorded in one SQLite database.

## Where it reads from

| Source | Path |
|---|---|
| Happy Agent daemon database | `$CODEBURN_HAPPY_AGENT_DB` if set, otherwise `$HAPPY_HOME_DIR/agent/agent.sqlite`, otherwise `~/.happy/agent/agent.sqlite` |

`HAPPY_HOME_DIR` moves the whole `.happy` root, matching Happy Agent's own
resolution (see its `docs/architecture.md`, "Persistence").

## Storage format

SQLite, written continuously by the Happy daemon in WAL mode. This provider
only reads four tables:

- `happy_agent_usage_records` — one row per inference call: `record_id`
  (dedup key), `agent_id`, `finished_at`, `kind` (`'inference'` carries
  token counts; `'turn'` and other kinds are ignored), and `record_json`
  (`provider`, `model`, `runId`, `tokens.{input,output,cacheRead,cacheWrite}`,
  `startedAt`, `finishedAt`). **`tokens.input` is the whole prompt, cache
  reads and writes included** — the same convention as Cline CLI's
  `inputTokens` — not the uncached remainder. The parser subtracts
  `cacheRead + cacheWrite` from it before pricing (see Quirks).
- `happy_agent_module_workspace_agents` — maps an `agent_id` to the
  workspace it ran in.
- `happy_agent_module_workspaces` — workspace `name` and `path`.
- `happy_agent_module_projects` — the project's display name, used as the
  report's project label when available.

One `SessionSource` is discovered per distinct `agent_id` that has at least
one `'inference'` row (`path: "<dbPath>:<agentId>"`, mirroring `warp.ts`'s
`dbPath:conversationId` encoding). An agent with no workspace association
(a chat outside any Happy workspace) reports under the `Happy Agent` label
instead of a project name.

This provider deliberately never reads `happy_agent_module_history` or any
other table holding message/tool-call content — only aggregate token counts
and workspace/project labels, which is also all CodeBurn needs.

## Parser

`src/providers/happy.ts` queries `happy_agent_usage_records` directly; there
is no separate parser module. Rows are read defensively: a session whose
`record_json` fails to parse is skipped, not fatal to the rest of the agent's
usage.

## Pricing

Happy's usage table carries only token counts, never a recorded dollar
amount, so every call is priced through CodeBurn's `calculateCost` and marked
`costIsEstimated: true`. Happy's own short model ids (`anthropic/sonnet-5-5`,
`anthropic/opus-5`, etc.) alias to CodeBurn's canonical Claude ids in
`BUILTIN_ALIASES` (`src/models.ts`), which are already present in the bundled
LiteLLM snapshot (`src/data/litellm-snapshot.json`) as of this writing, so
these price correctly out of the box. A model CodeBurn's pricing catalog does
not yet know (a future Happy-routed model with no LiteLLM entry) still prices
at $0 with the usual "no pricing data" warning, same as any other provider.

## Quirks

- `tokens.input` on every `'inference'` row is the whole prompt, not just
  the uncached portion: it already includes `cacheRead` and `cacheWrite`.
  Passing it straight to `calculateCost` alongside the cache fields bills
  every cached token twice — once as full-price input, again at its cache
  rate — which overcounted a sampled real-world Happy corpus by about 7x
  before this was caught. The parser computes
  `max(0, tokens.input - cacheRead - cacheWrite)` as the billed input
  token count; `tests/providers/happy.test.ts` pins the exact before/after
  dollar figures from that corpus as a regression test.
- The live database is written continuously by the Happy daemon; a
  `SQLITE_BUSY`/`SQLITE_LOCKED` read is treated as "unknown", not "empty",
  and is rethrown to the caller rather than sealing an incomplete scan
  (matching `warp.ts`).
- An `agent_id` can appear in `happy_agent_module_workspace_agents` for at
  most one workspace in practice; `queryAgentProjects` takes the first match
  if that ever changes.
- Subagents spawned inside a parent session have their own `agent_id` and
  therefore their own `SessionSource`; CodeBurn has no lineage evidence to
  group them under their parent the way Claude Code's own subagent
  transcripts do (see "What Gets Sent" in `docs/sync/README.md`).

## When fixing a bug here

1. Confirm whether the bug is in **discovery** (sessions not picked up) or
   **parsing** (sessions found but data wrong) — both live in
   `src/providers/happy.ts`.
2. Add a fixture-based test in `tests/providers/happy.test.ts` using a real
   temporary SQLite file (`node:sqlite`'s `DatabaseSync`), not a mock.
