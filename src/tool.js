/**
 * The single ordinary `ptc_sdk` tool.
 *
 * The outer surface is deliberately one fixed tool: saving a program never
 * registers another tool, so the model-facing tool list, system prompt and
 * prefix cache stay stable no matter how many artifacts the library holds.
 * Program source is only ever executed by the official PTC runtime injected as
 * `runtime`; this module owns no execution and no filesystem access of its own.
 *
 * The tool is a pure dispatcher over five collaborators:
 *
 * - `defineTool` (from `@deepseek-ai/dsh-tools`) builds the ordinary
 *   `ToolDefinition` and enforces the closed action vocabulary.
 * - `validate` performs static definition/argument checks and never runs code.
 * - `store` owns the versioned artifact library and its concurrency control.
 * - `runtime` executes a program through the official PTC executor using the
 *   caller's Agent, step tool set, signal and permission pipeline.
 *
 * Every successful call returns canonical JSON `{ ok: true, action, ... }`.
 * Predictable failures (invalid arguments, validation violations, revision
 * conflicts, missing artifacts, archived artifacts, program failures) return
 * `{ ok: false, action, error: { code, message }, violations? }`; anything
 * unexpected is re-thrown instead of being reported as a fake success.
 *
 * @module dsh-ptc-sdk-forge/tool
 */

import { PtcBridgeDisposedError, PtcProgramError, PtcResultLimitError } from './runtime.js'
import { ProgramStoreError, selectVersion } from './store.js'
import { validateProgramArgs, validateProgramDefinition } from './validate.js'

/** Model-facing tool name; the tool surface never grows with saved artifacts. */
export const TOOL_NAME = 'ptc_sdk'

/** Closed action vocabulary, in contract order. */
export const ACTIONS = Object.freeze([
  'discover',
  'validate',
  'test',
  'save',
  'list',
  'get',
  'run',
  'archive',
])

const ACTION_SET = new Set(ACTIONS)

/** Every top-level argument the tool accepts; any other key is a caller typo. */
const ARGUMENT_FIELDS = new Set([
  'action',
  'name',
  'description',
  'parameters',
  'code',
  'changeNote',
  'requiredTools',
  'expectedRevision',
  'revision',
  'args',
  'toolNames',
  'includeArchived',
  'limit',
])

/** Fields each action requires before it may produce any effect. */
const REQUIRED_ARGUMENTS = Object.freeze({
  discover: Object.freeze([]),
  validate: Object.freeze(['name', 'description', 'parameters', 'code']),
  test: Object.freeze(['code']),
  save: Object.freeze(['name', 'description', 'parameters', 'code']),
  list: Object.freeze([]),
  get: Object.freeze(['name']),
  run: Object.freeze(['name']),
  archive: Object.freeze(['name']),
})

/** Synthesized identity for an unsaved `test` program. */
const UNSAVED_PROGRAM_NAME = 'unsaved-program'

/** Synthesized description for an unsaved `test` program. */
const UNSAVED_PROGRAM_DESCRIPTION = 'Unsaved PTC program executed by the test action.'

/** Synthesized argument schema for an unsaved `test` program. */
const UNSAVED_PROGRAM_PARAMETERS = Object.freeze({ type: 'object' })

/**
 * Model-facing parameter schema.
 *
 * The root is the implicit open object every tool parameter map compiles to, so
 * the host validates the primitive types and the `action` enum before `execute`
 * runs. Per-action requiredness stays in {@link REQUIRED_ARGUMENTS}: one flat
 * schema cannot express "required only for this action", and the tool reports
 * it as a structured violation instead of a host-level argument error.
 */
