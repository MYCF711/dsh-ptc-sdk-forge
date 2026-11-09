/**
 * Official PTC execution bridge for the single `ptc_sdk` tool.
 *
 * This module is the only place in the plugin that talks to the official
 * `PtcExecutor`. It never installs a tool executor (`ctx.tools.setExecutor()`),
 * never registers an Agent preset, and never touches the caller's own
 * executor: it lazily constructs exactly one private `PtcExecutor` per bridge,
 * synthesizes exactly one `run_code` batch per program, and masks the plugin's
 * own tool out of the nested program bindings so a program can never recurse
 * back into `ptc_sdk`.
 *
 * The bridge is a transport only. It resolves tools from the calling Agent, the
 * current step's `ResolvedToolSet`, the caller signal and the existing approval
 * pipeline; it never widens a restriction. A call without that step admission
 * set fails closed: resolving one here would need the step's model selection,
 * which the tool run context does not carry.
 *
 * ## Supported runtime
 *
 * A program is only handed to a `typescript` runtime whose `programFormat` is
 * `function-body` and which does not retain program state. Anything else is
 * rejected with `UNSUPPORTED_RUNTIME_FORMAT` / `UNSUPPORTED_RUNTIME_LANGUAGE`
 * before any executor work, because the reserved `args` binding is a function
 * body declaration: a retained scope would redeclare it on the next run.
 *
 * ## Reserved program binding
 *
 * Every program is prefixed with `const args = JSON.parse("<canonical json>");`
 * so `args` is a reserved binding: user code must not redeclare it. The prelude
 * is produced with `JSON.stringify` alone — arguments are never concatenated
 * into source unescaped, and the JSON text is embedded as a JavaScript string
 * literal, so a value such as `"); process.exit(1); //` stays data.
 *
 * ## Canonical results
 *
 * A successful program resolves to `{ result, logs?, sandbox? }`. Every field is
 * canonical JSON: plain objects with sorted keys, dense arrays, finite numbers
 * only, no `undefined`, functions, symbols, bigints, class instances or
 * cycles, and the serialized payload is bounded by `maxResultChars`
 * ({@link PtcResultLimitError}). `sandbox` is the bounded
 * `{ mode, enforcement?, denied }` projection of the runtime's file-policy
 * descriptor, so a denial stays diagnosable without an unbounded passthrough.
 *
 * @module dsh-ptc-sdk-forge/runtime
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The single ordinary tool this plugin registers. */
export const PTC_SDK_TOOL_NAME = 'ptc_sdk'

/** Reserved PTC transport name accepted by the official executor. */
export const PTC_TRANSPORT_TOOL_NAME = 'run_code'

/** Reserved program binding receiving the validated `args` value. */
export const ARGS_BINDING_NAME = 'args'

/** Package that owns the official `PtcExecutor` public API. */
export const PTC_EXECUTOR_PACKAGE = '@deepseek-ai/dsh-tool-executor-ptc'

const DEFAULT_MAX_PARALLEL_SUB_CALLS = 10
const DEFAULT_MAX_RESULT_CHARS = 50_000
const DEFAULT_DISCOVER_LIMIT = 100
const DEFAULT_MAX_ARGS_CHARS = 200_000

/** Canonical tool-failure codes that mean "the caller aborted", not "the program failed". */
const ABORT_CODES = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH'])

const nodeRequire = createRequire(import.meta.url)

/** A program failed at runtime; `message` and `info` are preserved verbatim. */
export class PtcProgramError extends Error {
  /**
   * @param {string} message - model-facing failure text.
   * @param {unknown} [info] - structured failure identity (`{ name, code, reason? }`).
   */
  constructor(message, info) {
    super(message)
    this.name = 'PtcProgramError'
    if (info !== undefined) this.info = info
  }
}

/** The bridge was disposed; no new program or discovery may start. */
export class PtcBridgeDisposedError extends Error {
  constructor() {
    super('PTC runtime bridge was disposed')
    this.name = 'PtcBridgeDisposedError'
    this.code = 'PTC_BRIDGE_DISPOSED'
  }
}

