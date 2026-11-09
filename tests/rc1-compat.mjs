/**
 * Real DSH 0.2.2-rc.1 compatibility probe for the single `ptc_sdk` tool.
 *
 * This probe boots the installed 0.2.2-rc.1 composition in an isolated
 * temporary home, mounts the six Agent compositions the contract names
 * (`standard`, `minimal`, `ptc`, `cordis`, one custom preset with an explicit
 * native executor in its own scope, and one custom preset with no executor at
 * all), and exercises the public tool surface end to end:
 *
 * - `ptc_sdk` is registered once at the root tool layer, so every mode sees it.
 * - The caller's own executor is the same object before and after every call,
 *   and the PTC preset still exposes only `run_code` on the wire.
 * - A native caller calls `ptc_sdk` directly; a PTC caller reaches it through
 *   `run_code`, which is the mode-agnostic contract.
 * - A probe-only ordinary tool (`ptc_forge_echo`) records real nested
 *   dispatches, and the host `tools/result` audit proves the nested call
 *   carried the PTC execution token (its call id contains the transport
 *   marker), so the inner program really ran on the official PTC executor.
 * - A saved artifact is written once, run from another Agent and from an outer
 *   PTC program, then re-read through a brand-new store instance.
 * - Revisions 1 and 2 keep their own parameter schemas and source.
 * - Archived artifacts refuse to run; explicit restrictions hide a tool from
 *   discovery and cannot be bypassed by a nested program.
 * - Disposing the application unregisters the tool, aborts an in-flight
 *   program and shuts the host down cleanly.
 *
 * The probe never reads or writes a live profile. It requires the installed
 * rc1 paths through the environment, never through a hard-coded machine path:
 *
 *   DSH_RC1_INSTALL   `<install>/resources/app.asar/dsh`
 *   DSH_RC1_ELECTRON  `<install>/DeepSeek Harness.exe`
 *
 * Node cannot import from a packed asar, so a plain `node` invocation re-execs
 * itself once under `ELECTRON_RUN_AS_NODE=1` with the supplied launcher.
 * Missing inputs print the usage and exit non-zero instead of guessing.
 *
 * Evidence is written to `artifacts/rc1-result.json` and `artifacts/rc1-probe.log`.
 * Both are deliberately desensitized: generic check names and booleans, no
 * paths, tokens or session identifiers.
 *
 * @module dsh-ptc-sdk-forge/tests/rc1-compat
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROBE_PATH = fileURLToPath(import.meta.url)
const PROJECT_ROOT = resolve(dirname(PROBE_PATH), '..')
const ARTIFACTS_DIR = join(PROJECT_ROOT, 'artifacts')
const RESULT_PATH = join(ARTIFACTS_DIR, 'rc1-result.json')
const LOG_PATH = join(ARTIFACTS_DIR, 'rc1-probe.log')
const DSH_VERSION = '0.2.2-rc.1'
const WATCHDOG_MS = 240_000
const PRESETS = Object.freeze([
  'standard',
  'minimal',
  'ptc',
  'cordis',
  'forge-native-custom',
  'forge-plain-custom',
])
const SDK_TOOL_NAME = 'ptc_sdk'
const ECHO_TOOL_NAME = 'ptc_forge_echo'
const ARTIFACT_NAME = 'probe-evidence-pack'
const PROBE_VALUE = 41

const USAGE = [
  'usage:',
  '  DSH_RC1_INSTALL=<install>/resources/app.asar/dsh \\',
  '  DSH_RC1_ELECTRON=<install>/DeepSeek Harness.exe \\',
  '  [timeout 300] node tests/rc1-compat.mjs',
  '',
  'DSH_RC1_INSTALL must name the unpacked dsh directory inside the installed',
  'app asar (the directory holding node_modules/@deepseek-ai/dsh/lib/profile-boot.js).',
  'DSH_RC1_ELECTRON must name the installed Electron launcher; the probe re-execs',
  'itself under ELECTRON_RUN_AS_NODE so asar imports resolve.',
  '',
  'The probe boots an isolated temporary DSH home, profile and library. It never',
  'reads or writes a live profile and never starts or stops the running application.',
].join('\n')

/** Print the usage for one rejected invocation input and stop with a usage code. */
function usageError(message) {
  console.error(message)
  console.error('')
  console.error(USAGE)
  process.exit(2)
}

const installDir = (process.env.DSH_RC1_INSTALL ?? '').trim()
const electronPath = (process.env.DSH_RC1_ELECTRON ?? '').trim()

if (installDir.length === 0 || electronPath.length === 0) {
  usageError('both DSH_RC1_INSTALL and DSH_RC1_ELECTRON are required')
}

// Node cannot import modules from a packed asar; the installed launcher can.
if (typeof process.versions.electron !== 'string') {
  if (!existsSync(electronPath)) usageError(`DSH_RC1_ELECTRON does not exist: ${electronPath}`)
  const child = spawnSync(electronPath, [PROBE_PATH], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: WATCHDOG_MS,
    windowsHide: true,
  })
  if (child.error !== undefined) usageError(`could not re-exec under Electron: ${child.error.message}`)
  process.exit(typeof child.status === 'number' ? child.status : 1)
}

const installModules = join(installDir, 'node_modules', '@deepseek-ai')
const profileBootPath = join(installModules, 'dsh', 'lib', 'profile-boot.js')
const appBootPath = join(installModules, 'dsh-app-boot', 'lib', 'index.js')
const agentModulePath = join(installModules, 'dsh-agent', 'lib', 'index.js')
const toolsModulePath = join(installModules, 'dsh-tools', 'lib', 'index.js')
for (const requiredPath of [profileBootPath, appBootPath, agentModulePath, toolsModulePath]) {
  if (!existsSync(requiredPath)) {
    usageError(`DSH_RC1_INSTALL is not an installed dsh directory (missing ${requiredPath})`)
  }
}
const installedDshVersion = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version

