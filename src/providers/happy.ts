import { homedir } from 'os'
import { join } from 'path'

import { calculateCost, getShortModelName } from '../models.js'
import {
  getSqliteLoadError,
  isSqliteAvailable,
  isSqliteBusyError,
  openDatabase,
  type SqliteDatabase,
} from '../sqlite.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

// Happy Agent (https://happy.engineering) is a multi-vendor agent runtime, not
// a thin wrapper over the vendor CLIs. It talks to Anthropic/OpenAI/xAI/etc
// directly through the Claude Agent SDK and its own provider library, and
// keeps every session — across every model it routes to — in one SQLite
// database at `$HAPPY_HOME_DIR/agent/agent.sqlite` (default `~/.happy/agent`).
// It never writes the vendor CLIs' own on-disk formats (no `~/.claude/projects`
// JSONL, no Copilot `session-store.db`), so those providers never see Happy's
// usage, however the vendor CLI itself is installed and configured.
//
// `happy_agent_usage_records` carries one row per inference call with full
// token counts; this provider reads only that table plus the workspace/project
// tables needed to label a call, never the message/history tables (which hold
// prompt text and tool-call detail).

const PROVIDER_NAME = 'happy'
const DISPLAY_NAME = 'Happy Agent'
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000

function happyHomeDir(): string {
  return process.env['HAPPY_HOME_DIR']?.trim() || join(homedir(), '.happy')
}

export function getHappyAgentDbPath(): string {
  return process.env['CODEBURN_HAPPY_AGENT_DB']?.trim() || join(happyHomeDir(), 'agent', 'agent.sqlite')
}

type UsageRecordRow = {
  record_id: string
  finished_at: number | null
  record_json: string
}

type InferenceRecord = {
  provider?: string
  model?: string
  runId?: string
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
  startedAt?: number
  finishedAt?: number
}

type AgentProjectRow = {
  agent_id: string
  workspace_path: string | null
  workspace_name: string | null
  project_name: string | null
}

function safeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined
}

function isoTimestamp(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  // Every timestamp in this database is epoch milliseconds, but guard against
  // an implausible seconds-resolution value the same way other providers do.
  const ms = value < MIN_REASONABLE_TIMESTAMP_MS ? value * 1000 : value
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) || date.getTime() < MIN_REASONABLE_TIMESTAMP_MS ? null : date.toISOString()
}

function validateSchema(db: SqliteDatabase): boolean {
  try {
    db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM happy_agent_usage_records LIMIT 1')
    return true
  } catch {
    return false
  }
}

// One row per agent that has at least one inference record, left-joined to
// whatever workspace/project it belongs to (a chat outside any workspace has
// neither, and reports under the Happy Agent fallback label). An agent is
// associated with at most one workspace in practice, so the first match wins.
function queryAgentProjects(db: SqliteDatabase): Map<string, AgentProjectRow> {
  const rows = db.query<AgentProjectRow>(
    `SELECT ur.agent_id AS agent_id, w.path AS workspace_path, w.name AS workspace_name, p.name AS project_name
     FROM (SELECT DISTINCT agent_id FROM happy_agent_usage_records WHERE kind = 'inference') ur
     LEFT JOIN happy_agent_module_workspace_agents wa ON wa.agent_id = ur.agent_id
     LEFT JOIN happy_agent_module_workspaces w ON w.id = wa.workspace_id
     LEFT JOIN happy_agent_module_projects p ON p.id = w.project_ref`,
  )
  const byAgent = new Map<string, AgentProjectRow>()
  for (const row of rows) {
    if (!byAgent.has(row.agent_id)) byAgent.set(row.agent_id, row)
  }
  return byAgent
}

function projectLabel(row: AgentProjectRow | undefined): string {
  return nonEmptyString(row?.project_name) ?? nonEmptyString(row?.workspace_name) ?? DISPLAY_NAME
}

function decodeSourcePath(path: string): { dbPath: string; agentId: string } {
  const splitIndex = path.lastIndexOf(':')
  if (splitIndex <= 0) return { dbPath: path, agentId: '' }
  return { dbPath: path.slice(0, splitIndex), agentId: path.slice(splitIndex + 1) }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const { dbPath, agentId } = decodeSourcePath(source.path)
      if (!agentId) return

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        // The daemon writes this database continuously; a busy/locked hit must
        // reach the caller rather than read as an empty, fully-scanned agent.
        if (isSqliteBusyError(err)) throw err
        process.stderr.write(`codeburn: cannot open Happy Agent database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!validateSchema(db)) return

        const agentProjects = queryAgentProjects(db)
        const projectRow = agentProjects.get(agentId)
        const project = projectLabel(projectRow)
        const workingDirectory = nonEmptyString(projectRow?.workspace_path)

        const rows = db.query<UsageRecordRow>(
          `SELECT record_id, finished_at, record_json
           FROM happy_agent_usage_records
           WHERE agent_id = ? AND kind = 'inference'
           ORDER BY finished_at ASC`,
          [agentId],
        )

        for (const row of rows) {
          const deduplicationKey = `${PROVIDER_NAME}:${agentId}:${row.record_id}`
          if (seenKeys.has(deduplicationKey)) continue

          let record: InferenceRecord
          try {
            record = JSON.parse(row.record_json) as InferenceRecord
          } catch {
            continue
          }

          const model = nonEmptyString(record.model)
          if (!model) continue

          const timestamp = isoTimestamp(record.finishedAt ?? row.finished_at)
          if (!timestamp) continue

          const tokens = record.tokens ?? {}
          const inputTokens = safeNonNegativeNumber(tokens.input)
          const outputTokens = safeNonNegativeNumber(tokens.output)
          const cacheReadTokens = safeNonNegativeNumber(tokens.cacheRead)
          const cacheWriteTokens = safeNonNegativeNumber(tokens.cacheWrite)
          if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) continue

          seenKeys.add(deduplicationKey)

          yield {
            provider: PROVIDER_NAME,
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheWriteTokens,
            cacheReadInputTokens: cacheReadTokens,
            cachedInputTokens: cacheReadTokens,
            reasoningTokens: 0,
            webSearchRequests: 0,
            // Happy's usage table carries token counts only, never a recorded
            // dollar amount for the call, so this is always a CodeBurn estimate.
            costUSD: calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, 0),
            costIsEstimated: true,
            tools: [],
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey,
            turnId: nonEmptyString(record.runId),
            userMessage: '',
            sessionId: agentId,
            project,
            projectPath: workingDirectory,
            workingDirectory,
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    if (!validateSchema(db)) return []
    const agentProjects = queryAgentProjects(db)
    return [...agentProjects.entries()].map(([agentId, row]) => ({
      path: `${dbPath}:${agentId}`,
      project: projectLabel(row),
      provider: PROVIDER_NAME,
    }))
  } catch (err) {
    // The daemon writes this database continuously: a busy/locked hit here is
    // not an empty database, and must not seal an incomplete scan.
    if (isSqliteBusyError(err)) throw err
    return []
  } finally {
    db.close()
  }
}

export function createHappyProvider(dbPathOverride?: string): Provider {
  const dbPath = (): string => dbPathOverride ?? getHappyAgentDbPath()

  return {
    name: PROVIDER_NAME,
    displayName: DISPLAY_NAME,

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: dbPath(), label: 'agent.sqlite' }]
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []
      return discoverFromDb(dbPath())
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const happy = createHappyProvider()
