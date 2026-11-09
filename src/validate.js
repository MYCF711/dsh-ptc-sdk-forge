/**
 * Static validation for `ptc_sdk` programs.
 *
 * Nothing in this module executes a program. Program source is TypeScript in the
 * official PTC `function-body` flavor: `node:module`'s `stripTypeScriptTypes`
 * erases the type-only syntax in strip-only mode, and the resulting JavaScript is
 * compiled as the body of an async function with `new vm.Script`. Syntax errors —
 * including non-erasable TypeScript such as an `enum`, a namespace or a
 * parameter property — surface while not a single statement runs, so a compile
 * can never observe a program's side effects.
 *
 * The compiled wrapper is an async function expression — the same shape as the
 * official `function-body` flavor — and declares the runtime's reserved `args`
 * binding ({@link ARGS_PRELUDE}) plus a compile-only {@link JSON_GUARD} before
 * the program body. A program that redeclares `args` or `JSON` at the top level
 * with `const`, `let`, `var`, `class`, `function` or a destructuring pattern is
 * therefore rejected statically instead of failing only when the program runs.
 * The runtime prelude itself is unchanged: `JSON` is a documented reserved name,
 * not a binding the runtime injects.
 *
 * JSON Schema checks reuse the enforced subset from the official
 * `@deepseek-ai/dsh-tools` package, so an artifact can only declare keywords the
 * host tool pipeline is actually able to enforce. Parameter schemas are bounded
 * by serialized size and by nesting depth, and the depth/cycle walk is iterative,
 * so a hostile or accidental multi-megabyte, thousand-level schema is a
 * violation instead of a multi-megabyte artifact or a stack overflow.
 *
 * @module dsh-ptc-sdk-forge/validate
 */
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

import {
  JsonSchemaError,
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  isPlainJsonRecord,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'

/** Stable identity pattern for an artifact name; also the on-disk file stem. */
export const NAME_PATTERN_SOURCE = '^[a-z][a-z0-9-]{0,63}$'

/** Compiled form of {@link NAME_PATTERN_SOURCE}. */
export const NAME_PATTERN = new RegExp(NAME_PATTERN_SOURCE)

/** Tool names a program may declare in `requiredTools`. */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/

/** Reserved program binding the runtime declares before the program body. */
export const ARGS_BINDING_NAME = 'args'

/**
 * Static counterpart of the runtime's reserved `args` prelude.
 *
 * The binding name and the declaration kind (`const`) must stay identical to the
 * prelude `runtime.js` prepends to every program; redeclaring the binding is
 * therefore rejected here for exactly the same programs the runtime rejects.
 */
export const ARGS_PRELUDE = `const ${ARGS_BINDING_NAME} = JSON.parse("{}");`

/** Global a program may not shadow at the top level of its body. */
export const JSON_BINDING_NAME = 'JSON'

/**
 * Compile-only guard pinning `JSON` to the canonical implementation.
 *
 * It is declared before {@link ARGS_PRELUDE} so a program that redeclares `JSON`
 * at the top level — including through a destructuring pattern — is a static
 * syntax error instead of a silently different serializer. Reading `JSON`, or
 * shadowing it inside a nested function or block, stays legal.
 */
export const JSON_GUARD = `const ${JSON_BINDING_NAME} = globalThis.${JSON_BINDING_NAME};`

/**
 * Hard bounds that keep the library from becoming an unbounded blob store.
 * They are shared with the artifact store, so a definition accepted here can
 * always be persisted and re-read.
 */
export const LIMITS = Object.freeze({
  maxPrograms: 256,
  maxVersions: 32,
  maxCodeBytes: 64 * 1024,
  maxDescriptionChars: 2000,
  maxChangeNoteChars: 500,
  maxNameChars: 64,
  maxRequiredTools: 64,
  maxParametersBytes: 64 * 1024,
  maxParametersDepth: 64,
  maxArtifactBytes: 4 * 1024 * 1024,
})

/** Device names Windows resolves before the file system, extension included. */
const REJECTED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((digit) => [`com${digit}`, `lpt${digit}`]),
])

/** File name handed to the compiler so diagnostics name the program, not this module. */
const STATIC_COMPILE_FILENAME = 'ptc-program.js'

