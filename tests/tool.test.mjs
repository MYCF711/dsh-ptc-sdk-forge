// Contract tests for the single ordinary `ptc_sdk` tool.
//
// The store and the PTC runtime are in-memory mocks here: this suite owns the
// action dispatcher, canonical output and failure mapping, while `src/store.js`,
// `src/validate.js` and `src/runtime.js` have their own suites. The real
// static validator is used everywhere, and one integration case proves the
// dispatcher against the real on-disk store.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { ACTIONS, TOOL_NAME, createPtcSdkTool } from '../src/tool.js'
import { createProgramStore, ProgramStoreError } from '../src/store.js'
import { PtcBridgeDisposedError, PtcProgramError, PtcResultLimitError } from '../src/runtime.js'

/* ----------------------------------------------------------------- fixtures */

const PARAMETERS_A = Object.freeze({
  type: 'object',
  properties: { pattern: { type: 'string' } },
  required: ['pattern'],
  additionalProperties: false,
})

const PARAMETERS_B = Object.freeze({
  type: 'object',
  properties: { pattern: { type: 'string' }, limit: { type: 'integer' } },
  required: ['pattern', 'limit'],
  additionalProperties: false,
})

const CODE_A = 'const matches = await tools.grep({ pattern: args.pattern });\nreturn { matches };'
const CODE_B = 'return { pattern: args.pattern, limit: args.limit };'

const roots = []

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-sdk-tool-'))
  roots.push(root)
  return root
}

function artifactFixture(overrides = {}) {
  const name = overrides.name ?? 'repo-evidence-pack'
  const description = overrides.description ?? 'Collect and rank repository evidence.'
  const parameters = structuredClone(overrides.parameters ?? PARAMETERS_A)
  const code = overrides.code ?? CODE_A
  const at = overrides.createdAt ?? '2026-11-09T00:00:00.000Z'
  return {
    formatVersion: 1,
    name,
    description,
    parameters,
    latestRevision: 1,
    createdAt: at,
    updatedAt: overrides.updatedAt ?? at,
    archivedAt: overrides.archivedAt ?? null,
    versions: [
      {
        revision: 1,
        description,
        parameters,
        requiredTools: overrides.requiredTools ?? ['read'],
        code,
        createdAt: at,
      },
    ],
  }
}

function twoRevisionArtifact() {
  const artifact = artifactFixture()
  const parameters = structuredClone(PARAMETERS_B)
  artifact.description = 'Collect evidence with an enforced limit.'
  artifact.parameters = parameters
  artifact.latestRevision = 2
  artifact.updatedAt = '2026-11-09T00:00:01.000Z'
  artifact.versions.push({
    revision: 2,
    description: artifact.description,
    parameters,
    requiredTools: ['read', 'grep'],
    code: CODE_B,
    createdAt: '2026-11-09T00:00:01.000Z',
    changeNote: 'Require an explicit limit.',
  })
  return artifact
}