/**
 * A canonical payload exceeded one of the bridge's size limits.
 *
 * Extends `RangeError` so a caller that already mapped `RangeError` keeps
 * working, while `code` gives the tool layer an exact identity instead of a
 * catch-all.
 */
export class PtcResultLimitError extends RangeError {
  /**
   * @param {string} message - which payload exceeded which limit.
   */
  constructor(message) {
    super(message)
    this.name = 'PtcResultLimitError'
    this.code = 'LIMIT_EXCEEDED'
  }
}

/**
 * Create the PTC execution bridge for one plugin instance.
 *
 * The returned object exposes `discover`, `execute` and `dispose`. Exactly one
 * `PtcExecutor` is constructed per bridge, on first use, so the executor's
 * `PtcCalls` listeners are installed once instead of accumulating per call.
 *
 * @param {object} ctx - the plugin Context (needs `ctx.tools`, and `ctx.loader`/`ctx.baseUrl` for the host loading channel).
 * @param {object} [options] - bridge limits and test seams.
 * @param {number} [options.maxParallelSubCalls=10] - program subcall concurrency.
 * @param {number} [options.maxResultChars=50000] - canonical JSON cap for a program result, one discover schema, and the whole discover result.
 * @param {number} [options.discoverLimit=100] - maximum listed tools and maximum requested `toolNames` entries.
 * @param {number} [options.maxArgsChars=200000] - canonical JSON cap for the injected `args` value.
 * @param {(ctx: object) => Promise<object>} [options.loadExecutorModule] - host module loader; defaults to `ctx.loader.internal.import(...)` with a `createRequire`/`import` fallback.
 * @param {(ctx: object, config: { maxParallelSubCalls: number }, module: object) => object} [options.createExecutor] - executor factory; defaults to `new module.PtcExecutor(ctx, config)`.
 * @returns {Promise<{
 *   discover: (exec: object, toolNames?: readonly string[]) => Promise<{ tools: object[], missing?: string[], truncated?: boolean }>,
 *   execute: (request: { code: string, description: string, args?: unknown }, exec: object) => Promise<{ result?: unknown, logs?: string[], sandbox?: { mode: string, enforcement?: string, denied: boolean } }>,
 *   dispose: () => Promise<void>,
 *   readonly disposed: boolean,
 * }>}
 */