const PARAMETERS = Object.freeze({
  action: {
    type: 'string',
    enum: ACTIONS,
    required: true,
    description: 'Operation to perform.',
  },
  name: {
    type: 'string',
    description: 'Stable artifact identity matching ^[a-z][a-z0-9-]{0,63}$ (required by validate/save/get/run/archive).',
  },
  description: {
    type: 'string',
    description: 'Short human description of the program (required by validate/save).',
  },
  parameters: {
    type: 'json',
    description: 'Object-rooted JSON Schema (type "object") that run arguments are validated against (required by validate/save).',
  },
  code: {
    type: 'string',
    description: 'Program source, an async function body (required by validate/test/save).',
  },
  changeNote: {
    type: 'string',
    description: 'Short note describing why this revision exists (save only).',
  },
  requiredTools: {
    type: 'array',
    items: { type: 'string' },
    description: 'Tool names the program expects to call; visibility is reported as a warning, never as a grant.',
  },
  expectedRevision: {
    type: 'integer',
    description: 'Latest revision the caller observed; save appends only when it matches (save only).',
  },
  revision: {
    type: 'integer',
    description: 'Positive revision to read or run; omitted means the latest (get/run only).',
  },
  args: {
    type: 'json',
    description: 'Run arguments validated against the selected revision parameter schema (test/run only).',
  },
  toolNames: {
    type: 'array',
    items: { type: 'string' },
    description: 'Return the full schema of these tools instead of the summary list (discover only).',
  },
  includeArchived: {
    type: 'boolean',
    description: 'Include archived artifacts in the listing (list only, default false).',
  },
  limit: {
    type: 'integer',
    description: 'Maximum number of summaries to return (list only).',
  },
})

/**
 * Canonical output schema.
 *
 * Success and failure share the `{ ok, action }` envelope; `error` and
 * `violations` are present only on failure. The enforced JSON Schema subset the
 * host validates with cannot express a conditional `required`, so the two
 * shapes are declared as one open object instead of an exact-one union; the
 * dispatcher is the single place that ever builds them.
 */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
        details: { type: 'json' },
      },
      additionalProperties: true,
    },
    violations: { type: 'array', items: { type: 'string' } },
    sandbox: {
      type: 'object',
      properties: {
        mode: { type: 'string', required: true },
        enforcement: { type: 'string' },
        denied: { type: 'boolean', required: true },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
})

/** Model-facing description of the tool and its real side effects. */
const TOOL_DESCRIPTION = [
  'Create, validate, version and run programmatic SDKs whose inner runtime is the official PTC executor.',
  '',
  'The program source is an async function body. Inside it, `args` is the validated run arguments value and `tools` exposes the ordinary host tools visible to the calling Agent: a program may `await tools.read({ ... })`, run `Promise.all([...])`, branch, loop and aggregate, then `return` a small canonical JSON result. `parameters` is the object-rooted JSON Schema those `args` are validated against before anything executes.',
  '',
  'Actions: `discover` lists the caller-visible tools, or returns the full schema of `toolNames`; `validate` performs static checks only; `test` runs unsaved source without writing; `save` creates revision 1 or appends with `expectedRevision`; `list` returns summaries without source; `get` returns one artifact summary plus the selected revision; `run` executes a saved revision with validated `args`; `archive` hides the artifact from `list` and from `run` while every revision is kept.',
  '',
  '`validate` and `save` never execute code; `test` and `run` really do. Programs call tools through the PTC runtime, so nested calls behave like tool calls made by the Agent itself: they can read files, write files and reach any other side-effecting tool. This is not a sandbox dry run. Archived artifacts are not run. Do not put tokens, cookies, private keys or environment snapshots into `code` or `args`.',
].join('\n')

/**
 * Build the ordinary `ptc_sdk` tool definition.
 *
 * @param {object} dependencies - the collaborators the host and plugin install.
 * @param {(options: object) => object} dependencies.defineTool - `defineTool` from `@deepseek-ai/dsh-tools`.
 * @param {object} dependencies.store - artifact library with `list`, `get`, `save` and `archive`.
 * @param {object} dependencies.runtime - PTC bridge with `discover(exec, toolNames?)` and `execute(request, exec)`.
 * @returns {object} a registry-ready ordinary `ToolDefinition` named {@link TOOL_NAME}.
 */
export function createPtcSdkTool(dependencies) {
  const { defineTool, store, runtime } = requireDependencies(dependencies)

  return defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderCanonical,
    },
    async execute(args, exec) {
      return dispatch(args, exec, { store, runtime })
    },
  })
}

/**
 * Validate the injected collaborators once, so a misassembled plugin fails at
 * construction instead of on the first model call.
 * @param {unknown} dependencies - raw `createPtcSdkTool` input.
 * @returns {{ defineTool: Function, store: object, runtime: object }} the validated collaborators.
 */