/** Raised when a name cannot be used as a filesystem-safe artifact identity. */
export class ProgramNameError extends Error {
  /**
   * @param {unknown} name - the rejected identity.
   * @param {string} description - why it was rejected.
   */
  constructor(name, description) {
    super(`invalid program name (${quoteForMessage(name)}): ${description}`)
    this.name = 'ProgramNameError'
    this.code = 'INVALID_PROGRAM_NAME'
  }
}

/**
 * Assert that `name` is a canonical kebab-case identity.
 * @param {unknown} name - candidate identity.
 * @returns {string} the same name, when valid.
 * @throws {ProgramNameError} when the name is not a filesystem-safe identity.
 */
export function assertValidName(name) {
  const rejection = describeNameRejection(name)
  if (rejection !== undefined) throw new ProgramNameError(name, rejection)
  return name
}

/**
 * Validate a program definition without touching the filesystem or running code.
 *
 * `availableTools` is optional and only produces warnings: a tool that this
 * caller cannot see may still be visible to another Agent mode, so visibility is
 * never an authorship error.
 *
 * @param {unknown} input - candidate definition.
 * @param {{ availableTools?: string[] }} [options] - caller-visible tool names.
 * @returns {{ ok: boolean, violations: string[], warnings: string[], normalized: object | null }}
 */
export function validateProgramDefinition(input, options = {}) {
  const violations = []
  const warnings = []
  const normalized = {}

  if (!isPlainJsonRecord(input)) {
    return {
      ok: false,
      violations: ['definition: program definition must be a JSON object'],
      warnings,
      normalized: null,
    }
  }

  const nameRejection = describeNameRejection(input.name)
  if (nameRejection !== undefined) violations.push(`name: ${nameRejection}`)
  else normalized.name = input.name

  const description = normalizeDescription(input.description, violations)
  if (description !== undefined) normalized.description = description

  const parameters = normalizeParameters(input.parameters, violations)
  if (parameters !== undefined) normalized.parameters = parameters

  const code = normalizeCode(input.code, violations)
  if (code !== undefined) normalized.code = code

  const changeNote = normalizeChangeNote(input.changeNote, violations)
  if (changeNote !== undefined) normalized.changeNote = changeNote

  if (input.requiredTools === undefined || input.requiredTools === null) {
    normalized.requiredTools = []
  } else {
    const requiredTools = normalizeRequiredTools(input.requiredTools, violations)
    if (requiredTools !== undefined) normalized.requiredTools = requiredTools
  }

  const availableTools = options === undefined || options === null ? undefined : options.availableTools
  if (availableTools !== undefined && availableTools !== null) {
    if (!Array.isArray(availableTools)) throw new TypeError('availableTools must be an array of tool names')
    const visible = new Set(availableTools.filter((entry) => typeof entry === 'string'))
    for (const tool of normalized.requiredTools ?? []) {
      if (!visible.has(tool)) warnings.push(`requiredTools: "${tool}" is not available to this caller`)
    }
  }

  return { ok: violations.length === 0, violations, warnings, normalized }
}

/**
 * Validate call arguments against a version's own `parameters` schema.
 * @param {unknown} parameters - object-rooted schema from the chosen revision.
 * @param {unknown} args - caller-supplied arguments.
 * @returns {string[]} path-qualified violations; an empty array means valid.
 */
export function validateProgramArgs(parameters, args) {
  const schemaViolations = parametersSchemaViolations(parameters)
  if (schemaViolations.length > 0) return schemaViolations.map((violation) => `parameters: ${violation}`)
  return validateJsonSchemaValue(parameters, args, 'args')
}

/**
 * Assert that a parameter schema is supported by the host pipeline and rooted at
 * an object. Shared with the artifact store so a stored revision snapshot is held
 * to exactly the same subset as a new definition.
 *
 * The structural walk runs first, before the official subset validator and
 * before `JSON.stringify`: both of those recurse, so a deeply nested or cyclic
 * schema would otherwise surface as `RangeError: Maximum call stack size
 * exceeded` instead of a violation. Size is checked next, so the byte bound also
 * covers schemas that are wide rather than deep.
 *
 * @param {unknown} parameters - candidate schema.
 * @returns {void}
 * @throws {JsonSchemaError} when the schema falls outside the enforced subset, is
 *   not object-rooted, is cyclic, or exceeds {@link LIMITS.maxParametersBytes}
 *   serialized / {@link LIMITS.maxParametersDepth} levels deep.
 */