export async function createPtcRuntimeBridge(ctx, options = {}) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('createPtcRuntimeBridge requires the plugin Context')
  }
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createPtcRuntimeBridge options must be an object')
  }

  const maxParallelSubCalls = readPositiveInteger(options.maxParallelSubCalls, DEFAULT_MAX_PARALLEL_SUB_CALLS, 'maxParallelSubCalls')
  const maxResultChars = readPositiveInteger(options.maxResultChars, DEFAULT_MAX_RESULT_CHARS, 'maxResultChars')
  const discoverLimit = readPositiveInteger(options.discoverLimit, DEFAULT_DISCOVER_LIMIT, 'discoverLimit')
  const maxArgsChars = readPositiveInteger(options.maxArgsChars, DEFAULT_MAX_ARGS_CHARS, 'maxArgsChars')
  const loadExecutorModule = readOptionalFunction(options.loadExecutorModule, 'loadExecutorModule') ?? loadOfficialExecutorModule
  const createExecutor = readOptionalFunction(options.createExecutor, 'createExecutor') ?? defaultCreateExecutor

  /** Fused with every caller signal; aborted exactly once by `dispose()`. */
  const controller = new AbortController()
  /** Every started discovery/execution promise, settled at most once and awaited by `dispose()`. */
  const active = new Set()
  let disposed = false
  let disposePromise
  let executorPromise

  function assertUsable() {
    if (disposed) throw new PtcBridgeDisposedError()
  }

  /**
   * Construct the single private executor, sharing one construction across
   * concurrent callers and retrying after a failed load.
   * @returns {Promise<object>} the official `PtcExecutor` instance.
   */
  function executorForUse() {
    executorPromise ??= (async () => {
      const loaded = await loadExecutorModule(ctx)
      // A dispose that raced the module load must not leave a live executor behind.
      assertUsable()
      return assertExecutor(createExecutor(ctx, { maxParallelSubCalls }, loaded))
    })().catch((error) => {
      executorPromise = undefined
      throw error
    })
    return executorPromise
  }

  /**
   * Start one program and track it until it settles.
   * @param {{ code: string, description: string, args?: unknown }} request - unsaved or stored program.
   * @param {object} exec - the outer tool run context.
   * @returns {Promise<{ result?: unknown, logs?: string[], sandbox?: object }>} canonical program output.
   */
  function execute(request, exec) {
    return start(() => runProgram(request, exec))
  }

  /**
   * List the calling Agent's ordinary tool schemas, masked against self-recursion.
   * @param {object} exec - the outer tool run context.
   * @param {readonly string[]} [toolNames] - full schemas to return; omitted lists names and descriptions.
   * @returns {Promise<{ tools: object[], missing?: string[], truncated?: boolean }>} plain JSON schemas.
   */
  function discover(exec, toolNames) {
    return start(() => runDiscover(exec, toolNames))
  }

  /**
   * Abort in-flight work and wait until every started call settles. Idempotent:
   * repeated calls return the same promise and never throw.
   * @returns {Promise<void>} settlement of every program and discovery started before the call.
   */
  function dispose() {
    disposePromise ??= (async () => {
      disposed = true
      controller.abort(new PtcBridgeDisposedError())
      while (active.size > 0) await Promise.allSettled([...active])
    })()
    return disposePromise
  }

  /**
   * Reject a disposed call; otherwise start and track it so `dispose()` can
   * await its settlement.
   * @param {() => Promise<unknown>} run - started work.
   * @returns {Promise<unknown>} the started work.
   */
  function start(run) {
    if (disposed) return Promise.reject(new PtcBridgeDisposedError())
    const task = run()
    track(task)
    return task
  }

  /**
   * Keep a started promise observable for `dispose()` without creating an
   * unhandled rejection when the caller awaits it itself.
   * @param {Promise<unknown>} task - started work.
   */
  function track(task) {
    active.add(task)
    task.then(() => active.delete(task), () => active.delete(task))
  }

  async function runProgram(request, exec) {
    assertSupportedRuntime(ctx)
    const { code, description, args } = normalizeProgramRequest(request)
    const agent = requireAgent(exec, 'test/run')
    const callerSignal = requireSignal(exec)
    const toolSet = requireToolSet(exec)
    const signal = AbortSignal.any([callerSignal, controller.signal])
    signal.throwIfAborted()

    const program = buildProgramSource(code, args, maxArgsChars)
    const executor = await executorForUse()
    const maskedToolSet = maskToolSet(toolSet, PTC_SDK_TOOL_NAME)
    signal.throwIfAborted()
    // One synthesized batch, no `log`: the outer `ptc_sdk` result owns history,
    // not the nested transport call.
    const batch = await executor.execute({
      calls: [{
        type: 'tool-call',
        id: exec.callId,
        name: PTC_TRANSPORT_TOOL_NAME,
        arguments: JSON.stringify({ code: program, description }),
      }],
      signal,
      agent,
      toolSet: maskedToolSet,
    })
    return settleBatch(batch, exec, maxResultChars)
  }

  async function runDiscover(exec, toolNames) {
    const agent = requireAgent(exec, 'discover')
    const signal = requireSignal(exec)
    const toolSet = requireToolSet(exec)
    const names = normalizeToolNames(toolNames, discoverLimit)
    signal.throwIfAborted()

    const tools = ctx.tools
    if (tools === null || typeof tools !== 'object' || typeof tools.schemas !== 'function') {
      throw new TypeError('ptc_sdk discover requires ctx.tools.schemas() to project the calling Agent tool schemas')
    }

    const maskedToolSet = maskToolSet(toolSet, PTC_SDK_TOOL_NAME)
    const schemas = tools.schemas(agent, maskedToolSet)
    if (!Array.isArray(schemas)) {
      throw new TypeError('ctx.tools.schemas() must return an array of tool schemas')
    }
    const visible = []
    for (const schema of schemas) {
      if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string' || schema.name.length === 0) {
        throw new TypeError('ctx.tools.schemas() returned an entry without a tool name')
      }
      if (schema.name === PTC_SDK_TOOL_NAME) continue
      visible.push(schema)
    }

    let result
    if (names === undefined) {
      const capped = visible.slice(0, discoverLimit)
      result = {
        tools: capped.map((schema) => summarizeSchema(schema, maxResultChars)),
        ...(visible.length > capped.length ? { truncated: true } : {}),
      }
    } else {
      const byName = new Map(visible.map((schema) => [schema.name, schema]))
      const selected = []
      const missing = []
      for (const name of names) {
        const schema = byName.get(name)
        if (schema === undefined) {
          missing.push(name)
          continue
        }
        selected.push(canonicalizeJson(schema, `tool schema "${name}"`, maxResultChars).value)
      }
      result = {
        tools: selected,
        ...(missing.length > 0 ? { missing } : {}),
      }
    }
    // The complete answer is bounded too: per-entry caps alone would still let a
    // long list exceed the transport budget.
    return canonicalizeJson(result, 'ptc_sdk discover result', maxResultChars).value
  }

  /**
   * Require the step's admitted tool set.
   *
   * Resolving one here would need the step's model selection, which the tool run
   * context does not carry; admitting unconditionally would let a conditional
   * tool through with an undefined model selection. Fail closed instead.
   * @param {object} exec - the outer tool run context.
   * @returns {object} the caller's `ResolvedToolSet`.
   */
  function requireToolSet(exec) {
    const toolSet = exec.toolSet
    if (toolSet === undefined) {
      throw new TypeError('ptc_sdk requires the step tool set (exec.toolSet); resolving one here would need the step model selection, so the bridge fails closed instead of admitting every conditional tool')
    }
    return assertToolSet(toolSet, 'exec.toolSet')
  }

  return Object.freeze({
    discover,
    execute,
    dispose,
    /** Whether `dispose()` has been called. */
    get disposed() {
      return disposed
    },
  })
}