function requireDependencies(dependencies) {
  if (!isPlainObject(dependencies)) {
    throw new TypeError('createPtcSdkTool requires { defineTool, store, runtime }')
  }
  const { defineTool, store, runtime } = dependencies
  if (typeof defineTool !== 'function') {
    throw new TypeError('createPtcSdkTool requires defineTool from @deepseek-ai/dsh-tools')
  }
  for (const method of ['list', 'get', 'save', 'archive']) {
    if (!isPlainObject(store) || typeof store[method] !== 'function') {
      throw new TypeError(`createPtcSdkTool requires store.${method}()`)
    }
  }
  for (const method of ['discover', 'execute']) {
    if (!isPlainObject(runtime) || typeof runtime[method] !== 'function') {
      throw new TypeError(`createPtcSdkTool requires runtime.${method}()`)
    }
  }
  return { defineTool, store, runtime }
}

/**
 * Route one accepted call to its action.
 *
 * Argument shape is checked before any collaborator runs, so a missing or
 * unknown field can never produce a partial effect.
 *
 * @param {unknown} args - model arguments (already type-checked by `defineTool`).
 * @param {object} exec - the outer tool run context (Agent, signal, tool set).
 * @param {{ store: object, runtime: object }} collaborators - validated dependencies.
 * @returns {Promise<object>} canonical success or expected-failure value.
 */
async function dispatch(args, exec, collaborators) {
  if (!isPlainObject(args)) {
    return failure('unknown', 'INVALID_ARGUMENT', 'ptc_sdk arguments must be a JSON object')
  }
  const action = args.action
  if (typeof action !== 'string' || !ACTION_SET.has(action)) {
    const label = typeof action === 'string' ? action : 'unknown'
    return failure(label, 'INVALID_ACTION', `unknown action ${describeValue(action)}; expected one of ${ACTIONS.join(', ')}`)
  }

  const violations = checkArguments(action, args)
  if (violations.length > 0) {
    return failure(action, 'INVALID_ARGUMENT', `invalid arguments for action "${action}"`, violations)
  }

  try {
    return await HANDLERS[action](args, exec, collaborators)
  } catch (error) {
    const expected = expectedFailure(action, error)
    if (expected !== null) return expected
    // Unknown failures keep their stack and identity: never a fake success.
    throw error
  }
}

/**
 * Check unknown fields, per-action required fields and primitive field shapes.
 * @param {string} action - accepted action.
 * @param {object} args - raw arguments.
 * @returns {string[]} path-qualified violations; empty means valid.
 */
function checkArguments(action, args) {
  const violations = []

  for (const key of Object.keys(args)) {
    if (!ARGUMENT_FIELDS.has(key)) violations.push(`unknown argument ${JSON.stringify(key)}`)
  }

  for (const field of REQUIRED_ARGUMENTS[action]) {
    if (args[field] === undefined) violations.push(`missing required argument ${JSON.stringify(field)}`)
  }

  for (const field of ['name', 'description', 'code', 'changeNote']) {
    if (args[field] !== undefined && typeof args[field] !== 'string') {
      violations.push(`${field}: must be a string`)
    }
  }
  for (const field of ['revision', 'expectedRevision', 'limit']) {
    if (args[field] !== undefined && !isPositiveInteger(args[field])) {
      violations.push(`${field}: must be a positive integer`)
    }
  }
  for (const field of ['requiredTools', 'toolNames']) {
    if (args[field] !== undefined && !isStringArray(args[field])) {
      violations.push(`${field}: must be an array of strings`)
    }
  }
  if (args.includeArchived !== undefined && typeof args.includeArchived !== 'boolean') {
    violations.push('includeArchived: must be a boolean')
  }

  return violations
}

/* ------------------------------------------------------------------ actions */

/**
 * List the caller-visible tools, or return the full schema of `toolNames`.
 * Read-only: no artifact is written and no program runs.
 * @param {object} args - validated arguments.
 * @param {object} exec - tool run context.
 * @param {{ runtime: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical discovery result.
 */
