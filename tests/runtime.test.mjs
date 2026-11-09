/**
 * Unit and contract tests for the official PTC execution bridge.
 *
 * The executor is injected, so these tests assert the bridge's own contract
 * exactly: the synthesized `run_code` batch, the single private executor, the
 * ownership of resolved tool sets, the `ptc_sdk` self-recursion mask, the
 * reserved `args` prelude, deferred context and turn conclusion, failure
 * identity, abort/dispose settlement and canonical output.
 *
 * They also pin the official public API shape that the default loader relies on.
 * They are NOT a real-host six-mode probe; live rc1 acceptance is separate.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  ARGS_BINDING_NAME,
  PTC_EXECUTOR_PACKAGE,
  PTC_SDK_TOOL_NAME,
  PTC_TRANSPORT_TOOL_NAME,
  PtcBridgeDisposedError,
  PtcProgramError,
  PtcResultLimitError,
  createPtcRuntimeBridge,
} from '../src/runtime.js'

const AGENT = Object.freeze({ session: Object.freeze({ id: 'session-1' }) })
const CALL_ID = 'call-1'

/** @returns {object} one registered tool definition (only `name`/`description`/`parameters` are projected). */
function createDefinition(name, description = `${name} description`) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    execute: async () => null,
    output: { schema: {}, render: () => [] },
  }
}

/** @returns {object} a `ResolvedToolSet` double that records ownership. */
function createToolSet(definitions, agent = AGENT) {
  const state = { disposed: 0, views: [] }
  return {
    state,
    view(scope) {
      state.views.push(scope)
      return scope === agent ? definitions : new Map()
    },
    dispose() {
      state.disposed += 1
    },
  }
}

/** @returns {object} a tool run context double with deferred-context recorders. */
function createExec({ agent = AGENT, signal, toolSet, callId = CALL_ID, withToolSet = true } = {}) {
  const exec = {
    callId,
    agent,
    signal: signal ?? new AbortController().signal,
    deferred: [],
    concluded: 0,
    deferContext(context) {
      exec.deferred.push(context)
    },
    concludeTurn() {
      exec.concluded += 1
    },
  }
  if (withToolSet) exec.toolSet = toolSet ?? createToolSet(new Map())
  return exec
}