/**
 * Reject a program run whose mounted PTC runtime cannot execute the TypeScript
 * function-body flavor this plugin emits.
 *
 * The reserved `args` prelude is `const args = ...`, which is only valid
 * TypeScript program source; handing it to a Python runtime would surface as an
 * opaque syntax error. Discovery, validation, save, list and archive never run a
 * program, so they stay available under any runtime.
 *
 * The prelude is also a function-body declaration, so the mount must report the
 * `function-body` program format and must not retain program state: a retained
 * scope would redeclare `args` on the next run.
 *
 * @param {object} pluginCtx - the plugin Context.
 * @throws {PtcProgramError} `UNSUPPORTED_RUNTIME_LANGUAGE` for a non-TypeScript mounted runtime.
 * @throws {PtcProgramError} `UNSUPPORTED_RUNTIME_FORMAT` for a runtime that is not a stateless function body.
 */
function assertSupportedRuntime(pluginCtx) {
  const runtime = pluginCtx?.ptcRuntime
  if (runtime === undefined || runtime === null) return
  const { language, programFormat, retainsState } = runtime
  if (language !== undefined && language !== 'typescript') {
    throw new PtcProgramError(
      `ptc_sdk test/run only supports the "typescript" PTC program flavor; the mounted runtime language is "${String(language)}"`,
      { name: 'UnsupportedRuntimeLanguageError', code: 'UNSUPPORTED_RUNTIME_LANGUAGE' },
    )
  }
  if (programFormat !== 'function-body' || retainsState === true) {
    throw new PtcProgramError(
      `ptc_sdk test/run only supports a "function-body" program format that does not retain state; the mounted runtime reports programFormat "${String(programFormat)}" and retainsState ${String(retainsState)}`,
      { name: 'UnsupportedRuntimeFormatError', code: 'UNSUPPORTED_RUNTIME_FORMAT' },
    )
  }
}