async function runDiscover(args, exec, { runtime }) {
  const discovery = await runtime.discover(exec, args.toolNames)
  if (!isPlainObject(discovery) || !Array.isArray(discovery.tools)) {
    throw new TypeError('runtime.discover must resolve to { tools }')
  }
  const response = { ok: true, action: 'discover', tools: [...discovery.tools] }
  if (Array.isArray(discovery.missing) && discovery.missing.length > 0) {
    response.missing = [...discovery.missing]
  }
  if (discovery.truncated === true) response.truncated = true
  return response
}

/**
 * Statically validate a definition without running it or touching the library.
 * @param {object} args - validated arguments.
 * @param {object} exec - tool run context.
 * @param {{ runtime: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical validation result.
 */
async function runValidate(args, exec, { runtime }) {
  const definition = pickDefinition(args)
  const availableTools = await visibleToolNames(definition.requiredTools, exec, runtime)
  const validation = validateProgramDefinition(definition, availableTools === undefined ? undefined : { availableTools })
  if (!validation.ok) {
    return failure('validate', 'VALIDATION_FAILED', 'the program definition is invalid', validation.violations)
  }
  return {
    ok: true,
    action: 'validate',
    definition: validation.normalized,
    warnings: [...validation.warnings],
  }
}

/**
 * Execute unsaved source without writing an artifact.
 *
 * The definition is synthesized from the supplied metadata and statically
 * validated first, then `args` are validated against its own schema, and only
 * then is the program handed to the PTC runtime. Declared `requiredTools` are
 * resolved with one read-only discovery query, exactly like `validate`/`save`,
 * so visibility is reported as a warning and never blocks execution. The store
 * is never called.
 *
 * @param {object} args - validated arguments.
 * @param {object} exec - tool run context.
 * @param {{ runtime: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical execution result.
 */
async function runTest(args, exec, { runtime }) {
  const definition = {
    name: args.name === undefined ? UNSAVED_PROGRAM_NAME : args.name,
    description: args.description === undefined ? UNSAVED_PROGRAM_DESCRIPTION : args.description,
    parameters: args.parameters === undefined ? UNSAVED_PROGRAM_PARAMETERS : args.parameters,
    code: args.code,
    requiredTools: args.requiredTools === undefined ? [] : args.requiredTools,
  }
  const availableTools = await visibleToolNames(definition.requiredTools, exec, runtime)
  const validation = validateProgramDefinition(definition, availableTools === undefined ? undefined : { availableTools })
  if (!validation.ok) {
    return failure('test', 'VALIDATION_FAILED', 'the program definition is invalid', validation.violations)
  }

  const runArgs = args.args === undefined ? {} : args.args
  const violations = validateProgramArgs(validation.normalized.parameters, runArgs)
  if (violations.length > 0) {
    return failure('test', 'INVALID_ARGS', 'arguments do not match the program parameter schema', violations)
  }

  const outcome = await runtime.execute(
    {
      code: validation.normalized.code,
      description: validation.normalized.description,
      args: runArgs,
    },
    exec,
  )
  return executionSuccess('test', outcome, { warnings: [...validation.warnings] })
}

/**
 * Statically validate a definition and persist it as a new revision.
 * Saving never executes the program.
 * @param {object} args - validated arguments.
 * @param {object} exec - tool run context.
 * @param {{ store: object, runtime: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical save result with the stored snapshot.
 */
async function runSave(args, exec, { store, runtime }) {
  const definition = pickDefinition(args)
  const availableTools = await visibleToolNames(definition.requiredTools, exec, runtime)
  const validation = validateProgramDefinition(definition, availableTools === undefined ? undefined : { availableTools })
  if (!validation.ok) {
    return failure('save', 'VALIDATION_FAILED', 'the program definition is invalid', validation.violations)
  }

  const input = { ...validation.normalized }
  if (args.expectedRevision !== undefined) input.expectedRevision = args.expectedRevision
  const { artifact, version } = await store.save(input)

  return {
    ok: true,
    action: 'save',
    artifact: summarizeArtifact(artifact),
    version,
    warnings: [...validation.warnings],
  }
}

/**
 * List artifact summaries, never program source.
 * @param {object} args - validated arguments.
 * @param {object} _exec - unused tool run context.
 * @param {{ store: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical listing.
 */
