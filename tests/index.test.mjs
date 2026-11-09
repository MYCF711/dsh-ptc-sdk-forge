// Apply-assembly contract for the single `ptc_sdk` tool.
//
// `apply` is the plugin's real host entry, so this suite drives it with a
// Context double that imitates only the host boundaries the assembly crosses:
// the Cordis loader channel (dynamic import by package name), the tool
// registry, the system-prompt sections and the PTC runtime capability.
// Official modules are imported for real through that channel; program
// execution is owned by `tests/runtime.test.mjs` and the rc1 probe, so this
// suite never runs a program and never resolves a live home.
//
// The invariants pinned here are architectural: one fixed `ptc_sdk`
// registration, no executor/preset/profile wiring, idempotent disposal and
// fail-closed registration.

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Config, apply, inject, name } from '../src/index.js'
import { ACTIONS, TOOL_NAME } from '../src/tool.js'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY_SOURCE = path.join(PROJECT_ROOT, 'src', 'index.js')

const HOST_TOOLS_PACKAGE = '@deepseek-ai/dsh-tools'
const HOME_PATHS_PACKAGE = '@deepseek-ai/dsh-home-paths'
const PTC_EXECUTOR_PACKAGE = '@deepseek-ai/dsh-tool-executor-ptc'

/** Base URL a real Cordis loader would hand the plugin. */
const CTX_BASE_URL = import.meta.url

const roots = []

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** @returns {Promise<string>} an isolated artifact-library root. */
async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-sdk-index-'))
  roots.push(root)
  return root
}

/** @returns {object} a fully configured plugin config pointing at `root`. */
function createConfig(root) {
  return {
    root,
    maxParallelSubCalls: 3,
    maxResultChars: 2_048,
    discoverLimit: 5,
  }
}

/**
 * Build a Context double.
 *
 * `loader.internal.import` resolves bare package names with a real dynamic
 * import, so `apply` loads the official modules themselves; every other
 * surface records calls instead of implementing host behavior.
 *
 * @param {object} [options]
 * @param {Error} [options.registerError] - thrown by the tool registry instead of accepting the definition.
 * @returns {{ ctx: object, record: object, live: Map<string, object> }} the double and its observations.
 */
function createContext({ registerError, unregisterError } = {}) {
  const record = {
    imports: [],
    registrations: [],
    unregistrations: 0,
    setExecutorCalls: 0,
    agentPresetRegistrations: 0,
    profileWrites: [],
    systemPromptCalls: [],
    schemasCalls: 0,
    resolveCalls: 0,
  }
  const live = new Map()

  const tools = {
    register(definition) {
      record.registrations.push(definition)
      if (registerError !== undefined) throw registerError
      if (live.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
      live.set(definition.name, definition)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        live.delete(definition.name)
        record.unregistrations += 1
        if (unregisterError !== undefined) throw unregisterError
      }
    },
    setExecutor() {
      record.setExecutorCalls += 1
    },
    schemas() {
      record.schemasCalls += 1
      return []
    },
    async resolve() {
      record.resolveCalls += 1
      return { view: () => new Map(), dispose() {} }
    },
  }

  const systemPrompt = {
    getSectionOrder(section) {
      record.systemPromptCalls.push(section)
      if (section === 'PTC_ONLY') return 800
      if (section === 'TOOLS_SDK') return 5_000
      throw new Error(`unknown system prompt section "${section}"`)
    },
  }

  const ptcRuntime = Object.freeze({ language: 'typescript', programFormat: 'function-body' })

  const agentPresets = {
    register(...args) {
      record.agentPresetRegistrations += 1
      return args
    },
  }

  const profiles = {
    write(...args) {
      record.profileWrites.push(args)
    },
    save(...args) {
      record.profileWrites.push(args)
    },
    set(...args) {
      record.profileWrites.push(args)
    },
  }

  const ctx = {
    baseUrl: CTX_BASE_URL,
    loader: {
      internal: {
        async import(specifier, baseUrl, options) {
          record.imports.push({ specifier, baseUrl, options })
          return await import(specifier)
        },
      },
    },
    tools,
    systemPrompt,
    ptcRuntime,
    agentPresets,
    profiles,
  }

  return { ctx, record, live }
}

test('exposes one plugin identity and a bounded Config', () => {
  assert.equal(name, 'ptc-sdk-forge')
  assert.deepEqual(inject, ['tools', 'ptcRuntime', 'systemPrompt'])

  assert.deepEqual(Config({}), {
    root: '',
    maxParallelSubCalls: 10,
    maxResultChars: 50_000,
    discoverLimit: 100,
  })

  const configured = createConfig('artifact-library')
  assert.deepEqual(Config(configured), configured)

  const rejected = [
    { maxParallelSubCalls: 0 },
    { maxParallelSubCalls: 1.5 },
    { maxParallelSubCalls: 65 },
    { maxResultChars: 1_023 },
    { maxResultChars: 1_000_001 },
    { discoverLimit: 0 },
    { discoverLimit: 501 },
    { root: 7 },
  ]
  for (const config of rejected) {
    assert.throws(() => Config(config), `Config must reject ${JSON.stringify(config)}`)
  }
})