function summarizeArtifact(artifact) {
  return {
    name: artifact.name,
    description: artifact.description,
    latestRevision: artifact.latestRevision,
    archivedAt: artifact.archivedAt,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
}

function createMemoryStore(seed = []) {
  const artifacts = new Map(seed.map((artifact) => [artifact.name, structuredClone(artifact)]))
  const calls = []
  let clock = Date.parse('2026-11-09T00:00:00.000Z')

  function timestamp() {
    const value = new Date(clock).toISOString()
    clock += 1000
    return value
  }

  function snapshot(artifact) {
    return structuredClone(artifact)
  }

  return {
    calls,
    artifacts,
    async list(options = {}) {
      calls.push({ method: 'list', options })
      return [...artifacts.values()]
        .filter((artifact) => options.includeArchived === true || artifact.archivedAt === null)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(summarizeArtifact)
    },
    async get(name, revision) {
      calls.push({ method: 'get', name, revision })
      const artifact = artifacts.get(name)
      if (artifact === undefined) {
        throw new ProgramStoreError('PROGRAM_NOT_FOUND', `program "${name}" does not exist`, { name })
      }
      if (revision !== undefined && !artifact.versions.some((version) => version.revision === revision)) {
        throw new ProgramStoreError(
          'PROGRAM_REVISION_NOT_FOUND',
          `program "${name}" has no revision ${revision} (latest ${artifact.latestRevision})`,
          { name, revision, latestRevision: artifact.latestRevision },
        )
      }
      return snapshot(artifact)
    },
    async save(input) {
      calls.push({ method: 'save', input })
      const at = timestamp()
      const existing = artifacts.get(input.name)
      const requiredTools = [...(input.requiredTools ?? [])]

      if (existing === undefined) {
        if (input.expectedRevision !== undefined && input.expectedRevision !== 1) {
          throw new ProgramStoreError(
            'REVISION_CONFLICT',
            `cannot create program "${input.name}" at expectedRevision ${input.expectedRevision}: the program does not exist`,
            { expectedRevision: input.expectedRevision, latestRevision: null },
          )
        }
        const version = {
          revision: 1,
          description: input.description,
          parameters: structuredClone(input.parameters),
          requiredTools,
          code: input.code,
          createdAt: at,
        }
        if (input.changeNote !== undefined) version.changeNote = input.changeNote
        const artifact = {
          formatVersion: 1,
          name: input.name,
          description: version.description,
          parameters: version.parameters,
          latestRevision: 1,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          versions: [version],
        }
        artifacts.set(input.name, artifact)
        return { artifact: snapshot(artifact), version: snapshot(version) }
      }

      if (existing.archivedAt !== null) {
        throw new ProgramStoreError(
          'PROGRAM_ARCHIVED',
          `program "${input.name}" is archived since ${existing.archivedAt}; archived artifacts do not accept new revisions`,
          { name: input.name, archivedAt: existing.archivedAt },
        )
      }
      if (input.expectedRevision === undefined) {
        throw new ProgramStoreError(
          'EXPECTED_REVISION_REQUIRED',
          `program "${input.name}" already exists at revision ${existing.latestRevision}; pass expectedRevision to append a revision`,
          { name: input.name, latestRevision: existing.latestRevision },
        )
      }
      if (input.expectedRevision !== existing.latestRevision) {
        throw new ProgramStoreError(
          'REVISION_CONFLICT',
          `expectedRevision ${input.expectedRevision} does not match the latest revision ${existing.latestRevision} of program "${input.name}"`,
          { expectedRevision: input.expectedRevision, latestRevision: existing.latestRevision },
        )
      }

      const version = {
        revision: existing.latestRevision + 1,
        description: input.description,
        parameters: structuredClone(input.parameters),
        requiredTools,
        code: input.code,
        createdAt: at,
      }
      if (input.changeNote !== undefined) version.changeNote = input.changeNote
      const artifact = {
        ...existing,
        description: version.description,
        parameters: version.parameters,
        latestRevision: version.revision,
        updatedAt: at,
        versions: [...existing.versions, version],
      }
      artifacts.set(input.name, artifact)
      return { artifact: snapshot(artifact), version: snapshot(version) }
    },
    async archive(name) {
      calls.push({ method: 'archive', name })
      const artifact = artifacts.get(name)
      if (artifact === undefined) {
        throw new ProgramStoreError('PROGRAM_NOT_FOUND', `program "${name}" does not exist`, { name })
      }
      if (artifact.archivedAt === null) {
        const at = timestamp()
        artifact.archivedAt = at
        artifact.updatedAt = at
      }
      return snapshot(artifact)
    },
  }
}

function createMockRuntime(overrides = {}) {
  const calls = { discover: [], execute: [] }
  const tools = [
    { name: 'read', description: 'Read a file.' },
    { name: 'grep', description: 'Search files.' },
  ]
  return {
    calls,
    async discover(exec, toolNames) {
      calls.discover.push({ exec, toolNames })
      if (overrides.discover !== undefined) return overrides.discover(exec, toolNames)
      if (toolNames === undefined) return { tools: tools.map((tool) => ({ ...tool })) }
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const selected = []
      const missing = []
      for (const name of toolNames) {
        const tool = byName.get(name)
        if (tool === undefined) {
          missing.push(name)
          continue
        }
        selected.push({ ...tool, parameters: { type: 'object', properties: {}, additionalProperties: true } })
      }
      return { tools: selected, ...(missing.length > 0 ? { missing } : {}) }
    },
    async execute(request, exec) {
      calls.execute.push({ request, exec })
      if (overrides.execute !== undefined) return overrides.execute(request, exec)
      return { result: { echo: request.args }, logs: ['program log'] }
    },
  }
}

function createExec() {
  const controller = new AbortController()
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: TOOL_NAME,
    arguments: {},
    agent: { id: 'agent-fixture' },
    toolSet: undefined,
    signal: controller.signal,
    token: Symbol('execution'),
    deferContext() {},
    concludeTurn() {},
  }
}

function buildTool(options = {}) {
  const store = options.store ?? createMemoryStore()
  const runtime = options.runtime ?? createMockRuntime()
  const tool = createPtcSdkTool({ defineTool, store, runtime })
  return { tool, store, runtime }
}

/** Build the tool behind a pass-through `defineTool` so the raw dispatcher is reachable. */
function buildRawTool(options = {}) {
  const store = options.store ?? createMemoryStore()
  const runtime = options.runtime ?? createMockRuntime()
  const tool = createPtcSdkTool({ defineTool: (definition) => definition, store, runtime })
  return { tool, store, runtime }
}

/* --------------------------------------------------------------- definition */

test('createPtcSdkTool returns one ordinary ptc_sdk ToolDefinition', () => {
  const { tool } = buildTool()

  assert.equal(tool.name, TOOL_NAME)
  assert.equal(TOOL_NAME, 'ptc_sdk')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.description, 'string')
  assert.match(tool.description, /PTC/)
  assert.match(tool.description, /`args`/)
  assert.match(tool.description, /not a sandbox dry run/)
  assert.match(tool.description, /Archived artifacts are not run/)

  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, [...ACTIONS])
  assert.deepEqual([...ACTIONS], ['discover', 'validate', 'test', 'save', 'list', 'get', 'run', 'archive'])

  const success = { ok: true, action: 'list', artifacts: [], total: 0, truncated: false }
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, success, 'value'), [])

  const failure = {
    ok: false,
    action: 'get',
    error: {
      code: 'PROGRAM_NOT_FOUND',
      message: 'program "ghost" does not exist',
      details: { name: 'ToolError', code: 'UNKNOWN_TOOL' },
    },
    violations: ['name: must be a string'],
  }
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, failure, 'value'), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, { action: 'list' }, 'value'), [])
  assert.notDeepEqual(
    validateJsonSchemaValue(tool.output.schema, { ok: false, action: 'get', error: { code: 'X' } }, 'value'),
    [],
  )
})

test('createPtcSdkTool rejects a misassembled dependency set', () => {
  assert.throws(() => createPtcSdkTool(), TypeError)
  assert.throws(() => createPtcSdkTool({}), TypeError)
  assert.throws(() => createPtcSdkTool({ defineTool: null, store: createMemoryStore(), runtime: createMockRuntime() }), TypeError)

  const incompleteStore = { ...createMemoryStore(), archive: 7 }
  assert.throws(
    () => createPtcSdkTool({ defineTool, store: incompleteStore, runtime: createMockRuntime() }),
    TypeError,
  )
  assert.throws(() => createPtcSdkTool({ defineTool, store: createMemoryStore(), runtime: {} }), TypeError)
})