/**
 * Turn one settled batch into canonical program output.
 * @param {object} batch - the executor's `ToolBatchResult`.
 * @param {object} exec - the outer tool run context.
 * @param {number} maxResultChars - canonical JSON cap.
 * @returns {{ result?: unknown, logs?: string[], sandbox?: object }} canonical `{ result, logs?, sandbox? }`.
 */
function settleBatch(batch, exec, maxResultChars) {
  if (batch === null || typeof batch !== 'object') {
    throw new TypeError('PtcExecutor.execute must resolve a ToolBatchResult')
  }
  const contexts = batch.additionalContexts ?? []
  if (!Array.isArray(contexts)) {
    throw new TypeError('ToolBatchResult.additionalContexts must be an array')
  }
  for (const context of contexts) {
    if (typeof exec.deferContext !== 'function') {
      throw new TypeError('ptc_sdk requires the tool run context (exec.deferContext) to ferry nested context')
    }
    exec.deferContext(context)
  }
  if (batch.concluded === true) {
    if (typeof exec.concludeTurn !== 'function') {
      throw new TypeError('ptc_sdk requires the tool run context (exec.concludeTurn) to forward a concluded turn')
    }
    exec.concludeTurn()
  }

  const outcome = Array.isArray(batch.results) ? batch.results[0]?.result : undefined
  if (outcome === null || typeof outcome !== 'object') {
    throw new Error('PtcExecutor.execute resolved no ToolExecutionResult for the run_code call')
  }
  if (outcome.isError === true) throw programError(outcome)

  return projectProgramOutput(outcome.value, maxResultChars)
}

/**
 * Build the tool failure from the executor's canonical error, keeping message
 * and structured info intact.
 * @param {object} outcome - a `ToolExecutionFailure`.
 * @returns {PtcProgramError} the failure to reject with.
 */
function programError(outcome) {
  const failure = outcome.error
  const message = typeof failure?.message === 'string' && failure.message.length > 0
    ? failure.message
    : 'PTC program failed'
  const info = failure?.info
  const error = new PtcProgramError(message, info)
  // Cancellation keeps its own identity instead of masquerading as a program bug.
  if (info !== null && typeof info === 'object' && ABORT_CODES.has(info.code)) {
    error.name = 'AbortError'
  }
  return error
}

/**
 * Project the `run_code` transport value (`{ logs, sandbox?, result? }`) onto
 * the plugin's canonical `{ result, logs?, sandbox? }` output.
 * @param {unknown} value - the transport's canonical value.
 * @param {number} maxResultChars - canonical JSON cap.
 * @returns {{ result?: unknown, logs?: string[], sandbox?: object }} canonical output.
 */
function projectProgramOutput(value, maxResultChars) {
  const payload = {}
  const transport = value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.hasOwn(value, 'logs') || Object.hasOwn(value, 'result'))
  if (transport) {
    if (value.result !== undefined) payload.result = value.result
    if (value.sandbox !== undefined) payload.sandbox = projectSandbox(value.sandbox)
    const logs = normalizeLogs(value.logs)
    if (logs.length > 0) payload.logs = logs
  } else if (value !== undefined) {
    // Defensive: an executor that hands back the program value directly.
    payload.result = value
  }
  return canonicalizeJson(payload, 'PTC program result', maxResultChars).value
}

/**
 * Bound the runtime's file-sandbox descriptor to its documented fields so a
 * denial stays diagnosable without an unbounded passthrough.
 * @param {unknown} sandbox - the runtime's `PtcRunSandbox`.
 * @returns {{ mode: string, enforcement?: string, denied: boolean }} bounded descriptor.
 */