/** @returns {{ ctx: object, record: object }} a plugin Context double. */
function createContext({ agent = AGENT, language, programFormat, retainsState } = {}) {
  const record = { resolveCalls: [], schemasCalls: [], resolvedDisposed: 0 }
  const tools = {
    async resolve(context) {
      record.resolveCalls.push(context)
      return {
        view: (scope) => (scope === context.agent ? new Map() : new Map()),
        dispose: () => {
          record.resolvedDisposed += 1
        },
      }
    },
    schemas(scope, toolSet) {
      record.schemasCalls.push({ scope, toolSet })
      return [...toolSet.view(scope).values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
    },
  }
  const ctx = { tools }
  if (language !== undefined || programFormat !== undefined || retainsState !== undefined) {
    ctx.ptcRuntime = {
      ...(language === undefined ? {} : { language }),
      ...(programFormat === undefined ? {} : { programFormat }),
      ...(retainsState === undefined ? {} : { retainsState }),
    }
  }
  return { ctx, record }
}

/** @returns {object} a `PtcExecutor` class double that records every batch. */
function createFakeExecutor() {
  const state = { inputs: [], constructed: 0, configs: [], handler: undefined, ctx: undefined }
  class FakePtcExecutor {
    constructor(ctx, config) {
      state.constructed += 1
      state.configs.push(config)
      state.ctx = ctx
    }

    async execute(input) {
      state.inputs.push(input)
      if (state.handler !== undefined) return await state.handler(input)
      return successBatch({ ok: true })
    }
  }
  return { state, FakePtcExecutor }
}

/** @returns {object} a successful `ToolBatchResult` for the transport value `{ logs, result? }`. */
function successBatch(value, { logs = [], sandbox, additionalContexts = [], concluded = false, callId = CALL_ID } = {}) {
  const transport = { logs }
  if (value !== undefined) transport.result = value
  if (sandbox !== undefined) transport.sandbox = sandbox
  return {
    results: [{ callId, result: { isError: false, value: transport, content: [] } }],
    additionalContexts,
    concluded,
  }
}

/** @returns {object} a failed `ToolBatchResult`. */
function failureBatch(message, info, { additionalContexts = [], concluded = false } = {}) {
  return {
    results: [{
      callId: CALL_ID,
      result: { isError: true, error: info === undefined ? { message } : { message, info }, content: [] },
    }],
    additionalContexts,
    concluded,
  }
}

/** @returns {Promise<object>} a bridge whose executor module is the given double. */
function createBridge(ctx, fake, options = {}) {
  return createPtcRuntimeBridge(ctx, {
    loadExecutorModule: async () => ({ PtcExecutor: fake.FakePtcExecutor }),
    ...options,
  })
}

/** @returns {{ prelude: string, literal: string, code: string }} the reserved-args prelude split from the program body. */
function splitProgram(program) {
  const newline = program.indexOf('\n')
  assert.notEqual(newline, -1, 'the program must contain the args prelude')
  const prelude = program.slice(0, newline)
  const marker = 'JSON.parse('
  const start = prelude.indexOf(marker)
  assert.notEqual(start, -1, 'the prelude must parse a JSON string literal')
  return {
    prelude,
    literal: prelude.slice(start + marker.length, -2),
    code: program.slice(newline + 1),
  }
}

test('execute synthesizes exactly one run_code call and omits log', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  const exec = createExec()

  const output = await bridge.execute({ code: 'return 1;', description: 'sum one' }, exec)

  assert.deepEqual(output, { result: { ok: true } })
  assert.equal(fake.state.inputs.length, 1)
  const [batch] = fake.state.inputs
  assert.equal(Object.hasOwn(batch, 'log'), false)
  assert.deepEqual(Object.keys(batch).sort(), ['agent', 'calls', 'signal', 'toolSet'])
  assert.equal(batch.agent, AGENT)
  assert.ok(batch.signal instanceof AbortSignal)
  assert.equal(batch.signal.aborted, false)

  assert.equal(batch.calls.length, 1)
  const [call] = batch.calls
  assert.deepEqual(Object.keys(call).sort(), ['arguments', 'id', 'name', 'type'])
  assert.equal(call.type, 'tool-call')
  assert.equal(call.id, CALL_ID)
  assert.equal(call.name, PTC_TRANSPORT_TOOL_NAME)
  assert.equal(typeof call.arguments, 'string')
  const transport = JSON.parse(call.arguments)
  assert.equal(transport.description, 'sum one')
  assert.ok(transport.code.endsWith('return 1;'))

  await bridge.dispose()
})

test('constructs one PtcExecutor per bridge, including concurrent programs', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake, { maxParallelSubCalls: 3 })
  const exec = createExec()

  await bridge.execute({ code: 'return 1;', description: 'first' }, exec)
  await Promise.all([
    bridge.execute({ code: 'return 2;', description: 'second' }, exec),
    bridge.execute({ code: 'return 3;', description: 'third' }, exec),
  ])

  assert.equal(fake.state.constructed, 1)
  assert.deepEqual(fake.state.configs, [{ maxParallelSubCalls: 3 }])
  assert.equal(fake.state.ctx, ctx)
  await bridge.dispose()
})

test('fails closed without the step tool set', async () => {
  const { ctx, record } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'no tool set' }, createExec({ withToolSet: false })),
    /exec\.toolSet/,
  )
  await assert.rejects(bridge.discover(createExec({ withToolSet: false })), /exec\.toolSet/)

  // No executor, no batch, no ad-hoc resolution: a conditional tool is never
  // admitted with an undefined model selection.
  assert.equal(fake.state.constructed, 0)
  assert.equal(fake.state.inputs.length, 0)
  assert.equal(record.resolveCalls.length, 0)
  await bridge.dispose()
})

test('does not dispose a caller-provided tool set', async () => {
  const toolSet = createToolSet(new Map([['grep', createDefinition('grep')]]))
  const { ctx, record } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await bridge.execute({ code: 'return 1;', description: 'provided' }, createExec({ toolSet }))

  assert.equal(record.resolveCalls.length, 0)
  assert.equal(toolSet.state.disposed, 0)
  await bridge.dispose()
})

test('propagates a transport failure without disposing the caller tool set', async () => {
  const toolSet = createToolSet(new Map([['grep', createDefinition('grep')]]))
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => {
    throw new Error('transport exploded')
  }
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'boom' }, createExec({ toolSet })),
    /transport exploded/,
  )
  assert.equal(toolSet.state.disposed, 0)
  await bridge.dispose()
})