test('render emits canonical JSON with sorted object keys', () => {
  const { tool } = buildTool()
  const value = {
    ok: true,
    action: 'list',
    artifacts: [{ name: 'alpha', latestRevision: 2 }],
    total: 1,
    truncated: false,
  }

  const [block] = tool.output.render({ action: 'list' }, value)
  assert.equal(block.type, 'text')
  assert.equal(
    block.text,
    '{"action":"list","artifacts":[{"latestRevision":2,"name":"alpha"}],"ok":true,"total":1,"truncated":false}',
  )
  assert.deepEqual(JSON.parse(block.text), value)
})

/* ----------------------------------------------------------------- discover */

test('discover lists caller-visible tools without executing or writing', async () => {
  const { tool, store, runtime } = buildTool()
  const exec = createExec()

  const result = await tool.execute({ action: 'discover' }, exec)

  assert.deepEqual(result, {
    ok: true,
    action: 'discover',
    tools: [
      { name: 'read', description: 'Read a file.' },
      { name: 'grep', description: 'Search files.' },
    ],
  })
  assert.equal(runtime.calls.discover.length, 1)
  assert.equal(runtime.calls.discover[0].exec, exec)
  assert.equal(runtime.calls.discover[0].toolNames, undefined)
  assert.equal(runtime.calls.execute.length, 0)
  assert.deepEqual(store.calls, [])
})

test('discover returns named schemas and reports missing tools', async () => {
  const { tool, runtime } = buildTool()

  const result = await tool.execute({ action: 'discover', toolNames: ['read', 'ghost'] }, createExec())

  assert.equal(result.ok, true)
  assert.equal(result.tools.length, 1)
  assert.equal(result.tools[0].name, 'read')
  assert.deepEqual(result.missing, ['ghost'])
  assert.deepEqual(runtime.calls.discover[0].toolNames, ['read', 'ghost'])
})

test('a malformed discovery result propagates as a contract failure', async () => {
  const { tool } = buildRawTool({ runtime: createMockRuntime({ discover: async () => [] }) })

  await assert.rejects(tool.execute({ action: 'discover' }, createExec()), TypeError)
})

/* ----------------------------------------------------------------- validate */

test('validate statically accepts a canonical definition without executing or writing', async () => {
  const { tool, store, runtime } = buildTool()

  const result = await tool.execute(
    {
      action: 'validate',
      name: 'repo-evidence-pack',
      description: '  Collect and rank repository evidence.  ',
      parameters: structuredClone(PARAMETERS_A),
      code: CODE_A,
      requiredTools: ['read', 'read'],
    },
    createExec(),
  )

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.equal(result.action, 'validate')
  assert.deepEqual(result.definition, {
    name: 'repo-evidence-pack',
    description: 'Collect and rank repository evidence.',
    parameters: PARAMETERS_A,
    code: CODE_A,
    requiredTools: ['read'],
  })
  assert.deepEqual(result.warnings, [])
  assert.equal(runtime.calls.discover.length, 1, 'declared tools are resolved for visibility warnings')
  assert.equal(runtime.calls.execute.length, 0)
  assert.deepEqual(store.calls, [])
})

test('validate reports schema violations and never executes', async () => {
  const { tool, store, runtime } = buildTool()

  const result = await tool.execute(
    {
      action: 'validate',
      name: 'bad-schema',
      description: 'Declare a scalar root.',
      parameters: { type: 'string' },
      code: 'return 1;',
    },
    createExec(),
  )

  assert.equal(result.ok, false)
  assert.equal(result.action, 'validate')
  assert.equal(result.error.code, 'VALIDATION_FAILED')
  assert.ok(result.violations.length > 0)
  assert.match(result.violations.join('\n'), /parameters: schema\.type must be "object"/)
  assert.equal(runtime.calls.execute.length, 0)
  assert.deepEqual(store.calls, [])
})

test('validate reports requiredTools visibility as warnings only', async () => {
  const { tool } = buildTool()

  const result = await tool.execute(
    {
      action: 'validate',
      name: 'ghost-tools',
      description: 'Declare a tool this caller cannot see.',
      parameters: { type: 'object' },
      code: 'return 1;',
      requiredTools: ['read', 'ghost'],
    },
    createExec(),
  )

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /ghost/)
})

/* --------------------------------------------------------------------- save */

test('save creates revision 1 and never executes the program', async () => {
  const { tool, store, runtime } = buildTool()

  const result = await tool.execute(
    {
      action: 'save',
      name: 'repo-evidence-pack',
      description: 'Collect and rank repository evidence.',
      parameters: structuredClone(PARAMETERS_A),
      code: CODE_A,
      requiredTools: ['read'],
      changeNote: 'Initial version.',
    },
    createExec(),
  )

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.equal(result.action, 'save')
  assert.deepEqual(Object.keys(result.artifact).sort(), [
    'archivedAt',
    'createdAt',
    'description',
    'latestRevision',
    'name',
    'updatedAt',
  ])
  assert.equal(result.version.revision, 1)
  assert.equal(result.version.description, 'Collect and rank repository evidence.')
  assert.deepEqual(result.version.parameters, PARAMETERS_A)
  assert.deepEqual(result.version.requiredTools, ['read'])
  assert.equal(result.version.code, CODE_A)
  assert.equal(result.version.changeNote, 'Initial version.')
  assert.deepEqual(result.warnings, [])
  assert.equal(runtime.calls.execute.length, 0)
  assert.equal(store.calls.filter((call) => call.method === 'save').length, 1)
})