/* --------------------------------------------------------------- isolation */

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-rc1-forge-'))
const homeDir = join(tempRoot, 'home')
const profileName = 'ptc-sdk-forge-probe'
const profileDir = join(homeDir, 'profiles', profileName)
const profileModules = join(profileDir, 'node_modules')
const pluginCopyDir = join(profileModules, 'dsh-ptc-sdk-forge')
const libraryRoot = join(homeDir, 'ptc-sdk-forge')

process.env.DSH_HOME = homeDir
process.env.DSH_TELEMETRY_DISABLED = '1'
process.env.DSH_PERMISSION_MODE = 'danger-full-access'

const pluginManifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))

mkdirSync(profileModules, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: { [pluginManifest.name]: pluginManifest.version },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pluginManifest.name],
        },
      },
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  join(profileDir, 'cordis.patch.yml'),
  '# Probe profile: the isolated library root comes from DSH_HOME; no live profile is touched.\n[]\n',
)
// Hash the implementation before copying it, so the evidence names exactly the
// source tree the isolated profile received.
const srcTreeSha256 = hashSourceTree()
mkdirSync(pluginCopyDir, { recursive: true })
cpSync(join(PROJECT_ROOT, 'src'), join(pluginCopyDir, 'src'), { recursive: true })
for (const file of ['package.json', 'cordis.patch.yml', 'dsh.plugin.json']) {
  copyFileSync(join(PROJECT_ROOT, file), join(pluginCopyDir, file))
}

/* ----------------------------------------------------------------- evidence */

mkdirSync(ARTIFACTS_DIR, { recursive: true })
const probeSha256 = createHash('sha256').update(readFileSync(PROBE_PATH)).digest('hex')
const startedAt = Date.now()
const result = {
  kind: 'dsh-rc1-ptc-sdk-forge-compat',
  dshVersion: String(installedDshVersion),
  probeSha256,
  ok: false,
  checks: {},
  summary: { total: 0, passed: 0, failed: 0 },
  shutdown: {
    requested: false,
    clean: false,
    exitCode: null,
    toolRegisteredBefore: false,
    toolUnregisteredAfter: false,
    activeProgramSettled: false,
    activeProgramAborted: false,
    fiberDisposed: false,
    leftoverTimers: null,
  },
  tempCleanup: 'pending',
  durationMs: 0,
}
const logLines = [`# dsh ${DSH_VERSION} ${SDK_TOOL_NAME} compatibility probe`, `# probe sha256 ${probeSha256}`]

/**
 * Hash the plugin source tree the probe copies into the isolated profile, so
 * the evidence names the exact implementation that was exercised.
 *
 * @returns {string} SHA-256 over every `src/` file, path-qualified.
 */
function hashSourceTree() {
  const hash = createHash('sha256')
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
        hash.update(relative(join(PROJECT_ROOT, 'src'), absolute).split(sep).join('/'))
        hash.update(readFileSync(absolute))
      }
    }
  }
  walk(join(PROJECT_ROOT, 'src'))
  return hash.digest('hex')
}

/** Source tree hash captured before the isolated profile copy. */
result.srcTreeSha256 = srcTreeSha256