test('masks ptc_sdk out of nested bindings without mutating the caller tool set', async () => {
  const definitions = new Map([
    [PTC_SDK_TOOL_NAME, createDefinition(PTC_SDK_TOOL_NAME)],
    ['grep', createDefinition('grep')],
  ])
  const toolSet = createToolSet(definitions)
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await bridge.execute({ code: 'return 1;', description: 'mask' }, createExec({ toolSet }))

  const [batch] = fake.state.inputs
  assert.deepEqual([...batch.toolSet.view(AGENT).keys()], ['grep'])
  assert.deepEqual([...toolSet.view(AGENT).keys()], [PTC_SDK_TOOL_NAME, 'grep'])
  assert.deepEqual(Object.keys(batch.toolSet).sort(), ['dispose', 'view'])
  // The facade's dispose is a no-op: the caller still owns the set.
  batch.toolSet.dispose()
  assert.equal(toolSet.state.disposed, 0)

  await bridge.dispose()
})

test('injects args through a canonical JSON prelude with a reserved binding', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  const args = {
    pattern: 'a"b\\c\nd',
    'weird key': [1, true, null],
    nested: { z: 1, a: 2 },
  }
  const code = 'return { pattern: args.pattern };'

  await bridge.execute({ code, description: 'args', args }, createExec())

  const program = JSON.parse(fake.state.inputs[0].calls[0].arguments).code
  const { prelude, literal, code: body } = splitProgram(program)
  assert.ok(prelude.startsWith(`const ${ARGS_BINDING_NAME} = JSON.parse(`))
  assert.ok(prelude.endsWith(');'))
  assert.deepEqual(JSON.parse(JSON.parse(literal)), args)
  assert.deepEqual(Object.keys(JSON.parse(JSON.parse(literal))), ['nested', 'pattern', 'weird key'])
  assert.equal(body, code)
  await bridge.dispose()
})

test('injects an empty object when args are omitted', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await bridge.execute({ code: 'return 1;', description: 'no args' }, createExec())

  const program = JSON.parse(fake.state.inputs[0].calls[0].arguments).code
  const { literal } = splitProgram(program)
  assert.deepEqual(JSON.parse(JSON.parse(literal)), {})
  await bridge.dispose()
})

test('a hostile args value cannot escape the prelude', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  // JSON.parse, not an object literal: `__proto__` must stay an own data key.
  const hostile = JSON.parse('{"payload":"\\"); process.exit(1); //","closing":"</script>","newlines":"a\\nb\\r\\nc","separators":"\\u2028\\u2029","__proto__":{"polluted":true}}')

  await bridge.execute({ code: 'return args;', description: 'hostile', args: hostile }, createExec())

  const program = JSON.parse(fake.state.inputs[0].calls[0].arguments).code
  const { literal, code: body } = splitProgram(program)
  // One prelude line only: no argument newline reached the program source.
  assert.equal(program.split('\n').length, 2)
  assert.equal(body, 'return args;')
  const roundTripped = JSON.parse(JSON.parse(literal))
  assert.equal(roundTripped.payload, hostile.payload)
  assert.equal(roundTripped.closing, hostile.closing)
  assert.equal(roundTripped.newlines, hostile.newlines)
  assert.equal(roundTripped.separators, hostile.separators)
  assert.deepEqual(roundTripped.__proto__, { polluted: true })
  assert.equal({}.polluted, undefined)
  await bridge.dispose()
})

test('ferries deferred context and a concluded turn to the outer call', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  const first = { role: 'user', content: 'one' }
  const second = { role: 'user', content: 'two' }
  fake.state.handler = async () => successBatch(7, { additionalContexts: [first, second], concluded: true })

  const exec = createExec()
  const output = await bridge.execute({ code: 'return 7;', description: 'context' }, exec)

  assert.deepEqual(output, { result: 7 })
  assert.deepEqual(exec.deferred, [first, second])
  assert.equal(exec.concluded, 1)
  await bridge.dispose()
})

test('does not conclude a turn for a non-terminal batch', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => successBatch(undefined)
  const bridge = await createBridge(ctx, fake)

  const exec = createExec()
  assert.deepEqual(await bridge.execute({ code: 'return;', description: 'quiet' }, exec), {})
  assert.deepEqual(exec.deferred, [])
  assert.equal(exec.concluded, 0)
  await bridge.dispose()
})