test('save appends a revision only when expectedRevision matches', async () => {
  const { tool } = buildTool()
  const exec = createExec()

  const first = await tool.execute(
    {
      action: 'save',
      name: 'revision-fixture',
      description: 'Collect and rank repository evidence.',
      parameters: structuredClone(PARAMETERS_A),
      code: CODE_A,
    },
    exec,
  )
  assert.equal(first.version.revision, 1)

  const second = await tool.execute(
    {
      action: 'save',
      name: 'revision-fixture',
      description: 'Collect evidence with an enforced limit.',
      parameters: structuredClone(PARAMETERS_B),
      code: CODE_B,
      expectedRevision: 1,
      changeNote: 'Require an explicit limit.',
    },
    exec,
  )
  assert.equal(second.ok, true, second.violations?.join('\n'))
  assert.equal(second.artifact.latestRevision, 2)
  assert.equal(second.version.revision, 2)
  assert.deepEqual(second.version.parameters, PARAMETERS_B)

  const conflict = await tool.execute(
    {
      action: 'save',
      name: 'revision-fixture',
      description: 'Stale write.',
      parameters: structuredClone(PARAMETERS_B),
      code: CODE_B,
      expectedRevision: 1,
    },
    exec,
  )
  assert.equal(conflict.ok, false)
  assert.equal(conflict.action, 'save')
  assert.equal(conflict.error.code, 'REVISION_CONFLICT')
  assert.match(conflict.error.message, /expectedRevision 1/)

  const missing = await tool.execute(
    {
      action: 'save',
      name: 'revision-fixture',
      description: 'No concurrency token.',
      parameters: structuredClone(PARAMETERS_A),
      code: CODE_A,
    },
    exec,
  )
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'EXPECTED_REVISION_REQUIRED')
})

test('save validates before writing and skips the store when invalid', async () => {
  const { tool, store } = buildTool()

  const result = await tool.execute(
    {
      action: 'save',
      name: 'bad-save',
      description: 'Broken source.',
      parameters: { type: 'object' },
      code: 'return (',
    },
    createExec(),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'VALIDATION_FAILED')
  assert.match(result.violations.join('\n'), /static syntax check failed/)
  assert.deepEqual(store.calls, [])
})

/* --------------------------------------------------------------------- test */

test('test executes unsaved source without writing an artifact', async () => {
  const { tool, store, runtime } = buildTool()
  const exec = createExec()

  const result = await tool.execute(
    {
      action: 'test',
      code: CODE_A,
      parameters: structuredClone(PARAMETERS_A),
      args: { pattern: 'TODO' },
    },
    exec,
  )

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.equal(result.action, 'test')
  assert.deepEqual(result.result, { echo: { pattern: 'TODO' } })
  assert.deepEqual(result.logs, ['program log'])
  assert.deepEqual(result.warnings, [])
  assert.equal('sandbox' in result, false, 'no sandbox descriptor is invented')
  assert.equal(runtime.calls.execute.length, 1)
  assert.equal(runtime.calls.execute[0].exec, exec)
  assert.equal(runtime.calls.execute[0].request.code, CODE_A)
  assert.match(runtime.calls.execute[0].request.description, /Unsaved PTC program/)
  assert.deepEqual(runtime.calls.execute[0].request.args, { pattern: 'TODO' })
  assert.equal(runtime.calls.discover.length, 0, 'test never resolves declared tools')
  assert.deepEqual(store.calls, [], 'test never writes to the library')
})

test('test accepts code alone and synthesizes its metadata', async () => {
  const { tool, runtime } = buildTool()

  const result = await tool.execute({ action: 'test', code: 'return 1;' }, createExec())

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.deepEqual(runtime.calls.execute[0].request.args, {})
})

test('test reports requiredTools visibility as warnings and still executes', async () => {
  const { tool, store, runtime } = buildTool()

  const result = await tool.execute(
    { action: 'test', code: 'return 1;', requiredTools: ['read', 'ghost'] },
    createExec(),
  )

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /ghost/)
  assert.equal(runtime.calls.discover.length, 1, 'test resolves declared tools read-only')
  assert.equal(runtime.calls.execute.length, 1, 'visibility warnings never block the program')
  assert.deepEqual(store.calls, [], 'test never writes to the library')
})

test('test projects the run sandbox descriptor onto its result', async () => {
  const sandbox = { mode: 'workspace-write', enforcement: 'enforced', denied: true }
  const runtime = createMockRuntime({ execute: async () => ({ result: { ok: true }, sandbox }) })
  const { tool } = buildTool({ runtime })

  const result = await tool.execute({ action: 'test', code: 'return { ok: true };' }, createExec())

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.deepEqual(result.sandbox, sandbox)
  assert.equal('logs' in result, false, 'empty logs are omitted')
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), [])
  assert.notDeepEqual(
    validateJsonSchemaValue(tool.output.schema, { ok: true, action: 'test', sandbox: { denied: 'yes' } }, 'value'),
    [],
    'the sandbox descriptor is schema-checked',
  )
})

test('test statically rejects broken source before executing', async () => {
  const { tool, store, runtime } = buildTool()

  const result = await tool.execute({ action: 'test', code: 'return (' }, createExec())

  assert.equal(result.ok, false)
  assert.equal(result.action, 'test')
  assert.equal(result.error.code, 'VALIDATION_FAILED')
  assert.match(result.violations.join('\n'), /static syntax check failed/)
  assert.equal(runtime.calls.execute.length, 0)
  assert.deepEqual(store.calls, [])
})