async function runList(args, _exec, { store }) {
  const summaries = await store.list({ includeArchived: args.includeArchived === undefined ? false : args.includeArchived })
  if (!Array.isArray(summaries)) {
    throw new TypeError('store.list must resolve to an array of summaries')
  }
  const limit = args.limit
  const artifacts = limit === undefined ? [...summaries] : summaries.slice(0, limit)
  return {
    ok: true,
    action: 'list',
    artifacts,
    total: summaries.length,
    truncated: artifacts.length < summaries.length,
  }
}

/**
 * Read one artifact summary plus the selected revision only.
 * A historical revision is never upgraded to the latest schema or source.
 * @param {object} args - validated arguments.
 * @param {object} _exec - unused tool run context.
 * @param {{ store: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical artifact projection.
 */
async function runGet(args, _exec, { store }) {
  const artifact = await store.get(args.name, args.revision)
  const version = selectVersion(artifact, args.revision)
  return { ok: true, action: 'get', artifact: summarizeArtifact(artifact), version }
}

/**
 * Execute a saved revision with its own schema and source.
 * Archived artifacts are refused and nothing is written.
 * @param {object} args - validated arguments.
 * @param {object} exec - tool run context.
 * @param {{ store: object, runtime: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical execution result.
 */
async function runRun(args, exec, { store, runtime }) {
  const artifact = await store.get(args.name, args.revision)
  if (artifact.archivedAt !== null && artifact.archivedAt !== undefined) {
    return failure('run', 'PROGRAM_ARCHIVED', `program "${artifact.name}" is archived since ${artifact.archivedAt}; archived artifacts cannot run`)
  }

  const version = selectVersion(artifact, args.revision)
  const runArgs = args.args === undefined ? {} : args.args
  const violations = validateProgramArgs(version.parameters, runArgs)
  if (violations.length > 0) {
    return failure('run', 'INVALID_ARGS', 'arguments do not match the artifact parameter schema', violations)
  }

  const outcome = await runtime.execute({ code: version.code, description: version.description, args: runArgs }, exec)
  return executionSuccess('run', outcome, { name: artifact.name, revision: version.revision })
}

/**
 * Archive an artifact while keeping every revision readable.
 * @param {object} args - validated arguments.
 * @param {object} _exec - unused tool run context.
 * @param {{ store: object }} collaborators - dependencies.
 * @returns {Promise<object>} canonical archived summary.
 */
async function runArchive(args, _exec, { store }) {
  const artifact = await store.archive(args.name)
  return { ok: true, action: 'archive', artifact: summarizeArtifact(artifact) }
}

/** Action name to handler. Built after the declarations so the map stays total. */
const HANDLERS = Object.freeze({
  discover: runDiscover,
  validate: runValidate,
  test: runTest,
  save: runSave,
  list: runList,
  get: runGet,
  run: runRun,
  archive: runArchive,
})

/* ------------------------------------------------------------------ helpers */

/**
 * Project the definition fields the static validator understands.
 * @param {object} args - validated arguments.
 * @returns {object} a definition-shaped object.
 */
function pickDefinition(args) {
  const definition = {
    name: args.name,
    description: args.description,
    parameters: args.parameters,
    code: args.code,
  }
  if (args.requiredTools !== undefined) definition.requiredTools = args.requiredTools
  if (args.changeNote !== undefined) definition.changeNote = args.changeNote
  return definition
}

/**
 * Read the caller-visible tool names for `requiredTools` warnings.
 *
 * Visibility is informational only (a tool another Agent mode sees is not
 * globally absent), so discovery is skipped entirely when nothing is declared.
 *
 * @param {unknown} requiredTools - declared dependency names.
 * @param {object} exec - tool run context.
 * @param {object} runtime - PTC bridge.
 * @returns {Promise<string[] | undefined>} visible names, or `undefined` when no declaration exists.
 */
async function visibleToolNames(requiredTools, exec, runtime) {
  if (!Array.isArray(requiredTools) || requiredTools.length === 0) return undefined
  const discovery = await runtime.discover(exec)
  if (!isPlainObject(discovery) || !Array.isArray(discovery.tools)) {
    throw new TypeError('runtime.discover must resolve to { tools }')
  }
  const names = []
  for (const tool of discovery.tools) {
    if (typeof tool === 'string') names.push(tool)
    else if (isPlainObject(tool) && typeof tool.name === 'string') names.push(tool.name)
  }
  return names
}