test('requires the tool run context to ferry nested context', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => successBatch(1, { additionalContexts: [{ role: 'user', content: 'x' }] })
  const bridge = await createBridge(ctx, fake)
  const exec = createExec()
  delete exec.deferContext

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'no context api' }, exec),
    /deferContext/,
  )
  await bridge.dispose()
})

test('preserves the program failure message and structured info', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const info = { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED', reason: 'raw detail' }
  fake.state.handler = async () => failureBatch('code run failed (exception): boom', info)
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'throw new Error("boom");', description: 'fail' }, createExec()),
    (error) => {
      assert.ok(error instanceof PtcProgramError)
      assert.equal(error.name, 'PtcProgramError')
      assert.equal(error.message, 'code run failed (exception): boom')
      assert.deepEqual(error.info, info)
      return true
    },
  )
  await bridge.dispose()
})

test('keeps caller cancellation as an AbortError', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => failureBatch('tool call aborted', { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' })
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'aborted' }, createExec()),
    (error) => {
      assert.ok(error instanceof PtcProgramError)
      assert.equal(error.name, 'AbortError')
      assert.equal(error.message, 'tool call aborted')
      return true
    },
  )
  await bridge.dispose()
})

test('rejects a batch without a result for the run_code call', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => ({ results: [], additionalContexts: [], concluded: false })
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'empty batch' }, createExec()),
    /ToolExecutionResult/,
  )
  await bridge.dispose()
})

test('rejects a malformed batch', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => null
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'null batch' }, createExec()),
    /ToolBatchResult/,
  )
  await bridge.dispose()
})

test('fuses the caller signal with the bridge controller', { timeout: 10_000 }, async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  const controller = new AbortController()
  let observed
  fake.state.handler = (input) => new Promise((resolve, reject) => {
    observed = input.signal
    input.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  })

  const pending = bridge.execute({ code: 'return 1;', description: 'abort' }, createExec({ signal: controller.signal }))
  await delay(0)
  controller.abort(new Error('caller cancelled'))

  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(observed.aborted, true)
  await bridge.dispose()
})

test('rejects a pre-aborted caller signal before dispatch', async () => {
  const { ctx, record } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'pre-aborted' }, createExec({ signal: controller.signal })),
    { name: 'AbortError' },
  )
  assert.equal(fake.state.inputs.length, 0)
  assert.equal(record.resolveCalls.length, 0)
  await bridge.dispose()
})

test('dispose aborts in-flight programs, awaits settlement, and is idempotent', { timeout: 10_000 }, async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  let settled = false
  fake.state.handler = (input) => new Promise((resolve) => {
    input.signal.addEventListener('abort', () => {
      // Settle off the abort stack: `dispose()` must wait, not just return.
      setTimeout(() => {
        settled = true
        resolve(failureBatch('tool call aborted', { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' }))
      }, 5)
    }, { once: true })
  })

  const pending = bridge.execute({ code: 'return 1;', description: 'dispose' }, createExec())
  pending.catch(() => {})
  await delay(0)

  const first = bridge.dispose()
  const second = bridge.dispose()
  assert.equal(first, second)
  await first

  assert.equal(settled, true, 'dispose must resolve only after every started program settled')
  assert.equal(bridge.disposed, true)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  await assert.rejects(bridge.execute({ code: 'return 1;', description: 'after' }, createExec()), PtcBridgeDisposedError)
  await assert.rejects(bridge.discover(createExec()), PtcBridgeDisposedError)
  await bridge.dispose()
})

test('returns canonical JSON with sorted keys and normalized negative zero', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => successBatch({ b: 1, a: [2, -0] }, { logs: ['first line'] })
  const bridge = await createBridge(ctx, fake)

  const output = await bridge.execute({ code: 'return 1;', description: 'canonical' }, createExec())

  assert.deepEqual(output, { result: { a: [2, 0], b: 1 }, logs: ['first line'] })
  assert.deepEqual(Object.keys(output.result), ['a', 'b'])
  assert.ok(Object.is(output.result.a[1], 0))
  await bridge.dispose()
})

test('projects the sandbox descriptor onto its bounded fields', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => successBatch({ ok: true }, {
    sandbox: { mode: 'workspace-write', enforcement: 'enforced', denied: true, extra: 'dropped' },
  })
  const bridge = await createBridge(ctx, fake)

  const output = await bridge.execute({ code: 'return 1;', description: 'sandbox' }, createExec())

  // The official denial survives; unknown runtime fields do not pass through.
  assert.deepEqual(output, {
    result: { ok: true },
    sandbox: { denied: true, enforcement: 'enforced', mode: 'workspace-write' },
  })
  assert.deepEqual(Object.keys(output.sandbox), ['denied', 'enforcement', 'mode'])
  await bridge.dispose()
})