export function assertSupportedParametersSchema(parameters) {
  const structureViolation = parametersStructureViolation(parameters)
  if (structureViolation !== undefined) throw new JsonSchemaError([structureViolation])
  const sizeViolation = parametersSizeViolation(parameters)
  if (sizeViolation !== undefined) throw new JsonSchemaError([sizeViolation])
  assertSupportedJsonSchema(parameters)
  assertObjectJsonSchema(parameters)
}

/**
 * Walk a parameter schema with an explicit stack, reporting a cycle or a
 * document that nests deeper than {@link LIMITS.maxParametersDepth}.
 *
 * No recursion and no serialization happen here, so the check is safe on a
 * hostile graph: it returns a violation instead of overflowing the stack. A
 * repeated object reference cannot appear in JSON, so it is reported as circular
 * and the walk stays linear.
 *
 * @param {unknown} parameters - candidate schema.
 * @returns {string | undefined} the `schema.<path>` violation detail, or
 *   `undefined` when the value is a bounded tree.
 */
function parametersStructureViolation(parameters) {
  const stack = [{ value: parameters, depth: 1, path: 'schema' }]
  const seen = new Set()
  while (stack.length > 0) {
    const { value, depth, path } = stack.pop()
    if (value === null || typeof value !== 'object') continue
    if (seen.has(value)) return `${path} is circular`
    seen.add(value)
    if (depth > LIMITS.maxParametersDepth) {
      return `schema must be at most ${LIMITS.maxParametersDepth} levels deep (received ${depth})`
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: depth + 1, path: `${path}[${index}]` })
      }
      continue
    }
    for (const key of Object.keys(value)) {
      stack.push({ value: value[key], depth: depth + 1, path: `${path}.${key}` })
    }
  }
  return undefined
}

/**
 * Compare a parameter schema's compact serialized size against the byte bound.
 *
 * Only reached for a bounded, acyclic tree; a value that still cannot be
 * serialized (a throwing getter, a BigInt) falls through to the subset validator,
 * which names it as a schema-shape violation.
 *
 * @param {unknown} parameters - candidate schema.
 * @returns {string | undefined} the violation detail, or `undefined` when the
 *   schema is absent, unserializable or within the bound.
 */
function parametersSizeViolation(parameters) {
  let text
  try {
    text = JSON.stringify(parameters)
  } catch {
    return undefined
  }
  if (typeof text !== 'string') return undefined
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= LIMITS.maxParametersBytes) return undefined
  return `schema must be at most ${LIMITS.maxParametersBytes} bytes when serialized (received ${bytes} bytes)`
}

/**
 * Check the enforced JSON Schema subset, then the object-root constraint.
 * Reporting the subset first means a malformed keyword is named once instead of
 * being hidden behind a secondary root-type message.
 * @param {unknown} parameters - candidate parameter schema.
 * @returns {string[]} violations in walk order; empty means supported and object-rooted.
 */
function parametersSchemaViolations(parameters) {
  try {
    assertSupportedParametersSchema(parameters)
    return []
  } catch (error) {
    if (error instanceof JsonSchemaError) return [...error.violations]
    throw error
  }
}

/**
 * Normalize a required property into its stored form.
 * @param {unknown} value - raw description.
 * @param {string[]} violations - collector.
 * @returns {string | undefined} trimmed description, or `undefined` when rejected.
 */
function normalizeDescription(value, violations) {
  if (typeof value !== 'string') {
    violations.push('description: must be a string')
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    violations.push('description: must not be empty')
    return undefined
  }
  if (exceedsCharacterLimit(trimmed, LIMITS.maxDescriptionChars)) {
    violations.push(`description: must be at most ${LIMITS.maxDescriptionChars} characters`)
    return undefined
  }
  return trimmed
}

/**
 * Normalize the parameter schema into a detached canonical JSON value.
 * @param {unknown} value - raw `parameters`.
 * @param {string[]} violations - collector.
 * @returns {object | undefined} cloned schema, or `undefined` when rejected.
 */
