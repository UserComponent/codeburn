import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHappyProvider } from '../../src/providers/happy.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const requireForTest = createRequire(import.meta.url)

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'happy-provider-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function createHappyDb(dir: string): string {
  const dbPath = join(dir, 'agent.sqlite')
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  // Minimal subset of the real `agent.sqlite` schema this provider reads.
  db.exec(`
    CREATE TABLE happy_agent_usage_records (
      record_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      finished_at INTEGER,
      kind TEXT NOT NULL,
      record_json TEXT NOT NULL,
      run_id TEXT
    )
  `)
  db.exec(`
    CREATE TABLE happy_agent_module_workspace_agents (
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      order_key TEXT
    )
  `)
  db.exec(`
    CREATE TABLE happy_agent_module_workspaces (
      id TEXT PRIMARY KEY,
      project_ref TEXT,
      name TEXT,
      path TEXT
    )
  `)
  db.exec(`
    CREATE TABLE happy_agent_module_projects (
      id TEXT PRIMARY KEY,
      name TEXT
    )
  `)
  db.close()
  return dbPath
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = requireForTest('node:sqlite')
  const db = new Database(dbPath)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function insertUsageRecord(
  db: TestDb,
  opts: {
    recordId: string
    agentId: string
    finishedAt: number
    runId?: string
    model?: string
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    kind?: string
  },
): void {
  const record = {
    id: opts.recordId,
    agentId: opts.agentId,
    provider: 'claude',
    kind: opts.kind ?? 'inference',
    runId: opts.runId ?? 'run-1',
    tokens: opts.tokens ?? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    startedAt: opts.finishedAt - 1000,
    finishedAt: opts.finishedAt,
    model: opts.model ?? 'anthropic/sonnet-5-5',
  }
  db.prepare(
    'INSERT INTO happy_agent_usage_records (record_id, agent_id, finished_at, kind, record_json, run_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(opts.recordId, opts.agentId, opts.finishedAt, opts.kind ?? 'inference', JSON.stringify(record), opts.runId ?? 'run-1')
}

function insertWorkspace(
  db: TestDb,
  opts: { workspaceId: string; agentId: string; projectId: string; projectName: string; workspaceName: string; path: string },
): void {
  db.prepare('INSERT INTO happy_agent_module_projects (id, name) VALUES (?, ?)').run(opts.projectId, opts.projectName)
  db.prepare('INSERT INTO happy_agent_module_workspaces (id, project_ref, name, path) VALUES (?, ?, ?, ?)').run(
    opts.workspaceId, opts.projectId, opts.workspaceName, opts.path,
  )
  db.prepare('INSERT INTO happy_agent_module_workspace_agents (workspace_id, agent_id, order_key) VALUES (?, ?, ?)').run(
    opts.workspaceId, opts.agentId, '1',
  )
}

async function collectCalls(dbPath: string, agentId: string, seenKeys = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createHappyProvider(dbPath)
  const source = { path: `${dbPath}:${agentId}`, project: 'Happy Agent', provider: 'happy' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
    calls.push(call)
  }
  return calls
}

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('happy provider', () => {
  it('discovers one session per agent, labeled by its workspace project', async () => {
    const dbPath = createHappyDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertUsageRecord(db, { recordId: 'rec-1', agentId: 'agent-1', finishedAt: 1_790_000_000_000 })
      insertWorkspace(db, {
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        projectId: 'proj-1',
        projectName: 'flex',
        workspaceName: 'FLEX-9394 communicator auth',
        path: 'C:\\Users\\antho\\happy\\workspaces\\flex\\flex-9394-communicator-auth',
      })
    })

    const provider = createHappyProvider(dbPath)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('happy')
    expect(sessions[0]!.path).toBe(`${dbPath}:agent-1`)
    expect(sessions[0]!.project).toBe('flex')
  })

  it('falls back to the Happy Agent label when an agent has no workspace', async () => {
    const dbPath = createHappyDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertUsageRecord(db, { recordId: 'rec-1', agentId: 'agent-standalone', finishedAt: 1_790_000_000_000 })
    })

    const provider = createHappyProvider(dbPath)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('Happy Agent')
  })

  it('parses token counts, dedup key, and workspace path from an inference record', async () => {
    const dbPath = createHappyDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertUsageRecord(db, {
        recordId: 'rec-1',
        agentId: 'agent-1',
        finishedAt: 1_790_000_000_000,
        runId: 'run-abc',
        model: 'anthropic/sonnet-5-5',
        tokens: { input: 13_324, output: 394, cacheRead: 0, cacheWrite: 13_322 },
      })
      insertWorkspace(db, {
        workspaceId: 'ws-1', agentId: 'agent-1', projectId: 'proj-1', projectName: 'flex',
        workspaceName: 'ws', path: '/workspaces/flex/ticket-1',
      })
    })

    const calls = await collectCalls(dbPath, 'agent-1')
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.deduplicationKey).toBe('happy:agent-1:rec-1')
    expect(call.model).toBe('anthropic/sonnet-5-5')
    expect(call.inputTokens).toBe(13_324)
    expect(call.outputTokens).toBe(394)
    expect(call.cacheCreationInputTokens).toBe(13_322)
    expect(call.cacheReadInputTokens).toBe(0)
    expect(call.costIsEstimated).toBe(true)
    expect(call.turnId).toBe('run-abc')
    expect(call.sessionId).toBe('agent-1')
    expect(call.project).toBe('flex')
    expect(call.workingDirectory).toBe('/workspaces/flex/ticket-1')
    expect(call.timestamp).toBe(new Date(1_790_000_000_000).toISOString())
  })

  it('ignores non-inference rows and dedupes repeated record ids', async () => {
    const dbPath = createHappyDb(tmpDir)
    withTestDb(dbPath, (db) => {
      insertUsageRecord(db, { recordId: 'rec-turn', agentId: 'agent-1', finishedAt: 1_790_000_000_000, kind: 'turn' })
      insertUsageRecord(db, { recordId: 'rec-1', agentId: 'agent-1', finishedAt: 1_790_000_001_000 })
    })

    const seenKeys = new Set<string>()
    const first = await collectCalls(dbPath, 'agent-1', seenKeys)
    expect(first).toHaveLength(1)
    expect(first[0]!.deduplicationKey).toBe('happy:agent-1:rec-1')

    const second = await collectCalls(dbPath, 'agent-1', seenKeys)
    expect(second).toHaveLength(0)
  })

  it('skips a corrupt record_json row without throwing', async () => {
    const dbPath = createHappyDb(tmpDir)
    withTestDb(dbPath, (db) => {
      db.prepare(
        'INSERT INTO happy_agent_usage_records (record_id, agent_id, finished_at, kind, record_json, run_id) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('rec-bad', 'agent-1', 1_790_000_000_000, 'inference', '{not json', 'run-1')
      insertUsageRecord(db, { recordId: 'rec-good', agentId: 'agent-1', finishedAt: 1_790_000_001_000 })
    })

    const calls = await collectCalls(dbPath, 'agent-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.deduplicationKey).toBe('happy:agent-1:rec-good')
  })

  it('reports probeRoots pointing at the configured database path', async () => {
    const dbPath = join(tmpDir, 'agent.sqlite')
    const provider = createHappyProvider(dbPath)
    const roots = await provider.probeRoots!()
    expect(roots).toEqual([{ path: dbPath, label: 'agent.sqlite' }])
  })
})