test('projects a sandbox descriptor without an enforcement field', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => successBatch(undefined, { sandbox: { mode: 'danger-full-access', denied: false } })
  const bridge = await createBridge(ctx, fake)

  const output = await bridge.execute({ code: 'return;', description: 'sandbox only' }, createExec())

  assert.deepEqual(output, { sandbox: { denied: false, mode: 'danger-full-access' } })
  await bridge.dispose()
})

test('rejects a malformed sandbox descriptor', async () => {
  const cases = [
    ['not an object', 'workspace-write'],
    ['array', []],
    ['missing mode', { denied: true }],
    ['empty mode', { mode: '', denied: true }],
    ['non-boolean denied', { mode: 'workspace-write', denied: 'yes' }],
    ['non-string enforcement', { mode: 'workspace-write', denied: false, enforcement: 1 }],
  ]
  for (const [label, sandbox] of cases) {
    const { ctx } = createContext()
    const fake = createFakeExecutor()
    fake.state.handler = async () => successBatch(1, { sandbox })
    const bridge = await createBridge(ctx, fake)
    await assert.rejects(
      bridge.execute({ code: 'return 1;', description: label }, createExec()),
      TypeError,
      label,
    )
    await bridge.dispose()
  }
})

test('bounds the sandbox descriptor against the result cap', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => successBatch(1, { sandbox: { mode: 'workspace-write'.repeat(8), denied: false } })
  const bridge = await createBridge(ctx, fake, { maxResultChars: 32 })

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'oversize sandbox' }, createExec()),
    (error) => {
      assert.ok(error instanceof PtcResultLimitError)
      assert.equal(error.code, 'LIMIT_EXCEEDED')
      return true
    },
  )
  await bridge.dispose()
})

test('exposes the result limit as a typed RangeError', () => {
  const error = new PtcResultLimitError('too big')

  assert.ok(error instanceof RangeError)
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'PtcResultLimitError')
  assert.equal(error.code, 'LIMIT_EXCEEDED')
  assert.equal(error.message, 'too big')
})

test('rejects every value canonical JSON cannot express', async () => {
  const circular = {}
  circular.self = circular
  const sparse = [1]
  sparse[2] = 3
  const cases = [
    ['bigint', 1n],
    ['undefined element', [1, undefined]],
    ['function', () => {}],
    ['symbol', Symbol('nope')],
    ['circular reference', circular],
    ['class instance', new Date(0)],
    ['nan', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['sparse array', sparse],
    ['map', new Map()],
  ]

  for (const [label, value] of cases) {
    const { ctx } = createContext()
    const fake = createFakeExecutor()
    fake.state.handler = async () => successBatch(value)
    const bridge = await createBridge(ctx, fake)
    await assert.rejects(
      bridge.execute({ code: 'return 1;', description: label }, createExec()),
      TypeError,
      label,
    )
    await bridge.dispose()
  }
})

test('rejects non-string program logs', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => ({
    results: [{ callId: CALL_ID, result: { isError: false, value: { logs: [1], result: 'x' } } }],
    additionalContexts: [],
  })
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'console.log(1);', description: 'logs' }, createExec()),
    /must be a string/,
  )
  await bridge.dispose()
})

test('bounds the canonical result size', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  fake.state.handler = async () => successBatch('x'.repeat(64))
  const bridge = await createBridge(ctx, fake, { maxResultChars: 32 })

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'oversize' }, createExec()),
    (error) => {
      assert.ok(error instanceof PtcResultLimitError)
      assert.equal(error.code, 'LIMIT_EXCEEDED')
      assert.equal(error.name, 'PtcResultLimitError')
      return true
    },
  )
  await bridge.dispose()
})