function projectSandbox(sandbox) {
  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    throw new TypeError('the run_code result `sandbox` must be an object')
  }
  const { mode, enforcement, denied } = sandbox
  if (typeof mode !== 'string' || mode.length === 0) {
    throw new TypeError('the run_code result `sandbox.mode` must be a non-empty string')
  }
  if (typeof denied !== 'boolean') {
    throw new TypeError('the run_code result `sandbox.denied` must be a boolean')
  }
  if (enforcement !== undefined && typeof enforcement !== 'string') {
    throw new TypeError('the run_code result `sandbox.enforcement` must be a string when present')
  }
  return { mode, ...(enforcement === undefined ? {} : { enforcement }), denied }
}

/**
 * Require the transport's `logs` to be an array of strings.
 * @param {unknown} logs - transport logs.
 * @returns {string[]} the same entries, validated.
 */
function normalizeLogs(logs) {
  if (logs === undefined) return []
  if (!Array.isArray(logs)) {
    throw new TypeError('the run_code result `logs` must be an array of strings')
  }
  const normalized = new Array(logs.length)
  for (let index = 0; index < logs.length; index += 1) {
    if (typeof logs[index] !== 'string') {
      throw new TypeError(`the run_code result \`logs[${index}]\` must be a string`)
    }
    normalized[index] = logs[index]
  }
  return normalized
}

/**
 * Prefix the program with the reserved `args` binding.
 * @param {string} code - caller-authored program body.
 * @param {unknown} args - validated program arguments; omitted means `{}`.
 * @param {number} maxArgsChars - canonical JSON cap for `args`.
 * @returns {string} the complete program handed to `run_code`.
 */
function buildProgramSource(code, args, maxArgsChars) {
  const { text } = canonicalizeJson(args === undefined ? {} : args, 'PTC program args', maxArgsChars)
  // `JSON.parse(<string literal>)`: the value never becomes source, and no key
  // (`__proto__` included) is interpreted as object-literal syntax.
  return `const ${ARGS_BINDING_NAME} = JSON.parse(${JSON.stringify(text)});\n${code}`
}

/**
 * Mask one tool out of every nested binding while implementing only the public
 * `ResolvedToolSet` surface. The caller's set is never mutated.
 *
 * `dispose` is a deliberate no-op: the facade does not own the caller's set, so
 * the nested transport must not be able to close it. It exists only so the
 * object keeps the admitted-set shape.
 *
 * @param {object} toolSet - the caller's `ResolvedToolSet`.
 * @param {string} hiddenName - tool name to hide (the plugin's own).
 * @returns {Readonly<{ view: (scope: unknown) => ReadonlyMap<string, object>, dispose: () => void }>} the facade.
 */
function maskToolSet(toolSet, hiddenName) {
  return Object.freeze({
    view(scope) {
      const visible = toolSet.view(scope)
      if (visible === null || typeof visible !== 'object' || typeof visible.has !== 'function') {
        throw new TypeError('ResolvedToolSet.view(scope) must return a ReadonlyMap of tool definitions')
      }
      if (!visible.has(hiddenName)) return visible
      const masked = new Map(visible)
      masked.delete(hiddenName)
      return masked
    },
    /** No-op: this facade never owns the caller's set. */
    dispose() {},
  })
}

/**
 * Project one visible tool onto its allowlisted, canonical model-facing schema.
 * @param {object} schema - a deep-cloned `ToolSchema`.
 * @param {number} maxResultChars - canonical JSON cap.
 * @returns {object} `{ name, description? }`.
 */
function summarizeSchema(schema, maxResultChars) {
  const summary = { name: schema.name }
  if (typeof schema.description === 'string') summary.description = schema.description
  return canonicalizeJson(summary, `tool summary "${schema.name}"`, maxResultChars).value
}

/**
 * Canonicalize one JSON value: sorted object keys, dense arrays, finite numbers
 * only, plain objects only.
 * @param {unknown} value - candidate value.
 * @param {string} label - diagnostic label for the value root.
 * @param {number} maxChars - serialized character cap.
 * @returns {{ value: unknown, text: string, chars: number }} the canonical value and its text.
 * @throws {TypeError} when the value cannot be canonical JSON.
 * @throws {PtcResultLimitError} when the serialized value exceeds `maxChars`.
 */