test('test validates args against the supplied schema before executing', async () => {
  const { tool, runtime } = buildTool()

  const result = await tool.execute(
    { action: 'test', code: CODE_A, parameters: structuredClone(PARAMETERS_A), args: {} },
    createExec(),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_ARGS')
  assert.match(result.violations[0], /args\.pattern/)
  assert.equal(runtime.calls.execute.length, 0)
})

/* --------------------------------------------------------------------- list */

test('list returns summaries without source and applies the limit', async () => {
  const store = createMemoryStore([artifactFixture({ name: 'alpha' }), artifactFixture({ name: 'beta' })])
  const { tool, runtime } = buildTool({ store })

  const result = await tool.execute({ action: 'list' }, createExec())

  assert.equal(result.ok, true)
  assert.equal(result.action, 'list')
  assert.deepEqual(result.artifacts.map((entry) => entry.name), ['alpha', 'beta'])
  assert.equal(result.total, 2)
  assert.equal(result.truncated, false)
  for (const summary of result.artifacts) {
    assert.deepEqual(Object.keys(summary).sort(), [
      'archivedAt',
      'createdAt',
      'description',
      'latestRevision',
      'name',
      'updatedAt',
    ])
  }
  assert.ok(!JSON.stringify(result).includes(CODE_A))
  assert.ok(!JSON.stringify(result).includes('"parameters"'))

  const limited = await tool.execute({ action: 'list', limit: 1 }, createExec())
  assert.deepEqual(limited.artifacts.map((entry) => entry.name), ['alpha'])
  assert.equal(limited.total, 2)
  assert.equal(limited.truncated, true)
  assert.equal(runtime.calls.execute.length, 0)
})

test('list hides archived artifacts unless includeArchived is requested', async () => {
  const archived = artifactFixture({ name: 'archived-fixture', archivedAt: '2026-11-09T02:00:00.000Z' })
  const { tool } = buildTool({ store: createMemoryStore([artifactFixture(), archived]) })

  const visible = await tool.execute({ action: 'list' }, createExec())
  assert.deepEqual(visible.artifacts.map((entry) => entry.name), ['repo-evidence-pack'])

  const all = await tool.execute({ action: 'list', includeArchived: true }, createExec())
  assert.deepEqual(all.artifacts.map((entry) => entry.name), ['archived-fixture', 'repo-evidence-pack'])
})

/* ---------------------------------------------------------------------- get */

test('get returns one summary plus only the selected revision', async () => {
  const { tool, runtime } = buildTool({ store: createMemoryStore([twoRevisionArtifact()]) })

  const latest = await tool.execute({ action: 'get', name: 'repo-evidence-pack' }, createExec())
  assert.equal(latest.ok, true)
  assert.equal(latest.action, 'get')
  assert.deepEqual(Object.keys(latest.artifact).sort(), [
    'archivedAt',
    'createdAt',
    'description',
    'latestRevision',
    'name',
    'updatedAt',
  ])
  assert.equal(latest.artifact.latestRevision, 2)
  assert.equal(latest.version.revision, 2)
  assert.deepEqual(latest.version.parameters, PARAMETERS_B)
  assert.equal(latest.version.code, CODE_B)
  assert.equal('versions' in latest.version, false)

  const historical = await tool.execute({ action: 'get', name: 'repo-evidence-pack', revision: 1 }, createExec())
  assert.equal(historical.ok, true)
  assert.equal(historical.version.revision, 1)
  assert.deepEqual(historical.version.parameters, PARAMETERS_A)
  assert.equal(historical.version.code, CODE_A)

  const missing = await tool.execute({ action: 'get', name: 'ghost' }, createExec())
  assert.equal(missing.ok, false)
  assert.equal(missing.action, 'get')
  assert.equal(missing.error.code, 'PROGRAM_NOT_FOUND')

  const missingRevision = await tool.execute({ action: 'get', name: 'repo-evidence-pack', revision: 9 }, createExec())
  assert.equal(missingRevision.error.code, 'PROGRAM_REVISION_NOT_FOUND')

  assert.equal(runtime.calls.execute.length, 0)
})

/* ---------------------------------------------------------------------- run */

test('run executes the selected revision with its own schema and source', async () => {
  const store = createMemoryStore([twoRevisionArtifact()])
  const { tool, runtime } = buildTool({ store })
  const exec = createExec()

  const latest = await tool.execute({ action: 'run', name: 'repo-evidence-pack', args: { pattern: 'TODO', limit: 2 } }, exec)
  assert.equal(latest.ok, true, latest.violations?.join('\n'))
  assert.equal(latest.action, 'run')
  assert.equal(latest.name, 'repo-evidence-pack')
  assert.equal(latest.revision, 2)
  assert.deepEqual(latest.result, { echo: { pattern: 'TODO', limit: 2 } })
  assert.equal(runtime.calls.execute[0].request.code, CODE_B)
  assert.equal(runtime.calls.execute[0].exec, exec)

  const historical = await tool.execute(
    { action: 'run', name: 'repo-evidence-pack', revision: 1, args: { pattern: 'TODO' } },
    exec,
  )
  assert.equal(historical.ok, true)
  assert.equal(historical.revision, 1)
  assert.equal(runtime.calls.execute[1].request.code, CODE_A)
  assert.deepEqual(runtime.calls.execute[1].request.args, { pattern: 'TODO' })

  const wrong = await tool.execute({ action: 'run', name: 'repo-evidence-pack', args: { pattern: 'TODO' } }, exec)
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error.code, 'INVALID_ARGS')
  assert.match(wrong.violations[0], /args\.limit/)
  assert.equal(runtime.calls.execute.length, 2, 'invalid args never reach the runtime')

  assert.deepEqual(store.calls.map((call) => call.method), ['get', 'get', 'get'])
  assert.ok(store.calls.every((call) => call.revision === undefined || typeof call.revision === 'number'))
})