test('bounds the injected args size before touching the executor', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake, { maxArgsChars: 8 })

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'oversize args', args: { long: 'xxxxxxxx' } }, createExec()),
    (error) => {
      assert.ok(error instanceof PtcResultLimitError)
      assert.equal(error.code, 'LIMIT_EXCEEDED')
      return true
    },
  )
  assert.equal(fake.state.constructed, 0)
  assert.equal(fake.state.inputs.length, 0)
  await bridge.dispose()
})

test('discover lists caller-scoped schemas without ptc_sdk', async () => {
  const definitions = new Map([
    [PTC_SDK_TOOL_NAME, createDefinition(PTC_SDK_TOOL_NAME)],
    ['grep', createDefinition('grep', 'search files')],
    ['read', createDefinition('read', 'read files')],
  ])
  const toolSet = createToolSet(definitions)
  const { ctx, record } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  const result = await bridge.discover(createExec({ toolSet }))

  assert.deepEqual(result, {
    tools: [
      { name: 'grep', description: 'search files' },
      { name: 'read', description: 'read files' },
    ],
  })
  assert.equal(record.schemasCalls.length, 1)
  assert.equal(record.schemasCalls[0].scope, AGENT)
  assert.equal(record.schemasCalls[0].toolSet.view(AGENT).has(PTC_SDK_TOOL_NAME), false)
  assert.equal(toolSet.state.disposed, 0)
  await bridge.dispose()
})

test('discover filters ptc_sdk even when the registry ignores the admission set', async () => {
  // Defense in depth: the real registry projects through the masked facade, but a
  // registry that returned the plugin's own tool anyway must not leak it.
  const toolSet = createToolSet(new Map([['grep', createDefinition('grep', 'search files')]]))
  const ctx = {
    tools: {
      async resolve() {
        throw new Error('unused')
      },
      schemas: () => [
        { name: PTC_SDK_TOOL_NAME, description: 'self', parameters: { type: 'object', properties: {} } },
        { name: 'grep', description: 'search files', parameters: { type: 'object', properties: {} } },
      ],
    },
  }
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  const result = await bridge.discover(createExec({ toolSet }))

  assert.deepEqual(result, { tools: [{ name: 'grep', description: 'search files' }] })
  await bridge.dispose()
})

test('discover returns full schemas for requested names and reports missing ones', async () => {
  const definitions = new Map([
    [PTC_SDK_TOOL_NAME, createDefinition(PTC_SDK_TOOL_NAME)],
    ['read', createDefinition('read', 'read files')],
  ])
  const toolSet = createToolSet(definitions)
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  const result = await bridge.discover(createExec({ toolSet }), ['read', 'missing', 'read'])

  assert.deepEqual(result, {
    tools: [{ name: 'read', description: 'read files', parameters: { type: 'object', properties: {} } }],
    missing: ['missing'],
  })
  await bridge.dispose()
})

test('discover caps the summary listing and reports truncation', async () => {
  const definitions = new Map([
    ['a', createDefinition('a')],
    ['b', createDefinition('b')],
    ['c', createDefinition('c')],
  ])
  const toolSet = createToolSet(definitions)
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake, { discoverLimit: 2 })

  const result = await bridge.discover(createExec({ toolSet }))

  assert.deepEqual(result.tools.map((tool) => tool.name), ['a', 'b'])
  assert.equal(result.truncated, true)
  await bridge.dispose()
})

test('bounds the whole discover result, not just each schema', async () => {
  const definitions = new Map([
    ['a', createDefinition('a')],
    ['b', createDefinition('b')],
    ['c', createDefinition('c')],
  ])
  const toolSet = createToolSet(definitions)
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  // Each summary fits (41 chars); the joined answer does not.
  const bridge = await createBridge(ctx, fake, { discoverLimit: 10, maxResultChars: 60 })

  await assert.rejects(
    bridge.discover(createExec({ toolSet })),
    (error) => {
      assert.ok(error instanceof PtcResultLimitError)
      assert.equal(error.code, 'LIMIT_EXCEEDED')
      assert.match(error.message, /discover result/)
      return true
    },
  )
  await bridge.dispose()
})