function canonicalizeJson(value, label, maxChars) {
  const ancestors = new Set()

  const walk = (current, path) => {
    if (current === null) return null
    switch (typeof current) {
      case 'string':
      case 'boolean':
        return current
      case 'number':
        if (!Number.isFinite(current)) {
          throw new TypeError(`${label}${path} is ${String(current)}; canonical JSON requires a finite number`)
        }
        return Object.is(current, -0) ? 0 : current
      case 'bigint':
        throw new TypeError(`${label}${path} is a bigint; canonical JSON cannot express it (convert it to a string or number first)`)
      case 'undefined':
        throw new TypeError(`${label}${path} is undefined; canonical JSON cannot express it (use null instead)`)
      case 'function':
      case 'symbol':
        throw new TypeError(`${label}${path} is a ${typeof current}; canonical JSON cannot express it`)
      default:
        break
    }

    if (ancestors.has(current)) {
      throw new TypeError(`${label}${path} is a circular reference; canonical JSON must be a tree`)
    }
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const result = new Array(current.length)
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) {
            throw new TypeError(`${label}${path}[${index}] is a hole; canonical JSON arrays must be dense`)
          }
          result[index] = walk(current[index], `${path}[${index}]`)
        }
        return result
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        const instance = prototype?.constructor?.name
        throw new TypeError(`${label}${path} is a ${typeof instance === 'string' ? instance : 'non-plain'} instance; canonical JSON only accepts plain objects and arrays`)
      }
      const result = {}
      for (const key of Object.keys(current).sort()) {
        // defineProperty keeps a `__proto__` key as data instead of a prototype.
        Object.defineProperty(result, key, {
          value: walk(current[key], `${path}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return result
    } finally {
      ancestors.delete(current)
    }
  }

  const canonical = walk(value, '')
  const text = JSON.stringify(canonical)
  if (text.length > maxChars) {
    throw new PtcResultLimitError(`${label} is ${text.length} characters of canonical JSON; the limit is ${maxChars}`)
  }
  return { value: canonical, text, chars: text.length }
}

/**
 * Normalize one `{ code, description, args? }` program request.
 * @param {unknown} request - raw request.
 * @returns {{ code: string, description: string, args: unknown }} validated request.
 */
function normalizeProgramRequest(request) {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('execute requires a { code, description, args? } request')
  }
  const { code, description, args } = request
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new TypeError('execute requires a non-empty `code` string')
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new TypeError('execute requires a non-empty `description` string')
  }
  return { code, description, args }
}

/**
 * Normalize an optional discover filter.
 * @param {unknown} toolNames - requested names, or undefined for the summary listing.
 * @param {number} limit - maximum requested names.
 * @returns {string[] | undefined} deduplicated names.
 */
function normalizeToolNames(toolNames, limit) {
  if (toolNames === undefined) return undefined
  if (!Array.isArray(toolNames)) {
    throw new TypeError('discover `toolNames` must be an array of tool names')
  }
  if (toolNames.length > limit) {
    throw new PtcResultLimitError(`discover accepts at most ${limit} tool names; received ${toolNames.length}`)
  }
  const names = []
  const seen = new Set()
  for (const name of toolNames) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('discover tool names must be non-empty strings')
    }
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Require the calling Agent; programs and discovery are scoped to it.
 * @param {unknown} exec - the outer tool run context.
 * @param {string} action - action used in the diagnostic.
 * @returns {object} the calling Agent.
 */
function requireAgent(exec, action) {
  if (exec === null || typeof exec !== 'object') {
    throw new TypeError(`ptc_sdk ${action} requires the tool run context (exec)`)
  }
  const agent = exec.agent
  if (agent === undefined || agent === null) {
    throw new TypeError(`ptc_sdk ${action} requires the calling Agent (exec.agent); programs and discovery are scoped to their caller`)
  }
  return agent
}

/**
 * Require the caller cancellation signal.
 * @param {object} exec - the outer tool run context.
 * @returns {AbortSignal} the caller signal.
 */
function requireSignal(exec) {
  const signal = exec.signal
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('ptc_sdk requires the caller AbortSignal (exec.signal)')
  }
  return signal
}

/**
 * Require a step admission set.
 * @param {unknown} toolSet - candidate set.
 * @param {string} label - diagnostic label.
 * @returns {object} the same set.
 */
function assertToolSet(toolSet, label) {
  if (toolSet === null || typeof toolSet !== 'object' || typeof toolSet.view !== 'function') {
    throw new TypeError(`${label} must be a ResolvedToolSet exposing view(scope)`)
  }
  return toolSet
}

/**
 * Require the constructed executor's public surface.
 * @param {unknown} executor - factory result.
 * @returns {object} the same executor.
 */
function assertExecutor(executor) {
  const callable = (typeof executor === 'object' && executor !== null) || typeof executor === 'function'
  if (!callable || typeof executor.execute !== 'function') {
    throw new TypeError('PtcExecutor must expose an execute(batch) method')
  }
  return executor
}

/**
 * Read a positive-integer option.
 * @param {unknown} value - raw option.
 * @param {number} fallback - default when omitted.
 * @param {string} name - option name for diagnostics.
 * @returns {number} the validated value.
 */
function readPositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`options.${name} must be a positive integer`)
  }
  return value
}

/**
 * Read an optional function option.
 * @param {unknown} value - raw option.
 * @param {string} name - option name for diagnostics.
 * @returns {Function | undefined} the function, when provided.
 */
function readOptionalFunction(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'function') throw new TypeError(`options.${name} must be a function`)
  return value
}

/**
 * Load the official executor module through the host loading channel, falling
 * back to `createRequire`/`import` outside a Cordis loader.
 * @param {object} pluginCtx - the plugin Context.
 * @returns {Promise<object>} the module namespace.
 */
async function loadOfficialExecutorModule(pluginCtx) {
  const internal = pluginCtx?.loader?.internal
  if (internal !== undefined && internal !== null && typeof internal.import === 'function') {
    return await internal.import(PTC_EXECUTOR_PACKAGE, pluginCtx.baseUrl ?? import.meta.url, {})
  }
  return await importOfficialExecutorFallback()
}

/**
 * Resolve the package from this module's own location.
 * @returns {Promise<object>} the module namespace.
 */
async function importOfficialExecutorFallback() {
  try {
    return await import(PTC_EXECUTOR_PACKAGE)
  } catch (error) {
    let resolved
    try {
      resolved = nodeRequire.resolve(PTC_EXECUTOR_PACKAGE)
    } catch {
      throw error
    }
    return await import(pathToFileURL(resolved).href)
  }
}

/**
 * Construct the official executor from a loaded module namespace.
 * @param {object} pluginCtx - the plugin Context.
 * @param {{ maxParallelSubCalls: number }} config - executor configuration.
 * @param {object} loaded - the module namespace.
 * @returns {object} the executor instance.
 */
function defaultCreateExecutor(pluginCtx, config, loaded) {
  const PtcExecutor = resolveExecutorConstructor(loaded)
  return new PtcExecutor(pluginCtx, config)
}

/**
 * Accept the documented `PtcExecutor` export of the official package.
 * @param {unknown} loaded - the module namespace.
 * @returns {Function} the constructor.
 */
function resolveExecutorConstructor(loaded) {
  if (typeof loaded === 'function') return loaded
  if (typeof loaded?.PtcExecutor === 'function') return loaded.PtcExecutor
  if (typeof loaded?.default === 'function') return loaded.default
  if (typeof loaded?.default?.PtcExecutor === 'function') return loaded.default.PtcExecutor
  throw new TypeError(`the ${PTC_EXECUTOR_PACKAGE} module does not export a PtcExecutor constructor`)
}