test('run projects the run sandbox descriptor onto its result', async () => {
  const sandbox = { mode: 'danger-full-access', denied: false }
  const runtime = createMockRuntime({ execute: async () => ({ result: 7, sandbox }) })
  const { tool } = buildTool({ store: createMemoryStore([artifactFixture()]), runtime })

  const result = await tool.execute(
    { action: 'run', name: 'repo-evidence-pack', args: { pattern: 'TODO' } },
    createExec(),
  )

  assert.equal(result.ok, true, result.violations?.join('\n'))
  assert.equal(result.revision, 1)
  assert.deepEqual(result.sandbox, sandbox)
  assert.equal(result.logs, undefined, 'absent logs stay absent')
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), [])
  assert.notDeepEqual(
    validateJsonSchemaValue(tool.output.schema, { ok: true, action: 'run', sandbox: { mode: 7, denied: false } }, 'value'),
    [],
    'the sandbox descriptor is schema-checked',
  )
})

test('run refuses an archived artifact without executing it', async () => {
  const artifact = artifactFixture({ archivedAt: '2026-11-09T02:00:00.000Z' })
  const { tool, runtime } = buildTool({ store: createMemoryStore([artifact]) })

  const result = await tool.execute({ action: 'run', name: 'repo-evidence-pack' }, createExec())

  assert.equal(result.ok, false)
  assert.equal(result.action, 'run')
  assert.equal(result.error.code, 'PROGRAM_ARCHIVED')
  assert.match(result.error.message, /archived/)
  assert.equal(runtime.calls.execute.length, 0)
})

test('run reports a missing artifact as an expected failure', async () => {
  const { tool, runtime } = buildTool()

  const result = await tool.execute({ action: 'run', name: 'ghost' }, createExec())

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PROGRAM_NOT_FOUND')
  assert.equal(runtime.calls.execute.length, 0)
})

test('run preserves program, abort, disposed and limit failures', async () => {
  const cases = [
    [() => new PtcProgramError('program failed', { name: 'Error', code: 'PROGRAM_FAILED' }), 'PROGRAM_FAILED'],
    [() => {
      const error = new PtcProgramError('program aborted by the caller', { name: 'AbortError', code: 'ABORTED' })
      error.name = 'AbortError'
      return error
    }, 'PROGRAM_ABORTED'],
    [() => new PtcBridgeDisposedError(), 'PTC_BRIDGE_DISPOSED'],
    [() => new PtcResultLimitError('PTC program result is 90000 characters of canonical JSON; the limit is 50000'), 'LIMIT_EXCEEDED'],
  ]

  for (const [makeError, code] of cases) {
    const artifact = artifactFixture()
    const runtime = createMockRuntime({ execute: async () => { throw makeError() } })
    const { tool } = buildTool({ store: createMemoryStore([artifact]), runtime })

    const result = await tool.execute({ action: 'run', name: 'repo-evidence-pack', args: { pattern: 'TODO' } }, createExec())

    assert.equal(result.ok, false, code)
    assert.equal(result.action, 'run')
    assert.equal(result.error.code, code)
    assert.equal(typeof result.error.message, 'string')
    assert.ok(result.error.message.length > 0)
  }
})

test('a program failure keeps its structured info as error.details', async () => {
  const info = { name: 'ToolError', code: 'UNKNOWN_TOOL', reason: 'the nested tool is not registered' }
  const runtime = createMockRuntime({
    execute: async () => {
      throw new PtcProgramError('nested tool failed', info)
    },
  })
  const { tool } = buildTool({ runtime })

  const result = await tool.execute({ action: 'test', code: 'return 1;' }, createExec())

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PROGRAM_FAILED')
  assert.equal(result.error.message, 'nested tool failed')
  assert.deepEqual(result.error.details, info)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), [])
})

test('an aborted program keeps its structured info as error.details', async () => {
  const info = { name: 'AbortError', code: 'ABORTED' }
  const runtime = createMockRuntime({
    execute: async () => {
      const error = new PtcProgramError('program aborted by the caller', info)
      error.name = 'AbortError'
      throw error
    },
  })
  const { tool } = buildTool({ runtime })

  const result = await tool.execute({ action: 'test', code: 'return 1;' }, createExec())

  assert.equal(result.error.code, 'PROGRAM_ABORTED')
  assert.deepEqual(result.error.details, info)
})

test('a non-limit RangeError propagates instead of being reported as a limit', async () => {
  const executeFailure = new RangeError('Invalid array length')
  const { tool } = buildTool({
    runtime: createMockRuntime({
      execute: async () => {
        throw executeFailure
      },
    }),
  })
  await assert.rejects(
    tool.execute({ action: 'test', code: 'return 1;' }, createExec()),
    (error) => error === executeFailure,
  )

  const discoverFailure = new RangeError('discovery exploded')
  const { tool: second } = buildTool({
    runtime: createMockRuntime({
      discover: async () => {
        throw discoverFailure
      },
    }),
  })
  await assert.rejects(
    second.execute({ action: 'discover' }, createExec()),
    (error) => error === discoverFailure,
  )
})

/* ------------------------------------------------------------------ archive */

test('archive marks the artifact archived while every revision is kept', async () => {
  const store = createMemoryStore([twoRevisionArtifact()])
  const { tool } = buildTool({ store })

  const result = await tool.execute({ action: 'archive', name: 'repo-evidence-pack' }, createExec())

  assert.equal(result.ok, true)
  assert.equal(result.action, 'archive')
  assert.match(result.artifact.archivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(result.artifact.latestRevision, 2)
  assert.deepEqual(store.artifacts.get('repo-evidence-pack').versions.map((version) => version.revision), [1, 2])

  const listed = await tool.execute({ action: 'list' }, createExec())
  assert.deepEqual(listed.artifacts, [])

  const run = await tool.execute({ action: 'run', name: 'repo-evidence-pack' }, createExec())
  assert.equal(run.error.code, 'PROGRAM_ARCHIVED')

  const missing = await tool.execute({ action: 'archive', name: 'ghost' }, createExec())
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'PROGRAM_NOT_FOUND')
})