/** Record one boolean check, mirroring it to the console and the evidence log. */
function check(name, value) {
  const pass = value === true
  result.checks[name] = pass
  logLines.push(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  return pass
}

/** Keep diagnostics useful while removing every path and credential from evidence. */
function sanitize(value) {
  let text = String(value ?? '')
  for (const [needle, replacement] of [
    [tempRoot, '<temp>'],
    [homeDir, '<temp-home>'],
    [installDir, '<install>'],
    [PROJECT_ROOT, '<project>'],
  ]) {
    if (needle.length > 0) text = text.split(needle).join(replacement)
  }
  text = text.replace(/[A-Za-z]:[\\/][^\s'"`,;)\]]*/g, '<path>')
  text = text.replace(/token=[^&\s]+/gi, 'token=<redacted>')
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text
}

/** Write both evidence files from the current check table. */
function writeArtifacts() {
  const entries = Object.entries(result.checks)
  const passed = entries.filter(([, value]) => value === true).length
  result.summary = { total: entries.length, passed, failed: entries.length - passed }
  result.ok = entries.length > 0 && result.summary.failed === 0
  result.durationMs = Date.now() - startedAt
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`)
  logLines.push(
    `SUMMARY total=${result.summary.total} passed=${result.summary.passed} failed=${result.summary.failed} ok=${result.ok}`,
  )
  logLines.push(
    `SHUTDOWN clean=${result.shutdown.clean} toolUnregistered=${result.shutdown.toolUnregisteredAfter} `
      + `activeProgramAborted=${result.shutdown.activeProgramAborted} fiberDisposed=${result.shutdown.fiberDisposed} `
      + `leftoverTimers=${result.shutdown.leftoverTimers}`,
  )
  logLines.push(`SRC ${result.srcTreeSha256}`)
  logLines.push(`TEMP ${result.tempCleanup}`)
  writeFileSync(LOG_PATH, `${logLines.join('\n')}\n`)
}

/** Read the global tool names off a captured tools service; `undefined` when unreadable. */
function readToolNames(toolsService) {
  try {
    const view = toolsService?.view(undefined)
    return view === undefined ? undefined : [...view.knownNames]
  } catch {
    return undefined
  }
}

/**
 * Race one promise against a bounded wait, clearing the timer as soon as the
 * promise settles so the probe never leaves a Timeout behind.
 *
 * @param {Promise<unknown>} promise - work to observe.
 * @param {number} ms - maximum wait.
 * @returns {Promise<boolean>} whether the promise settled inside the budget.
 */
function settleWithin(promise, ms) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), ms)
    const settle = () => {
      clearTimeout(timer)
      resolveWait(true)
    }
    promise.then(settle, settle)
  })
}

/* -------------------------------------------------------------- probe state */

let application
let watchdog
let shutdownRequested = false
const echoCalls = []
let blockStartedResolve
const blockStarted = new Promise((resolveBlock) => {
  blockStartedResolve = resolveBlock
})
let blockedAborted = false
const toolsServiceRef = { current: undefined }

const PARAMS_VALUE = Object.freeze({
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
})
const SCHEMA_V1 = Object.freeze({
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
})
const SCHEMA_V2 = Object.freeze({
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
})
const CODE_V1 = [
  `const first = await tools.${ECHO_TOOL_NAME}({ label: 'rev1-first', value: args.value });`,
  `const second = await tools.${ECHO_TOOL_NAME}({ label: 'rev1-second', value: args.value + 1 });`,
  'return { sum: first.value + second.value, labels: [first.label, second.label] };',
].join('\n')
const CODE_V2 = [
  `const echo = await tools.${ECHO_TOOL_NAME}({ label: 'rev2-only', text: args.text });`,
  'return { echoedText: echo.text, length: echo.text.length };',
].join('\n')

// A real TypeScript program: an interface, variable annotations and `as`
// assertions are all erasable, so the official PTC strip-only compiler must
// accept the source and the run must return the stripped program's value.
const TS_ARTIFACT_NAME = 'probe-typescript-pack'
const TS_PARAMETERS = Object.freeze({
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
})
const TS_CODE = [
  'interface EchoPayload {',
  '  label: string;',
  '  value: number;',
  '}',
  'const value: number = args.value;',
  'const label = `ts-${value}` as string;',
  'const payload: EchoPayload = { label, value };',
  `const echo = await tools.${ECHO_TOOL_NAME}(payload);`,
  'const echoed: number = echo.value as number;',
  'return { typedValue: value, echoedValue: echoed, label: echo.label as string };',
].join('\n')
// `enum` and `namespace` are not erasable: strip-only mode must reject them
// statically, before the official runtime ever sees the program.
const ENUM_CODE = ['enum ProbeKind { Alpha = 1 }', 'return { kind: ProbeKind.Alpha };'].join('\n')
const NAMESPACE_CODE = [
  'namespace ProbeSpace { export const value = 1; }',
  'return { value: ProbeSpace.value };',
].join('\n')

try {
  watchdog = setTimeout(() => {
    console.error('probe watchdog expired; exiting only the probe process')
    process.exit(124)
  }, WATCHDOG_MS)

  const [{ runProfile }, { loadLayeredEnv }, { installModelSelection }, { defineTool }] = await Promise.all([
    import(pathToFileURL(profileBootPath).href),
    import(pathToFileURL(appBootPath).href),
    import(pathToFileURL(agentModulePath).href),
    import(pathToFileURL(toolsModulePath).href),
  ])

  application = await runProfile({
    environment: loadLayeredEnv('ptc-sdk-forge-probe', tempRoot),
    profile: profileName,
    patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
  })
  const { ctx } = application
  await ctx.loader.await()
  const modelSelection = ctx.get('agentDefaultModel').currentSelection()
  check('boot:dshVersion', installedDshVersion === DSH_VERSION)
  check('boot:profileReady', typeof modelSelection?.provider === 'string' && typeof modelSelection?.model === 'string')
  toolsServiceRef.current = ctx.get('tools')

  /* -------------------------------------------------------- probe-only tool */

  ctx.tools.register(
    defineTool({
      name: ECHO_TOOL_NAME,
      description: 'Probe-only ordinary tool: records one nested call and echoes its arguments.',
      parameters: {
        label: { type: 'string', required: true, description: 'Stable probe call label.' },
        value: { type: 'number', description: 'Optional numeric payload.' },
        text: { type: 'string', description: 'Optional text payload.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        echoCalls.push({ label: args.label, value: args.value ?? null, text: args.text ?? null })
        if (args.label === 'block') {
          blockStartedResolve()
          return await new Promise((_resolve, reject) => {
            const abort = () => {
              blockedAborted = true
              reject(new Error('probe echo aborted'))
            }
            if (exec.signal.aborted) abort()
            else exec.signal.addEventListener('abort', abort, { once: true })
          })
        }
        return { label: args.label, value: args.value ?? null, text: args.text ?? null, seq: echoCalls.length }
      },
    }),
  )

  /* ------------------------------------------------------- custom presets */

  await ctx.agentPresets.register({
    id: 'forge-native-custom',
    name: 'Probe explicit native custom preset',
    description: 'Custom preset that mounts the official native executor in its own scope.',
    order: 90,
    plugins: [{ id: 'tool-executor-native', name: '@deepseek-ai/dsh-tool-executor-native' }],
  })
  await ctx.agentPresets.register({
    id: 'forge-plain-custom',
    name: 'Probe executor-free custom preset',
    description: 'Custom preset that mounts no executor and inherits the deployment default.',
    order: 91,
    plugins: [{ id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }],
  })
  check('presets:customRegistered', true)

  /** Create one unpublished-then-published Agent bound to a preset. */
  async function createAgent(presetId) {
    const handle = await ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: tempRoot, mode: 'danger-full-access' },
      agentOptions: { provider: modelSelection.provider, model: modelSelection.model },
      setup: async (agentCtx) => {
        installModelSelection(agentCtx)
        await agentCtx.get('agentPresets').mount(agentCtx, presetId)
      },
    })
    return handle.agent
  }

  const agents = new Map()
  for (const presetId of PRESETS) {
    try {
      const agent = await createAgent(presetId)
      agents.set(presetId, agent)
      const composed = agent.ctx.get('agentPresets')?.composedPreset(agent.ctx)
      check(`${presetId}:mounted`, composed === presetId)
    } catch (error) {
      check(`${presetId}:mounted`, false)
      logLines.push(`# ${presetId} creation failed: ${sanitize(error?.message ?? error)}`)
    }
  }

  /* ------------------------------------------------------------- plumbing */

  /** Resolve one step admission set for an Agent. */
  async function resolveToolSet(agent) {
    return await agent.ctx.tools.resolve({
      agent,
      modelSelection,
      signal: new AbortController().signal,
    })
  }

  /**
   * Execute one raw tool call through the real pipeline.
   *
   * `log` is deliberately omitted: the probe is not a model step, and supplying
   * a synthetic log position would forge Session history.
   */
  async function executeCall(agent, toolSet, name, args) {
    const batch = await agent.ctx.tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: `probe-${randomUUID()}`,
          name,
          arguments: JSON.stringify(args),
        },
      ],
      agent,
      toolSet,
      signal: new AbortController().signal,
    })
    const outcome = batch?.results?.[0]?.result
    return {
      isError: outcome?.isError === true,
      value: outcome?.value,
      content: outcome?.content,
      error: outcome?.error,
    }
  }

  /**
   * Call `ptc_sdk` the way each outer composition must: native presets call it
   * directly, the PTC preset reaches it from inside a `run_code` program.
   */
  async function invokeSdk(presetId, agent, toolSet, sdkArgs) {
    if (presetId !== 'ptc') {
      const call = await executeCall(agent, toolSet, SDK_TOOL_NAME, sdkArgs)
      return { ...call, sdkValue: call.value }
    }
    const outerCode = `return { inner: await tools.${SDK_TOOL_NAME}(${JSON.stringify(sdkArgs)}) };`
    const call = await executeCall(agent, toolSet, 'run_code', {
      code: outerCode,
      description: 'Call ptc_sdk from inside an outer PTC program',
    })
    return { ...call, sdkValue: call.value?.result?.inner }
  }

  /* --------------------------------------------------- six-mode surface */

  async function verifyPreset(presetId, agent) {
    const toolSet = await resolveToolSet(agent)
    const audit = []
    const stopAudit = agent.ctx.on('tools/result', (exec) => {
      audit.push({
        name: exec.name,
        nested: exec.parent !== undefined,
        ptcDispatch: typeof exec.callId === 'string' && exec.callId.includes(':ptc:'),
      })
    })
    try {
      const executorBefore = agent.ctx.tools.selectExecutor(agent)
      const rootExecutor = agent.ctx.tools.selectExecutor(undefined)
      const executorName = executorBefore?.constructor?.name
      check(`${presetId}:ptcSdkVisible`, toolSet.view(agent).has(SDK_TOOL_NAME) === true)
      if (presetId === 'ptc') {
        check(`${presetId}:outerExecutorIsPtc`, executorName === 'PtcExecutor')
        const definitions = agent.ctx.tools.definitions(agent, toolSet)
        const wire = executorBefore.describe(definitions).schemas.map((schema) => schema.name)
        check(`${presetId}:outerWireIsRunCodeOnly`, wire.length === 1 && wire[0] === 'run_code')
      } else {
        check(`${presetId}:outerExecutorIsNative`, executorName === 'NativeToolExecutor')
      }
      if (presetId === 'forge-native-custom') {
        check(`${presetId}:scopedNativeExecutor`, executorBefore !== rootExecutor)
      } else if (presetId !== 'ptc') {
        check(`${presetId}:inheritsRootExecutor`, executorBefore === rootExecutor)
      }

      const discover = await invokeSdk(presetId, agent, toolSet, { action: 'discover' })
      const names = Array.isArray(discover.sdkValue?.tools)
        ? discover.sdkValue.tools.map((tool) => tool.name)
        : []
      check(`${presetId}:discoverListsEcho`, names.includes(ECHO_TOOL_NAME))
      check(`${presetId}:discoverHidesSdk`, !names.includes(SDK_TOOL_NAME))

      const echoBefore = echoCalls.length
      const innerCode = [
        `const echo = await tools.${ECHO_TOOL_NAME}({ label: '${presetId}', value: args.value });`,
        'return { innerValue: echo.value, innerLabel: echo.label };',
      ].join('\n')
      const test = await invokeSdk(presetId, agent, toolSet, {
        action: 'test',
        code: innerCode,
        parameters: PARAMS_VALUE,
        args: { value: PROBE_VALUE },
      })
      check(
        `${presetId}:nestedProgramSucceeded`,
        test.isError === false
          && test.sdkValue?.ok === true
          && test.sdkValue?.result?.innerValue === PROBE_VALUE
          && test.sdkValue?.result?.innerLabel === presetId,
      )
      const newCalls = echoCalls.slice(echoBefore)
      check(
        `${presetId}:nestedToolRan`,
        newCalls.length === 1 && newCalls[0].label === presetId && newCalls[0].value === PROBE_VALUE,
      )
      check(
        `${presetId}:nestedDispatchAudited`,
        audit.some((entry) => entry.name === ECHO_TOOL_NAME && entry.nested === true),
      )
      check(
        `${presetId}:nestedUsesPtcTransport`,
        audit.some((entry) => entry.name === ECHO_TOOL_NAME && entry.ptcDispatch === true),
      )
      if (presetId === 'ptc') {
        check(
          `${presetId}:outerPtcSawSdkResult`,
          test.value?.result?.inner?.ok === true && test.value?.result?.inner?.result?.innerLabel === presetId,
        )
      } else {
        const rendered = test.content?.find((block) => block.type === 'text')?.text
        let parsed
        try {
          parsed = JSON.parse(rendered)
        } catch {
          parsed = undefined
        }
        let canonical = false
        try {
          assert.deepEqual(parsed, test.sdkValue)
          canonical = typeof rendered === 'string' && rendered.startsWith('{')
        } catch {
          canonical = false
        }
        check(`${presetId}:canonicalContent`, canonical)
      }

      const executorAfter = agent.ctx.tools.selectExecutor(agent)
      check(`${presetId}:executorUnchanged`, executorBefore === executorAfter)
    } finally {
      stopAudit?.()
      toolSet.dispose()
    }
  }

  for (const presetId of PRESETS) {
    const agent = agents.get(presetId)
    if (agent === undefined) continue
    try {
      await verifyPreset(presetId, agent)
    } catch (error) {
      check(`${presetId}:probeCompleted`, false)
      logLines.push(`# ${presetId} verification failed: ${sanitize(error?.message ?? error)}`)
    }
  }

  /* ------------------------------------- save / revision / run / archive */

  const standardAgent = agents.get('standard')
  if (standardAgent !== undefined) {
    const toolSet = await resolveToolSet(standardAgent)
    try {
      const echoBeforeSave = echoCalls.length
      const save1 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'save',
        name: ARTIFACT_NAME,
        description: 'Probe artifact revision 1.',
        parameters: SCHEMA_V1,
        code: CODE_V1,
      })
      check(
        'save:revision1',
        save1.isError === false
          && save1.sdkValue?.ok === true
          && save1.sdkValue?.version?.revision === 1
          && save1.sdkValue?.artifact?.latestRevision === 1,
      )
      const save2 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'save',
        name: ARTIFACT_NAME,
        description: 'Probe artifact revision 2.',
        parameters: SCHEMA_V2,
        code: CODE_V2,
        expectedRevision: 1,
      })
      check(
        'save:revision2',
        save2.isError === false
          && save2.sdkValue?.ok === true
          && save2.sdkValue?.version?.revision === 2
          && save2.sdkValue?.artifact?.latestRevision === 2,
      )
      check('save:neverRunsCode', echoCalls.length === echoBeforeSave)
      const conflict = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'save',
        name: ARTIFACT_NAME,
        description: 'Probe stale revision.',
        parameters: SCHEMA_V1,
        code: CODE_V1,
        expectedRevision: 1,
      })
      check(
        'save:revisionConflict',
        conflict.sdkValue?.ok === false && conflict.sdkValue?.error?.code === 'REVISION_CONFLICT',
      )
      const missingExpected = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'save',
        name: ARTIFACT_NAME,
        description: 'Probe missing expected revision.',
        parameters: SCHEMA_V1,
        code: CODE_V1,
      })
      check(
        'save:expectedRevisionRequired',
        missingExpected.sdkValue?.ok === false
          && missingExpected.sdkValue?.error?.code === 'EXPECTED_REVISION_REQUIRED',
      )

      const validateCall = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'validate',
        name: 'probe-validate-only',
        description: 'Static probe definition.',
        parameters: SCHEMA_V1,
        code: CODE_V1,
      })
      check(
        'validate:staticPass',
        validateCall.sdkValue?.ok === true && validateCall.sdkValue?.definition?.name === 'probe-validate-only',
      )
      check('validate:noNestedExecution', echoCalls.length === echoBeforeSave)

      const listBeforeTest = await invokeSdk('standard', standardAgent, toolSet, { action: 'list' })
      const testCall = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'test',
        code: CODE_V1,
        parameters: SCHEMA_V1,
        args: { value: 10 },
      })
      check(
        'test:executesUnsaved',
        testCall.sdkValue?.ok === true
          && testCall.sdkValue?.result?.sum === 21
          && Array.isArray(testCall.sdkValue?.result?.labels),
      )
      const listAfterTest = await invokeSdk('standard', standardAgent, toolSet, { action: 'list' })
      check(
        'test:writesNoArtifact',
        JSON.stringify(listBeforeTest.sdkValue?.artifacts) === JSON.stringify(listAfterTest.sdkValue?.artifacts),
      )

      const runV1 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'run',
        name: ARTIFACT_NAME,
        revision: 1,
        args: { value: 7 },
      })
      check(
        'run:revision1Schema',
        runV1.sdkValue?.ok === true
          && runV1.sdkValue?.revision === 1
          && runV1.sdkValue?.result?.sum === 15
          && runV1.sdkValue?.result?.labels?.[0] === 'rev1-first'
          && runV1.sdkValue?.result?.labels?.[1] === 'rev1-second',
      )
      const runV2 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'run',
        name: ARTIFACT_NAME,
        args: { text: 'hello' },
      })
      check(
        'run:revision2Schema',
        runV2.sdkValue?.ok === true
          && runV2.sdkValue?.revision === 2
          && runV2.sdkValue?.result?.echoedText === 'hello'
          && runV2.sdkValue?.result?.length === 5,
      )
      const wrongV1 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'run',
        name: ARTIFACT_NAME,
        revision: 1,
        args: { text: 'hello' },
      })
      check(
        'run:revision1RejectsRevision2Args',
        wrongV1.sdkValue?.ok === false && wrongV1.sdkValue?.error?.code === 'INVALID_ARGS',
      )
      const wrongV2 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'run',
        name: ARTIFACT_NAME,
        args: { value: 7 },
      })
      check(
        'run:revision2RejectsRevision1Args',
        wrongV2.sdkValue?.ok === false && wrongV2.sdkValue?.error?.code === 'INVALID_ARGS',
      )
      const getV1 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'get',
        name: ARTIFACT_NAME,
        revision: 1,
      })
      check(
        'get:revision1Source',
        getV1.sdkValue?.ok === true
          && getV1.sdkValue?.version?.code === CODE_V1
          && getV1.sdkValue?.version?.parameters?.properties?.value?.type === 'number',
      )
      const getV2 = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'get',
        name: ARTIFACT_NAME,
        revision: 2,
      })
      check(
        'get:revision2Source',
        getV2.sdkValue?.ok === true
          && getV2.sdkValue?.version?.code === CODE_V2
          && getV2.sdkValue?.version?.parameters?.properties?.text?.type === 'string',
      )

      /* ------------------------------------------- TypeScript artifact */

      const echoBeforeTypeScript = echoCalls.length
      const tsValidate = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'validate',
        name: TS_ARTIFACT_NAME,
        description: 'Probe TypeScript artifact with erasable syntax.',
        parameters: TS_PARAMETERS,
        code: TS_CODE,
      })
      check(
        'typescript:validateErasable',
        tsValidate.sdkValue?.ok === true
          && tsValidate.sdkValue?.definition?.code === TS_CODE
          && (tsValidate.sdkValue?.warnings ?? []).length === 0,
      )
      const tsSave = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'save',
        name: TS_ARTIFACT_NAME,
        description: 'Probe TypeScript artifact with erasable syntax.',
        parameters: TS_PARAMETERS,
        code: TS_CODE,
      })
      check(
        'typescript:saveRevision1',
        tsSave.isError === false
          && tsSave.sdkValue?.ok === true
          && tsSave.sdkValue?.version?.revision === 1
          && tsSave.sdkValue?.version?.code === TS_CODE,
      )
      check('typescript:saveNeverRunsCode', echoCalls.length === echoBeforeTypeScript)
      const tsRun = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'run',
        name: TS_ARTIFACT_NAME,
        args: { value: 13 },
      })
      check(
        'typescript:runStripped',
        tsRun.sdkValue?.ok === true
          && tsRun.sdkValue?.result?.typedValue === 13
          && tsRun.sdkValue?.result?.echoedValue === 13
          && tsRun.sdkValue?.result?.label === 'ts-13',
      )
      const tsEcho = echoCalls.at(-1)
      check(
        'typescript:nestedToolRan',
        echoCalls.length === echoBeforeTypeScript + 1
          && tsEcho?.label === 'ts-13'
          && tsEcho?.value === 13,
      )
      const tsGet = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'get',
        name: TS_ARTIFACT_NAME,
        revision: 1,
      })
      check(
        'typescript:storedSource',
        tsGet.sdkValue?.ok === true && tsGet.sdkValue?.version?.code === TS_CODE,
      )

      const enumValidate = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'validate',
        name: 'probe-enum-rejected',
        description: 'Non-erasable enum fixture.',
        parameters: TS_PARAMETERS,
        code: ENUM_CODE,
      })
      const enumViolations = Array.isArray(enumValidate.sdkValue?.violations)
        ? enumValidate.sdkValue.violations.join(' ')
        : ''
      check(
        'typescript:enumRejected',
        enumValidate.sdkValue?.ok === false
          && enumValidate.sdkValue?.error?.code === 'VALIDATION_FAILED'
          && enumViolations.includes('erasable syntax')
          && enumViolations.includes('enum'),
      )
      const namespaceValidate = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'validate',
        name: 'probe-namespace-rejected',
        description: 'Non-erasable namespace fixture.',
        parameters: TS_PARAMETERS,
        code: NAMESPACE_CODE,
      })
      const namespaceViolations = Array.isArray(namespaceValidate.sdkValue?.violations)
        ? namespaceValidate.sdkValue.violations.join(' ')
        : ''
      check(
        'typescript:namespaceRejected',
        namespaceValidate.sdkValue?.ok === false
          && namespaceValidate.sdkValue?.error?.code === 'VALIDATION_FAILED'
          && namespaceViolations.includes('erasable syntax')
          && namespaceViolations.includes('namespace'),
      )
      const enumSave = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'save',
        name: 'probe-enum-rejected',
        description: 'Non-erasable enum fixture.',
        parameters: TS_PARAMETERS,
        code: ENUM_CODE,
      })
      check(
        'typescript:enumSaveRejected',
        enumSave.sdkValue?.ok === false && enumSave.sdkValue?.error?.code === 'VALIDATION_FAILED',
      )
      const enumGet = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'get',
        name: 'probe-enum-rejected',
      })
      check(
        'typescript:rejectedArtifactAbsent',
        enumGet.sdkValue?.ok === false && enumGet.sdkValue?.error?.code === 'PROGRAM_NOT_FOUND',
      )
      const echoBeforeRejectedTest = echoCalls.length
      const enumTest = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'test',
        code: ENUM_CODE,
        parameters: TS_PARAMETERS,
        args: { value: 1 },
      })
      check(
        'typescript:nonErasableTestNeverRuns',
        enumTest.sdkValue?.ok === false
          && enumTest.sdkValue?.error?.code === 'VALIDATION_FAILED'
          && echoCalls.length === echoBeforeRejectedTest,
      )
      check('typescript:noNestedExecution', echoCalls.length === echoBeforeTypeScript + 1)

      const minimalAgent = agents.get('minimal')
      if (minimalAgent !== undefined) {
        const minimalSet = await resolveToolSet(minimalAgent)
        try {
          const crossRun = await invokeSdk('minimal', minimalAgent, minimalSet, {
            action: 'run',
            name: ARTIFACT_NAME,
            revision: 1,
            args: { value: 3 },
          })
          check(
            'run:anotherAgent',
            crossRun.sdkValue?.ok === true && crossRun.sdkValue?.result?.sum === 7,
          )
          const crossTsRun = await invokeSdk('minimal', minimalAgent, minimalSet, {
            action: 'run',
            name: TS_ARTIFACT_NAME,
            revision: 1,
            args: { value: 5 },
          })
          check(
            'run:typescriptAnotherAgent',
            crossTsRun.sdkValue?.ok === true
              && crossTsRun.sdkValue?.result?.typedValue === 5
              && crossTsRun.sdkValue?.result?.label === 'ts-5',
          )
        } finally {
          minimalSet.dispose()
        }
      }
      const ptcAgent = agents.get('ptc')
      if (ptcAgent !== undefined) {
        const ptcSet = await resolveToolSet(ptcAgent)
        try {
          const ptcRun = await invokeSdk('ptc', ptcAgent, ptcSet, {
            action: 'run',
            name: ARTIFACT_NAME,
            revision: 1,
            args: { value: 5 },
          })
          check(
            'run:outerPtcProgram',
            ptcRun.isError === false && ptcRun.sdkValue?.ok === true && ptcRun.sdkValue?.result?.sum === 11,
          )
          check(
            'run:outerPtcExecutorKept',
            ptcAgent.ctx.tools.selectExecutor(ptcAgent)?.constructor?.name === 'PtcExecutor',
          )
        } finally {
          ptcSet.dispose()
        }
      }

      const { createProgramStore } = await import(pathToFileURL(join(PROJECT_ROOT, 'src', 'store.js')).href)
      const freshStore = createProgramStore({ root: libraryRoot })
      const fresh = await freshStore.get(ARTIFACT_NAME)
      check(
        'reload:freshStoreInstance',
        fresh?.latestRevision === 2
          && fresh?.versions?.length === 2
          && fresh?.versions?.[0]?.code === CODE_V1
          && fresh?.versions?.[1]?.code === CODE_V2,
      )
      const freshTypeScript = await freshStore.get(TS_ARTIFACT_NAME)
      check(
        'reload:typescriptArtifact',
        freshTypeScript?.latestRevision === 1 && freshTypeScript?.versions?.[0]?.code === TS_CODE,
      )

      const archive = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'archive',
        name: ARTIFACT_NAME,
      })
      check(
        'archive:marked',
        archive.sdkValue?.ok === true && typeof archive.sdkValue?.artifact?.archivedAt === 'string',
      )
      const archivedRun = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'run',
        name: ARTIFACT_NAME,
        revision: 1,
        args: { value: 1 },
      })
      check(
        'archive:runRejected',
        archivedRun.sdkValue?.ok === false && archivedRun.sdkValue?.error?.code === 'PROGRAM_ARCHIVED',
      )
      const archivedLatest = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'run',
        name: ARTIFACT_NAME,
        args: { text: 'x' },
      })
      check(
        'archive:latestRunRejected',
        archivedLatest.sdkValue?.ok === false && archivedLatest.sdkValue?.error?.code === 'PROGRAM_ARCHIVED',
      )
      const archivedGet = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'get',
        name: ARTIFACT_NAME,
        revision: 1,
      })
      check(
        'archive:historyReadable',
        archivedGet.sdkValue?.ok === true && archivedGet.sdkValue?.version?.revision === 1,
      )
      const listDefault = await invokeSdk('standard', standardAgent, toolSet, { action: 'list' })
      const listAll = await invokeSdk('standard', standardAgent, toolSet, { action: 'list', includeArchived: true })
      check(
        'archive:listHidden',
        !(listDefault.sdkValue?.artifacts ?? []).some((entry) => entry.name === ARTIFACT_NAME),
      )
      check(
        'archive:listIncludeArchived',
        (listAll.sdkValue?.artifacts ?? []).some((entry) => entry.name === ARTIFACT_NAME),
      )
      const saveArchived = await invokeSdk('standard', standardAgent, toolSet, {
        action: 'save',
        name: ARTIFACT_NAME,
        description: 'Probe archived revision.',
        parameters: SCHEMA_V1,
        code: CODE_V1,
        expectedRevision: 2,
      })
      check(
        'archive:revisionRefused',
        saveArchived.sdkValue?.ok === false && saveArchived.sdkValue?.error?.code === 'PROGRAM_ARCHIVED',
      )
    } finally {
      toolSet.dispose()
    }
  }

  /* ---------------------------------------------------- explicit restrict */

  const restrictAgent = await createAgent('standard')
  if (restrictAgent !== undefined) {
    const unregisterRestriction = restrictAgent.ctx.tools.restrict({ deny: [ECHO_TOOL_NAME] })
    const toolSet = await resolveToolSet(restrictAgent)
    try {
      check('restrict:toolHidden', toolSet.view(restrictAgent).has(ECHO_TOOL_NAME) === false)
      check('restrict:ptcSdkStillVisible', toolSet.view(restrictAgent).has(SDK_TOOL_NAME) === true)
      const direct = await executeCall(restrictAgent, toolSet, ECHO_TOOL_NAME, { label: 'direct-blocked' })
      check('restrict:directCallBlocked', direct.isError === true)
      const discover = await invokeSdk('standard', restrictAgent, toolSet, {
        action: 'discover',
        toolNames: [ECHO_TOOL_NAME],
      })
      check(
        'restrict:discoverMissing',
        Array.isArray(discover.sdkValue?.missing) && discover.sdkValue.missing.includes(ECHO_TOOL_NAME),
      )
      const echoBeforeBypass = echoCalls.length
      const bypass = await invokeSdk('standard', restrictAgent, toolSet, {
        action: 'test',
        code: `const echo = await tools.${ECHO_TOOL_NAME}({ label: 'bypass' });\nreturn { ok: true };`,
        parameters: { type: 'object' },
      })
      check(
        'restrict:nestedCannotBypass',
        bypass.sdkValue?.ok === false && bypass.sdkValue?.error?.code === 'PROGRAM_FAILED',
      )
      check('restrict:noSideEffect', echoCalls.length === echoBeforeBypass)
    } finally {
      toolSet.dispose()
      unregisterRestriction?.()
    }
  }

  /* ---------------------------------------------- dispose / clean shutdown */

  result.shutdown.toolRegisteredBefore = readToolNames(toolsServiceRef.current)?.includes(SDK_TOOL_NAME) === true
  check('shutdown:toolRegisteredBefore', result.shutdown.toolRegisteredBefore)

  const blockerAgent = await createAgent('standard')
  let blockingCall
  let blockingToolSet
  if (blockerAgent !== undefined) {
    blockingToolSet = await resolveToolSet(blockerAgent)
    blockingCall = invokeSdk('standard', blockerAgent, blockingToolSet, {
      action: 'test',
      code: [
        `const echo = await tools.${ECHO_TOOL_NAME}({ label: 'block' });`,
        'return { ok: echo !== undefined };',
      ].join('\n'),
      parameters: { type: 'object' },
    })
    const started = await settleWithin(blockStarted, 15_000)
    check('shutdown:blockingProgramStarted', started === true)
  }

  const preShutdownFailures = Object.values(result.checks).filter((value) => value !== true).length
  const shutdownExitCode = preShutdownFailures === 0 ? 0 : 1
  result.shutdown.requested = true
  try {
    await application.shutdown.shutdown(shutdownExitCode)
    result.shutdown.clean = true
  } catch (error) {
    result.shutdown.clean = false
    logLines.push(`# shutdown failed: ${sanitize(error?.message ?? error)}`)
  }
  shutdownRequested = true
  result.shutdown.exitCode = shutdownExitCode

  const settled = blockingCall === undefined
    ? true
    : await settleWithin(blockingCall.then(() => true, () => true), 10_000)
  result.shutdown.activeProgramSettled = settled === true
  check('shutdown:activeProgramSettled', result.shutdown.activeProgramSettled)
  result.shutdown.activeProgramAborted = blockedAborted === true
  check('shutdown:activeProgramAborted', result.shutdown.activeProgramAborted)
  const namesAfter = readToolNames(toolsServiceRef.current)
  result.shutdown.toolUnregisteredAfter = Array.isArray(namesAfter) && !namesAfter.includes(SDK_TOOL_NAME)
  check('shutdown:toolUnregistered', result.shutdown.toolUnregisteredAfter)
  try {
    // Every plugin runtime is gone once the tree is disposed; the root context
    // itself is not a registered runtime, so an empty registry is quiescence.
    result.shutdown.fiberDisposed = application?.ctx?.registry?.size === 0
  } catch {
    result.shutdown.fiberDisposed = false
  }
  check('shutdown:fiberDisposed', result.shutdown.fiberDisposed)
  // The watchdog is the probe's own timer: stop it before auditing leftovers.
  clearTimeout(watchdog)
  watchdog = undefined
  const resources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : []
  result.shutdown.leftoverTimers = resources.filter((name) => name === 'Timeout' || name === 'Immediate').length
  check('shutdown:noLeftoverTimers', result.shutdown.leftoverTimers === 0)
  try {
    blockingToolSet?.dispose()
  } catch {
    // The set is already closed by Agent teardown; a repeated close is a no-op.
  }
} catch (error) {
  check('probe:completed', false)
  logLines.push(`# probe error: ${sanitize(error?.name ?? 'Error')}: ${sanitize(error?.message ?? String(error))}`)
} finally {
  clearTimeout(watchdog)
  if (application !== undefined && shutdownRequested === false) {
    result.shutdown.requested = true
    try {
      await application.shutdown.shutdown(result.summary.failed > 0 ? 1 : 0)
      result.shutdown.clean = true
    } catch (error) {
      result.shutdown.clean = false
      logLines.push(`# shutdown failed: ${sanitize(error?.message ?? error)}`)
    }
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    result.tempCleanup = 'removed'
  } catch {
    result.tempCleanup = 'failed'
  }
  writeArtifacts()
  process.exitCode = result.ok ? 0 : 1
  console.log(
    `RC1_RESULT ${JSON.stringify({
      ok: result.ok,
      summary: result.summary,
      cleanShutdown: result.shutdown.clean,
      resultPath: 'artifacts/rc1-result.json',
    })}`,
  )
}