test('discover rejects an oversized or malformed name filter', async () => {
  const toolSet = createToolSet(new Map([['a', createDefinition('a')], ['b', createDefinition('b')]]))
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake, { discoverLimit: 1 })

  await assert.rejects(bridge.discover(createExec({ toolSet }), ['a', 'b']), (error) => {
    assert.ok(error instanceof PtcResultLimitError)
    assert.equal(error.code, 'LIMIT_EXCEEDED')
    return true
  })
  await assert.rejects(bridge.discover(createExec({ toolSet }), 'a'), TypeError)
  await assert.rejects(bridge.discover(createExec({ toolSet }), ['']), TypeError)
  await bridge.dispose()
})



test('loads PtcExecutor through the host loader channel', async () => {
  const calls = []
  const fake = createFakeExecutor()
  const ctx = {
    baseUrl: 'file:///plugin/src/index.js',
    loader: {
      internal: {
        import: async (...args) => {
          calls.push(args)
          return { PtcExecutor: fake.FakePtcExecutor }
        },
      },
    },
    tools: {
      async resolve() {
        throw new Error('unused')
      },
      schemas: () => [],
    },
  }
  const bridge = await createPtcRuntimeBridge(ctx)
  const toolSet = createToolSet(new Map())

  await bridge.execute({ code: 'return 1;', description: 'loader' }, createExec({ toolSet }))

  assert.deepEqual(calls, [[PTC_EXECUTOR_PACKAGE, ctx.baseUrl, {}]])
  assert.equal(fake.state.constructed, 1)
  await bridge.dispose()
})

test('rejects a host module without a PtcExecutor constructor', async () => {
  const { ctx } = createContext()
  const bridge = await createPtcRuntimeBridge(ctx, { loadExecutorModule: async () => ({}) })

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'no constructor' }, createExec({ toolSet: createToolSet(new Map()) })),
    /PtcExecutor/,
  )
  await bridge.dispose()
})

test('retries the module load after a failed construction', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  let attempts = 0
  const bridge = await createPtcRuntimeBridge(ctx, {
    loadExecutorModule: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('load failed')
      return { PtcExecutor: fake.FakePtcExecutor }
    },
  })

  await assert.rejects(bridge.execute({ code: 'return 1;', description: 'retry' }, createExec()), /load failed/)
  await bridge.execute({ code: 'return 1;', description: 'retry' }, createExec())

  assert.equal(attempts, 2)
  assert.equal(fake.state.constructed, 1)
  await bridge.dispose()
})

test('requires the calling Agent for programs and discovery', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)
  const signal = new AbortController().signal

  await assert.rejects(bridge.execute({ code: 'return 1;', description: 'no agent' }, { callId: CALL_ID, signal }), /exec\.agent/)
  await assert.rejects(bridge.discover({ callId: CALL_ID, signal }), /exec\.agent/)
  assert.equal(fake.state.inputs.length, 0)
  await bridge.dispose()
})

test('requires the caller signal', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(bridge.execute({ code: 'return 1;', description: 'no signal' }, { callId: CALL_ID, agent: AGENT }), /exec\.signal/)
  await assert.rejects(bridge.discover({ callId: CALL_ID, agent: AGENT }), /exec\.signal/)
  assert.equal(fake.state.inputs.length, 0)
  await bridge.dispose()
})

test('rejects malformed program requests before touching the executor', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(bridge.execute(null, createExec()), TypeError)
  await assert.rejects(bridge.execute({ code: '', description: 'x' }, createExec()), /code/)
  await assert.rejects(bridge.execute({ code: '   ', description: 'x' }, createExec()), /code/)
  await assert.rejects(bridge.execute({ code: 'return 1;' }, createExec()), /description/)
  assert.equal(fake.state.inputs.length, 0)
  await bridge.dispose()
})

test('rejects a non-typescript PTC runtime before any executor work', async () => {
  const definitions = new Map([['grep', createDefinition('grep')]])
  const { ctx, record } = createContext({ language: 'python' })
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'python runtime' }, createExec()),
    (error) => {
      assert.ok(error instanceof PtcProgramError)
      assert.equal(error.name, 'PtcProgramError')
      assert.equal(error.info.code, 'UNSUPPORTED_RUNTIME_LANGUAGE')
      assert.match(error.message, /typescript/)
      assert.match(error.message, /python/)
      return true
    },
  )

  // Zero executor work: no construction, no synthesized batch, no tool resolution.
  assert.equal(fake.state.constructed, 0)
  assert.equal(fake.state.inputs.length, 0)
  assert.equal(record.resolveCalls.length, 0)

  // Discovery never runs a program, so it stays available under any runtime language.
  const discovery = await bridge.discover(createExec({ toolSet: createToolSet(definitions) }))
  assert.deepEqual(discovery.tools.map((tool) => tool.name), ['grep'])
  await bridge.dispose()
})