/**
 * Project one artifact onto the source-free summary `list` returns.
 * @param {object} artifact - stored artifact.
 * @returns {object} canonical summary.
 */
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

/**
 * Turn the PTC bridge's canonical `{ result, logs?, sandbox? }` outcome into a
 * success. The sandbox descriptor is the bounded file-policy outcome of the
 * run, so a denied program stays diagnosable at the tool result.
 * @param {string} action - action that executed the program.
 * @param {unknown} outcome - bridge outcome.
 * @param {object} [identity] - artifact identity to echo for `run`.
 * @returns {object} canonical success value.
 */
function executionSuccess(action, outcome, identity = {}) {
  if (!isPlainObject(outcome)) {
    throw new TypeError('runtime.execute must resolve to { result, logs?, sandbox? }')
  }
  const response = { ok: true, action, ...identity }
  if (Object.hasOwn(outcome, 'result')) response.result = outcome.result
  if (Array.isArray(outcome.logs) && outcome.logs.length > 0) response.logs = [...outcome.logs]
  if (outcome.sandbox !== undefined) response.sandbox = outcome.sandbox
  return response
}

/**
 * Build one canonical expected-failure value.
 * @param {string} action - action being attempted.
 * @param {string} code - stable machine-readable reason.
 * @param {string} message - human-readable diagnostic.
 * @param {string[]} [violations] - path-qualified details.
 * @param {unknown} [details] - structured failure identity preserved from the bridge.
 * @returns {object} canonical failure value.
 */
function failure(action, code, message, violations, details) {
  const response = { ok: false, action, error: { code, message } }
  if (details !== undefined) response.error.details = details
  if (Array.isArray(violations) && violations.length > 0) response.violations = [...violations]
  return response
}

/**
 * Map a thrown collaborator failure onto the canonical error envelope.
 *
 * Only documented error identities are expected — store failures, the bridge's
 * dedicated result-limit error, program failures and a disposed bridge. Every
 * other throw, a plain `RangeError` included, propagates so a bug is never
 * reported as a success or as a limit.
 *
 * @param {string} action - action being attempted.
 * @param {unknown} error - caught value.
 * @returns {object | null} canonical failure, or `null` when the failure is not expected.
 */
function expectedFailure(action, error) {
  if (error instanceof ProgramStoreError) {
    const violations = Array.isArray(error.violations) ? error.violations : undefined
    return failure(action, error.code, error.message, violations)
  }
  if (error instanceof PtcResultLimitError) {
    return failure(action, 'LIMIT_EXCEEDED', error.message)
  }
  if (error instanceof PtcProgramError) {
    // Cancellation keeps its own identity instead of masquerading as a program bug.
    const code = error.name === 'AbortError' ? 'PROGRAM_ABORTED' : 'PROGRAM_FAILED'
    return failure(action, code, error.message, undefined, error.info)
  }
  if (error instanceof PtcBridgeDisposedError) {
    return failure(action, error.code, error.message)
  }
  return null
}

/**
 * Render one canonical value as model-facing text with sorted object keys.
 * @param {unknown} _args - validated arguments (unused).
 * @param {unknown} value - canonical value returned by `execute`.
 * @returns {Array<{ type: 'text', text: string }>} one text content block.
 */
function renderCanonical(_args, value) {
  return [{ type: 'text', text: canonicalJsonText(value) }]
}

/**
 * Serialize a lossless JSON value with lexicographically sorted object keys.
 * @param {unknown} value - lossless JSON value.
 * @returns {string} canonical JSON text.
 */
function canonicalJsonText(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonText(entry)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonText(value[key])}`)
    return `{${entries.join(',')}}`
  }
  const text = JSON.stringify(value)
  return text === undefined ? 'null' : text
}

/**
 * Test for an ordinary record without accepting arrays or class instances.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether the value is a plain JSON object.
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Test for a positive safe revision/limit integer.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether the value is a positive safe integer.
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Test for a dense array of strings.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether the value is a string array.
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Short, safe rendering of an untrusted value in a diagnostic.
 * @param {unknown} value - rejected value.
 * @returns {string} diagnostic text.
 */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value
}