function normalizeParameters(value, violations) {
  if (value === undefined || value === null) {
    violations.push('parameters: must be an object JSON schema (type "object")')
    return undefined
  }
  const schemaViolations = parametersSchemaViolations(value)
  if (schemaViolations.length > 0) {
    for (const violation of schemaViolations) violations.push(`parameters: ${violation}`)
    return undefined
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    violations.push('parameters: must be lossless JSON')
    return undefined
  }
}

/**
 * Normalize program source after size and static syntax checks.
 * @param {unknown} value - raw source.
 * @param {string[]} violations - collector.
 * @returns {string | undefined} unchanged source, or `undefined` when rejected.
 */
function normalizeCode(value, violations) {
  if (typeof value !== 'string') {
    violations.push('code: must be a string')
    return undefined
  }
  if (value.trim().length === 0) {
    violations.push('code: must not be empty')
    return undefined
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > LIMITS.maxCodeBytes) {
    violations.push(`code: must be at most ${LIMITS.maxCodeBytes} bytes (received ${bytes})`)
    return undefined
  }
  const syntaxProblem = staticSyntaxProblem(value)
  if (syntaxProblem !== undefined) {
    violations.push(`code: ${syntaxProblem}`)
    return undefined
  }
  return value
}

/**
 * Normalize an optional short change note.
 * @param {unknown} value - raw note.
 * @param {string[]} violations - collector.
 * @returns {string | undefined} trimmed note, or `undefined` when absent or rejected.
 */
function normalizeChangeNote(value, violations) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    violations.push('changeNote: must be a string')
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (exceedsCharacterLimit(trimmed, LIMITS.maxChangeNoteChars)) {
    violations.push(`changeNote: must be at most ${LIMITS.maxChangeNoteChars} characters`)
    return undefined
  }
  return trimmed
}

/**
 * Normalize the optional declared tool dependencies.
 * @param {unknown} value - raw `requiredTools`.
 * @param {string[]} violations - collector.
 * @returns {string[] | undefined} sorted, de-duplicated names, or `undefined` when rejected.
 */
function normalizeRequiredTools(value, violations) {
  if (!Array.isArray(value)) {
    violations.push('requiredTools: must be an array of tool names')
    return undefined
  }
  if (value.length > LIMITS.maxRequiredTools) {
    violations.push(`requiredTools: must contain at most ${LIMITS.maxRequiredTools} entries`)
    return undefined
  }
  const names = []
  let valid = true
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      violations.push(`requiredTools[${index}]: must be a string tool name`)
      valid = false
      continue
    }
    if (!TOOL_NAME_PATTERN.test(entry)) {
      violations.push(`requiredTools[${index}]: ${quoteForMessage(entry)} is not a valid tool name`)
      valid = false
      continue
    }
    names.push(entry)
  }
  return valid ? [...new Set(names)].sort() : undefined
}

/** Matches the compiler diagnostic for a redeclared reserved binding. */
const REDECLARATION_PATTERN = /Identifier '([^']+)' has already been declared/

/** Why each compile-only reserved binding exists, keyed by its identifier. */
const RESERVED_BINDING_DESCRIPTIONS = new Map([
  [ARGS_BINDING_NAME, 'is reserved for the program arguments'],
  [JSON_BINDING_NAME, 'is reserved for canonical JSON serialization'],
])

/**
 * Compile program source as an async function body without running it.
 *
 * The source is TypeScript, so it is first erased in strip-only mode — the same
 * flavor the official PTC runtime executes — and only then compiled. Stripping is
 * a pure transform: it parses and rewrites, it never evaluates. Compiling the
 * result with `new vm.Script` runs no statements either, so a program that
 * throws or loops forever still validates.
 *
 * The wrapper is an async function expression, exactly the shape of the runtime's
 * `function-body` flavor, so `new.target`, `arguments` and `this` compile here
 * for the same reason they compile there. It declares the compile-only
 * {@link JSON_GUARD} and then the runtime prelude ({@link ARGS_PRELUDE}) in the
 * same function-body scope as the program, which makes a top-level
 * `const`/`let`/`var`/`class`/`function`/destructuring declaration of `args` or
 * `JSON` a compile-time error.
 *
 * @param {string} code - program body.
 * @returns {string | undefined} a diagnostic, or `undefined` when the body compiles.
 */