/* ------------------------------------------------------------ argument shape */

test('every action rejects its missing required fields before any effect', async () => {
  const { tool, store, runtime } = buildRawTool()

  const cases = [
    ['validate', { action: 'validate' }, ['name', 'description', 'parameters', 'code']],
    ['test', { action: 'test' }, ['code']],
    ['save', { action: 'save' }, ['name', 'description', 'parameters', 'code']],
    ['get', { action: 'get' }, ['name']],
    ['run', { action: 'run' }, ['name']],
    ['archive', { action: 'archive' }, ['name']],
  ]

  for (const [action, args, fields] of cases) {
    const result = await tool.execute(args, createExec())
    assert.equal(result.ok, false, action)
    assert.equal(result.action, action)
    assert.equal(result.error.code, 'INVALID_ARGUMENT')
    assert.ok(Array.isArray(result.violations) && result.violations.length >= fields.length)
    for (const field of fields) {
      assert.ok(
        result.violations.some((violation) => violation.includes(`"${field}"`)),
        `${action} must report ${field}: ${result.violations.join('; ')}`,
      )
    }
  }

  assert.deepEqual(store.calls, [])
  assert.deepEqual(runtime.calls.execute, [])
  assert.deepEqual(runtime.calls.discover, [])
})

test('unknown fields and malformed scalars are rejected', async () => {
  const { tool, store } = buildRawTool()

  const unknown = await tool.execute({ action: 'list', summary: true }, createExec())
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'INVALID_ARGUMENT')
  assert.match(unknown.violations.join('\n'), /unknown argument "summary"/)

  const badRevision = await tool.execute({ action: 'get', name: 'repo-evidence-pack', revision: 0 }, createExec())
  assert.match(badRevision.violations.join('\n'), /revision: must be a positive integer/)

  const badExpected = await tool.execute({ action: 'save', name: 'x', description: 'x', parameters: { type: 'object' }, code: 'return 1;', expectedRevision: 1.5 }, createExec())
  assert.match(badExpected.violations.join('\n'), /expectedRevision: must be a positive integer/)

  const badLimit = await tool.execute({ action: 'list', limit: -1 }, createExec())
  assert.match(badLimit.violations.join('\n'), /limit: must be a positive integer/)

  const badTools = await tool.execute({ action: 'discover', toolNames: 'read' }, createExec())
  assert.match(badTools.violations.join('\n'), /toolNames: must be an array of strings/)

  const badDeclaration = await tool.execute({ action: 'validate', name: 'x', description: 'x', parameters: { type: 'object' }, code: 'return 1;', requiredTools: 'read' }, createExec())
  assert.match(badDeclaration.violations.join('\n'), /requiredTools: must be an array of strings/)

  const badFlag = await tool.execute({ action: 'list', includeArchived: 'yes' }, createExec())
  assert.match(badFlag.violations.join('\n'), /includeArchived: must be a boolean/)

  assert.deepEqual(store.calls, [])
})

test('revision, limit and expectedRevision reject unsafe integers', async () => {
  const { tool } = buildRawTool({ store: createMemoryStore([artifactFixture()]) })

  const cases = [
    [{ action: 'get', name: 'repo-evidence-pack', revision: 1e21 }, /revision: must be a positive integer/],
    [
      { action: 'run', name: 'repo-evidence-pack', revision: Number.MAX_SAFE_INTEGER + 1 },
      /revision: must be a positive integer/,
    ],
    [{ action: 'list', limit: 1e21 }, /limit: must be a positive integer/],
    [
      {
        action: 'save',
        name: 'repo-evidence-pack',
        description: 'Collect evidence.',
        parameters: { type: 'object' },
        code: 'return 1;',
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      },
      /expectedRevision: must be a positive integer/,
    ],
  ]

  for (const [args, pattern] of cases) {
    const result = await tool.execute(args, createExec())
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.equal(result.action, args.action)
    assert.equal(result.error.code, 'INVALID_ARGUMENT')
    assert.match(result.violations.join('\n'), pattern)
  }

  // The largest safe integer is a valid revision type; the store reports the
  // missing revision instead of the dispatcher rejecting the value.
  const boundary = await tool.execute(
    { action: 'get', name: 'repo-evidence-pack', revision: Number.MAX_SAFE_INTEGER },
    createExec(),
  )
  assert.equal(boundary.error.code, 'PROGRAM_REVISION_NOT_FOUND')
})

test('an invalid action is an expected error on the raw dispatcher', async () => {
  const { tool, store, runtime } = buildRawTool()

  const result = await tool.execute({ action: 'launch' }, createExec())
  assert.equal(result.ok, false)
  assert.equal(result.action, 'launch')
  assert.equal(result.error.code, 'INVALID_ACTION')
  assert.match(result.error.message, /discover, validate, test, save, list, get, run, archive/)

  const nonObject = await tool.execute('save', createExec())
  assert.equal(nonObject.ok, false)
  assert.equal(nonObject.action, 'unknown')
  assert.equal(nonObject.error.code, 'INVALID_ARGUMENT')

  assert.deepEqual(store.calls, [])
  assert.deepEqual(runtime.calls.execute, [])
})