test('applies as exactly one ordinary ptc_sdk tool, then disposes idempotently', async (t) => {
  const root = await makeRoot()
  const config = createConfig(root)
  const { ctx, record, live } = createContext()
  const runtime = ctx.ptcRuntime

  let dispose
  t.after(async () => {
    if (typeof dispose === 'function') await dispose()
  })

  dispose = await apply(ctx, config)
  assert.equal(typeof dispose, 'function')

  // The host loader channel resolves the official packages themselves; assembly
  // never imports the PTC executor because no program runs.
  assert.equal(record.imports.length, 2)
  assert.deepEqual(
    new Set(record.imports.map(({ specifier }) => specifier)),
    new Set([HOST_TOOLS_PACKAGE, HOME_PATHS_PACKAGE]),
  )
  assert.ok(
    record.imports.every(({ specifier }) => specifier !== PTC_EXECUTOR_PACKAGE),
    'assembly must not even load the official PTC executor',
  )
  for (const call of record.imports) {
    assert.equal(call.baseUrl, CTX_BASE_URL)
    assert.deepEqual(call.options, {})
  }

  // Exactly one fixed tool is registered, under its stable name.
  assert.equal(record.registrations.length, 1)
  const [definition] = record.registrations
  assert.equal(definition.name, TOOL_NAME)
  assert.equal(TOOL_NAME, 'ptc_sdk')
  assert.equal(live.size, 1)
  assert.equal(live.get('ptc_sdk'), definition)
  assert.deepEqual(definition.parameters.required, ['action'])
  assert.deepEqual(definition.parameters.properties.action.enum, [...ACTIONS])

  // The registered definition is a real, callable ordinary tool: a read-only
  // action runs against the isolated library without the runtime or writes.
  assert.deepEqual(await definition.execute({ action: 'list' }, {}), {
    ok: true,
    action: 'list',
    artifacts: [],
    total: 0,
    truncated: false,
  })

  // Assembly installs no executor, preset, prompt section or profile write.
  assert.equal(record.setExecutorCalls, 0)
  assert.equal(record.agentPresetRegistrations, 0)
  assert.deepEqual(record.profileWrites, [])
  assert.deepEqual(record.systemPromptCalls, [])
  assert.equal(record.schemasCalls, 0)
  assert.equal(record.resolveCalls, 0)
  assert.equal(ctx.ptcRuntime, runtime)
  assert.deepEqual({ ...ctx.ptcRuntime }, { language: 'typescript', programFormat: 'function-body' })
  assert.deepEqual(await readdir(root), [])

  // Concurrent and repeated disposal unregister once and stop the bridge.
  await Promise.all([dispose(), dispose()])
  assert.equal(await dispose(), undefined)
  assert.equal(record.unregistrations, 1)
  assert.equal(live.size, 0)
  assert.deepEqual(await definition.execute({ action: 'discover' }, {}), {
    ok: false,
    action: 'discover',
    error: { code: 'PTC_BRIDGE_DISPOSED', message: 'PTC runtime bridge was disposed' },
  })
})

test('fails closed when tool registration throws', async () => {
  const root = await makeRoot()
  const config = createConfig(root)
  const boom = new Error('tool registry rejected ptc_sdk')
  const { ctx, record, live } = createContext({ registerError: boom })

  const rejection = await apply(ctx, config).then(
    () => undefined,
    (error) => error,
  )
  assert.equal(rejection, boom, 'the registration error must propagate unchanged')

  assert.equal(record.registrations.length, 1)
  assert.equal(record.registrations[0].name, 'ptc_sdk')
  assert.equal(live.size, 0, 'a failed registration must leave no callable tool behind')
  assert.equal(record.unregistrations, 0)
  assert.equal(record.setExecutorCalls, 0)
  assert.equal(record.agentPresetRegistrations, 0)
  assert.deepEqual(record.profileWrites, [])
  assert.deepEqual(record.systemPromptCalls, [])
  assert.equal(record.imports.length, 2)
  assert.deepEqual(
    new Set(record.imports.map(({ specifier }) => specifier)),
    new Set([HOST_TOOLS_PACKAGE, HOME_PATHS_PACKAGE]),
  )
  assert.deepEqual(await readdir(root), [])

  // The definition captured during the failed attempt is inert: the bridge was
  // disposed before the registration error escaped, so no leaked handle can
  // start a program.
  assert.deepEqual(await record.registrations[0].execute({ action: 'discover' }, {}), {
    ok: false,
    action: 'discover',
    error: { code: 'PTC_BRIDGE_DISPOSED', message: 'PTC runtime bridge was disposed' },
  })
})

test('dispose still closes the runtime when unregister throws', async () => {
  const root = await makeRoot()
  const boom = new Error('unregister failed')
  const { ctx, record } = createContext({ unregisterError: boom })
  const dispose = await apply(ctx, createConfig(root))
  const [definition] = record.registrations

  await assert.rejects(dispose(), (error) => error === boom)
  assert.equal(record.unregistrations, 1)
  assert.deepEqual(await definition.execute({ action: 'discover' }, {}), {
    ok: false,
    action: 'discover',
    error: { code: 'PTC_BRIDGE_DISPOSED', message: 'PTC runtime bridge was disposed' },
  })
  assert.equal(await dispose(), undefined, 'the failed disposer remains idempotently closed')
})

test('keeps the entry module free of executor and profile wiring', async () => {
  const source = await readFile(ENTRY_SOURCE, 'utf8')

  assert.ok(!source.includes('setExecutor'), 'src/index.js must never install a tool executor')
  assert.ok(!source.includes('agentPresets'), 'src/index.js must never register an Agent preset')
  assert.ok(!source.includes('node:fs'), 'src/index.js must not own filesystem writes')
  assert.ok(!source.includes('writeFile'), 'src/index.js must not write profile or library files')
  assert.match(
    source,
    /export const apply = async \(ctx, config\) => \{/,
    'apply stays an arrow function returning the async disposer',
  )
})