function staticSyntaxProblem(code) {
  const wrapped = `(async function () {\n${JSON_GUARD}\n${ARGS_PRELUDE}\n${code}\n})`

  let stripped
  try {
    stripped = stripTypeScriptTypes(wrapped, { mode: 'strip' })
  } catch (error) {
    return describeTypeScriptRejection(error)
  }

  try {
    new vm.Script(stripped, { filename: STATIC_COMPILE_FILENAME })
    return undefined
  } catch (error) {
    return describeCompileRejection(error)
  }
}

/**
 * Describe a type-stripping failure.
 *
 * A non-erasable construct (`enum`, namespace, parameter property, `import` or
 * `export` statement, `with`) is named as such: the program body may only use
 * the TypeScript syntax the runtime's strip-only compiler can erase.
 *
 * @param {unknown} error - the value `stripTypeScriptTypes` threw.
 * @returns {string} a `code:` violation detail.
 */
function describeTypeScriptRejection(error) {
  const summary = summarizeCompileError(error)
  if (error?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return `static syntax check failed: ${summary} — PTC programs are TypeScript function bodies and may only use erasable syntax`
  }
  return `static syntax check failed: ${summary}`
}

/**
 * Describe a JavaScript compilation failure, naming a reserved-binding collision.
 * @param {unknown} error - the value `new vm.Script` threw.
 * @returns {string} a `code:` violation detail.
 */
function describeCompileRejection(error) {
  const summary = summarizeCompileError(error)
  const redeclared = REDECLARATION_PATTERN.exec(summary)?.[1]
  const description = redeclared === undefined ? undefined : RESERVED_BINDING_DESCRIPTIONS.get(redeclared)
  if (description !== undefined) {
    return `static syntax check failed: ${summary} — "${redeclared}" ${description}`
  }
  return `static syntax check failed: ${summary}`
}

/**
 * Render `Name: first line` for a compile diagnostic.
 * @param {unknown} error - thrown compiler value.
 * @returns {string} the diagnostic summary.
 */
function summarizeCompileError(error) {
  const name = error instanceof Error && typeof error.name === 'string' && error.name.length > 0
    ? error.name
    : 'SyntaxError'
  const message = error instanceof Error ? error.message : String(error)
  const detail = message.split('\n')[0].trim()
  return detail.length === 0 ? name : `${name}: ${detail}`
}

/**
 * Describe why a name is unusable, or `undefined` when it is canonical.
 * @param {unknown} name - candidate identity.
 * @returns {string | undefined} rejection detail.
 */
function describeNameRejection(name) {
  const expectation = `must match ${NAME_PATTERN_SOURCE}`
  if (typeof name !== 'string') return `${expectation} — must be a string`
  if (name.length === 0) return `${expectation} — must not be empty`
  if (REJECTED_DEVICE_NAMES.has(name.toLowerCase())) return `${expectation} — Windows device names are not allowed`
  if (NAME_PATTERN.test(name)) return undefined
  if (name.includes('/') || name.includes('\\')) return `${expectation} — path separators are not allowed`
  if (name.includes('..')) return `${expectation} — ".." is not allowed`
  if (name.startsWith('.')) return `${expectation} — hidden names are not allowed`
  if (exceedsCharacterLimit(name, LIMITS.maxNameChars)) return `${expectation} — must be at most ${LIMITS.maxNameChars} characters`
  return expectation
}

/**
 * Test a character limit without materializing the string's code points.
 * @param {string} text - candidate text.
 * @param {number} limit - maximum accepted code points.
 * @returns {boolean} whether the text is longer than the limit.
 */
export function exceedsCharacterLimit(text, limit) {
  let count = 0
  for (const _character of text) {
    count += 1
    if (count > limit) return true
  }
  return false
}

/**
 * Quote a short, escaped preview of an untrusted value for a diagnostic.
 * @param {unknown} value - rejected value.
 * @param {number} [limit] - maximum rendered characters.
 * @returns {string} safe diagnostic rendering.
 */
function quoteForMessage(value, limit = 60) {
  if (typeof value !== 'string') return typeof value
  const preview = exceedsCharacterLimit(value, limit) ? `${value.slice(0, limit)}…` : value
  return JSON.stringify(preview)
}