test('the host parameter schema rejects an invalid action before dispatch', async () => {
  const { tool, store, runtime } = buildTool()

  await assert.rejects(tool.execute({ action: 'launch' }, createExec()), { code: 'INVALID_ARGS' })
  await assert.rejects(tool.execute('save', createExec()), { code: 'INVALID_ARGS' })
  await assert.rejects(tool.execute({ action: 'list', limit: 'many' }, createExec()), { code: 'INVALID_ARGS' })

  assert.deepEqual(store.calls, [])
  assert.deepEqual(runtime.calls.execute, [])
})

/* ----------------------------------------------------------------- failures */

test('unexpected collaborator failures propagate instead of becoming fake success', async () => {
  const storeFailure = new Error('storage exploded')
  const store = createMemoryStore()
  store.get = async () => {
    throw storeFailure
  }
  const { tool } = buildTool({ store })

  await assert.rejects(
    tool.execute({ action: 'get', name: 'repo-evidence-pack' }, createExec()),
    (error) => error === storeFailure,
  )

  const runtimeFailure = new Error('runtime exploded')
  const runtime = createMockRuntime({
    execute: async () => {
      throw runtimeFailure
    },
  })
  const { tool: second } = buildTool({ runtime })

  await assert.rejects(
    second.execute({ action: 'test', code: 'return 1;' }, createExec()),
    (error) => error === runtimeFailure,
  )
})

/* --------------------------------------------------------------- integration */

test('the tool integrates with the real store across instances', async () => {
  const root = await makeRoot()
  const runtime = createMockRuntime()

  const first = buildTool({ store: createProgramStore({ root }), runtime })
  const saved = await first.tool.execute(
    {
      action: 'save',
      name: 'repo-evidence-pack',
      description: 'Collect and rank repository evidence.',
      parameters: structuredClone(PARAMETERS_A),
      code: CODE_A,
    },
    createExec(),
  )
  assert.equal(saved.ok, true, saved.violations?.join('\n'))
  assert.equal(saved.version.revision, 1)
  assert.deepEqual(saved.artifact.name, 'repo-evidence-pack')

  const second = buildTool({ store: createProgramStore({ root }), runtime })
  const read = await second.tool.execute({ action: 'get', name: 'repo-evidence-pack' }, createExec())
  assert.equal(read.ok, true)
  assert.equal(read.version.code, CODE_A)
  assert.deepEqual(read.version.parameters, PARAMETERS_A)

  const ran = await second.tool.execute(
    { action: 'run', name: 'repo-evidence-pack', args: { pattern: 'TODO' } },
    createExec(),
  )
  assert.equal(ran.ok, true, ran.violations?.join('\n'))
  assert.equal(ran.revision, 1)

  const archived = await second.tool.execute({ action: 'archive', name: 'repo-evidence-pack' }, createExec())
  assert.equal(archived.ok, true)
  assert.match(archived.artifact.archivedAt, /^\d{4}-/)

  const listed = await second.tool.execute({ action: 'list', includeArchived: true }, createExec())
  assert.equal(listed.artifacts.length, 1)
  assert.equal(listed.artifacts[0].name, 'repo-evidence-pack')
  assert.deepEqual(await second.tool.execute({ action: 'list' }, createExec()).then((value) => value.artifacts), [])
})

test('the real store keeps every revision and runs a historical one with its own schema', async () => {
  const root = await makeRoot()
  const runtime = createMockRuntime()
  const { tool } = buildTool({ store: createProgramStore({ root }), runtime })

  const created = await tool.execute(
    {
      action: 'save',
      name: 'revision-fixture',
      description: 'Collect and rank repository evidence.',
      parameters: structuredClone(PARAMETERS_A),
      code: CODE_A,
    },
    createExec(),
  )
  assert.equal(created.ok, true, created.violations?.join('\n'))

  const appended = await tool.execute(
    {
      action: 'save',
      name: 'revision-fixture',
      description: 'Collect evidence with an enforced limit.',
      parameters: structuredClone(PARAMETERS_B),
      code: CODE_B,
      expectedRevision: 1,
      changeNote: 'Require an explicit limit.',
    },
    createExec(),
  )
  assert.equal(appended.ok, true, appended.violations?.join('\n'))
  assert.equal(appended.version.revision, 2)

  // Revision 1 still validates against its own (pattern-only) schema and source.
  const historical = await tool.execute(
    { action: 'run', name: 'revision-fixture', revision: 1, args: { pattern: 'TODO' } },
    createExec(),
  )
  assert.equal(historical.ok, true, historical.violations?.join('\n'))
  assert.equal(historical.revision, 1)
  assert.equal(runtime.calls.execute.at(-1).request.code, CODE_A)
  assert.deepEqual(runtime.calls.execute.at(-1).request.args, { pattern: 'TODO' })

  // Revision 2 requires `limit`; the historical arguments are rejected rather
  // than silently upgraded to the latest schema.
  const latest = await tool.execute(
    { action: 'run', name: 'revision-fixture', args: { pattern: 'TODO', limit: 2 } },
    createExec(),
  )
  assert.equal(latest.ok, true, latest.violations?.join('\n'))
  assert.equal(latest.revision, 2)
  assert.equal(runtime.calls.execute.at(-1).request.code, CODE_B)

  const stale = await tool.execute(
    {
      action: 'save',
      name: 'revision-fixture',
      description: 'Stale write.',
      parameters: structuredClone(PARAMETERS_B),
      code: CODE_B,
      expectedRevision: 1,
    },
    createExec(),
  )
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'REVISION_CONFLICT')

  const read = await tool.execute({ action: 'get', name: 'revision-fixture', revision: 1 }, createExec())
  assert.deepEqual(read.version.parameters, PARAMETERS_A)
  assert.equal(read.version.code, CODE_A)
  assert.equal(read.artifact.latestRevision, 2)
})