test('accepts the released typescript function-body runtime', async () => {
  const { ctx } = createContext({ language: 'typescript', programFormat: 'function-body', retainsState: false })
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  const output = await bridge.execute({ code: 'return 1;', description: 'typescript runtime' }, createExec())

  assert.deepEqual(output, { result: { ok: true } })
  assert.equal(fake.state.inputs.length, 1)
  await bridge.dispose()
})

test('rejects every unsupported PTC program format before any executor work', async () => {
  // The reserved `args` prelude is a function body declaration; any other
  // evaluation form is unsupported regardless of how the provider spells it.
  for (const programFormat of ['repl', 'script', 'vm-script', 'persistent-in-memory']) {
    const { ctx } = createContext({ language: 'typescript', programFormat, retainsState: false })
    const fake = createFakeExecutor()
    const bridge = await createBridge(ctx, fake)

    await assert.rejects(
      bridge.execute({ code: 'return 1;', description: programFormat }, createExec()),
      (error) => {
        assert.ok(error instanceof PtcProgramError, programFormat)
        assert.equal(error.name, 'PtcProgramError', programFormat)
        assert.equal(error.info.code, 'UNSUPPORTED_RUNTIME_FORMAT', programFormat)
        assert.match(error.message, /function-body/, programFormat)
        assert.ok(error.message.includes(programFormat), programFormat)
        return true
      },
      programFormat,
    )

    assert.equal(fake.state.constructed, 0, programFormat)
    assert.equal(fake.state.inputs.length, 0, programFormat)
    await bridge.dispose()
  }
})

test('rejects a state-retaining PTC runtime before any executor work', async () => {
  const { ctx } = createContext({ language: 'typescript', programFormat: 'function-body', retainsState: true })
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'retains state' }, createExec()),
    (error) => {
      assert.ok(error instanceof PtcProgramError)
      assert.equal(error.info.code, 'UNSUPPORTED_RUNTIME_FORMAT')
      assert.match(error.message, /retain/)
      return true
    },
  )
  assert.equal(fake.state.constructed, 0)
  assert.equal(fake.state.inputs.length, 0)
  await bridge.dispose()
})

test('rejects an invalid exec.toolSet', async () => {
  const { ctx } = createContext()
  const fake = createFakeExecutor()
  const bridge = await createBridge(ctx, fake)

  await assert.rejects(
    bridge.execute({ code: 'return 1;', description: 'bad tool set' }, createExec({ toolSet: {} })),
    /ResolvedToolSet/,
  )
  await bridge.dispose()
})

test('validates bridge options', async () => {
  await assert.rejects(createPtcRuntimeBridge(null), TypeError)
  await assert.rejects(createPtcRuntimeBridge({}, null), TypeError)
  await assert.rejects(createPtcRuntimeBridge({}, { maxParallelSubCalls: 0 }), RangeError)
  await assert.rejects(createPtcRuntimeBridge({}, { maxParallelSubCalls: 1.5 }), RangeError)
  await assert.rejects(createPtcRuntimeBridge({}, { maxResultChars: 0 }), RangeError)
  await assert.rejects(createPtcRuntimeBridge({}, { discoverLimit: 0 }), RangeError)
  await assert.rejects(createPtcRuntimeBridge({}, { maxArgsChars: 0 }), RangeError)
  await assert.rejects(createPtcRuntimeBridge({}, { loadExecutorModule: 'nope' }), TypeError)
  await assert.rejects(createPtcRuntimeBridge({}, { createExecutor: 'nope' }), TypeError)
})

test('the official package still exposes the PtcExecutor execute contract', async () => {
  const official = await import(PTC_EXECUTOR_PACKAGE)

  assert.equal(typeof official.PtcExecutor, 'function')
  assert.equal(typeof official.PtcExecutor.prototype.execute, 'function')
  assert.equal(official.PtcExecutor.prototype.execute.length, 1)
  assert.equal(typeof official.PtcExecutor.prototype.describe, 'function')
})
