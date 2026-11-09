import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { JsonSchemaError } from '@deepseek-ai/dsh-tools'

import {
  ARGS_BINDING_NAME,
  ARGS_PRELUDE,
  JSON_BINDING_NAME,
  JSON_GUARD,
  LIMITS,
  ProgramNameError,
  assertSupportedParametersSchema,
  assertValidName,
  validateProgramArgs,
  validateProgramDefinition,
} from '../src/validate.js'

const NAME_PATTERN_HINT = /must match \^\[a-z\]\[a-z0-9-\]\{0,63\}\$/

const PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Search expression.' },
    limit: { type: 'integer' },
  },
  required: ['pattern'],
  additionalProperties: false,
})

const VALID_CODE = 'const matches = await tools.grep({ pattern: args.pattern });\nreturn { matches };'

function definition(overrides = {}) {
  return {
    name: 'repo-evidence-pack',
    description: 'Collect and rank repository evidence.',
    parameters: structuredClone(PARAMETERS),
    code: VALID_CODE,
    ...overrides,
  }
}

function violationsOf(result) {
  return result.violations.join('\n')
}

/**
 * Build a supported, object-rooted schema whose compact serialization is exactly
 * `target` UTF-8 bytes, so the byte bound can be tested on both sides of it.
 * @param {number} target - serialized byte count.
 * @returns {object} the padded schema.
 */
function schemaWithSerializedBytes(target) {
  const schema = { type: 'object', properties: { pattern: { type: 'string', description: '' } } }
  const baseBytes = Buffer.byteLength(JSON.stringify(schema))
  schema.properties.pattern.description = 'x'.repeat(target - baseBytes)
  assert.equal(Buffer.byteLength(JSON.stringify(schema)), target)
  return schema
}

/**
 * Count nested JSON object/array levels, root included. Safe for the small
 * depths used here (the implementation under test is the iterative one).
 * @param {unknown} value - JSON value.
 * @param {number} [depth] - levels above `value`.
 * @returns {number} nesting depth.
 */
function depthOf(value, depth = 0) {
  if (value === null || typeof value !== 'object') return depth
  let deepest = depth + 1
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    deepest = Math.max(deepest, depthOf(child, depth + 1))
  }
  return deepest
}

/**
 * Build a valid, object-rooted parameter schema exactly `target` levels deep.
 * @param {number} target - even depth of at least 3.
 * @returns {object} the nested schema.
 */
function schemaOfDepth(target) {
  let inner = { type: 'string' }
  for (let depth = 1; depth < target - 2; depth += 1) inner = { type: 'array', items: inner }
  const schema = { type: 'object', properties: { child: inner } }
  assert.equal(depthOf(schema), target)
  return schema
}

/* ------------------------------------------------------------------ names */

test('assertValidName accepts canonical kebab-case identities', () => {
  for (const name of ['a', 'ab', 'repo-evidence-pack', 'a1', 'x-0-9', 'a'.repeat(64)]) {
    assert.equal(assertValidName(name), name)
  }
})

test('assertValidName rejects path shapes, device names and non-identities', () => {
  const rejected = [
    '',
    ' ',
    ' a',
    'a ',
    'A',
    'UPPER-CASE',
    '1abc',
    '-abc',
    'a_b',
    'a b',
    'a.b',
    'a/b',
    'a\\b',
    '../escape',
    '..',
    '.hidden',
    '/absolute',
    'C:/windows/temp',
    'con',
    'nul',
    'com1',
    'lpt9',
    'naïve',
    'a\n',
    'a\u0000b',
    'a'.repeat(65),
  ]

  for (const name of rejected) {
    assert.throws(
      () => assertValidName(name),
      (error) => {
        assert.ok(error instanceof ProgramNameError, `${JSON.stringify(name)} must raise ProgramNameError`)
        assert.equal(error.code, 'INVALID_PROGRAM_NAME')
        assert.ok(error.message.includes('program name'), error.message)
        return true
      },
      `expected ${JSON.stringify(name)} to be rejected`,
    )
  }

  assert.throws(() => assertValidName('./x'), { code: 'INVALID_PROGRAM_NAME' })
  assert.throws(() => assertValidName('.hidden'), NAME_PATTERN_HINT)
  assert.throws(() => assertValidName(42), /must be a string/)
  assert.throws(() => assertValidName(null), /must be a string/)
})

/* ------------------------------------------------------------- definition */

test('validateProgramDefinition accepts a canonical definition and normalizes it', () => {
  const result = validateProgramDefinition(
    definition({
      name: '  repo-evidence-pack  '.trim(),
      description: '  Collect and rank repository evidence.  ',
      requiredTools: ['grep', 'read', 'grep'],
    }),
  )

  assert.equal(result.ok, true, violationsOf(result))
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.normalized, {
    name: 'repo-evidence-pack',
    description: 'Collect and rank repository evidence.',
    parameters: PARAMETERS,
    code: VALID_CODE,
    requiredTools: ['grep', 'read'],
  })
})

test('validateProgramDefinition rejects anything that is not a JSON object', () => {
  for (const input of [undefined, null, [], 'definition', 42, () => definition()]) {
    const result = validateProgramDefinition(input)
    assert.equal(result.ok, false)
    assert.equal(result.normalized, null)
    assert.equal(result.violations.length, 1)
    assert.match(result.violations[0], /must be a (JSON )?object/)
  }
})

test('validateProgramDefinition reports missing fields by path', () => {
  const result = validateProgramDefinition({})
  assert.equal(result.ok, false)
  const text = violationsOf(result)
  assert.match(text, /name:/)
  assert.match(text, /description:/)
  assert.match(text, /parameters:/)
  assert.match(text, /code:/)
  assert.equal(result.normalized.requiredTools.length, 0)
})

test('validateProgramDefinition ignores unknown extra fields', () => {
  const result = validateProgramDefinition(definition({ expectedRevision: 3, args: { pattern: 'x' }, pipeline: 'x' }))
  assert.equal(result.ok, true, violationsOf(result))
  assert.deepEqual(Object.keys(result.normalized).sort(), ['code', 'description', 'name', 'parameters', 'requiredTools'])
})

test('validateProgramDefinition bounds the description', () => {
  const empty = validateProgramDefinition(definition({ description: '   ' }))
  assert.match(violationsOf(empty), /description: must not be empty/)

  const missing = validateProgramDefinition(definition({ description: undefined }))
  assert.match(violationsOf(missing), /description: must be a string/)

  const typed = validateProgramDefinition(definition({ description: 7 }))
  assert.match(violationsOf(typed), /description: must be a string/)

  const oversized = validateProgramDefinition(definition({ description: '字'.repeat(LIMITS.maxDescriptionChars + 1) }))
  assert.equal(oversized.ok, false)
  assert.match(violationsOf(oversized), new RegExp(`description: must be at most ${LIMITS.maxDescriptionChars} characters`))

  const boundary = validateProgramDefinition(definition({ description: '字'.repeat(LIMITS.maxDescriptionChars) }))
  assert.equal(boundary.ok, true, violationsOf(boundary))
})

test('validateProgramDefinition requires an object-rooted schema from the enforced subset', () => {
  const scalarRoot = validateProgramDefinition(definition({ parameters: { type: 'string' } }))
  assert.equal(scalarRoot.ok, false)
  assert.match(violationsOf(scalarRoot), /schema\.type must be "object"/)

  const unsupported = validateProgramDefinition(
    definition({ parameters: { type: 'object', properties: { a: { type: 'string', minimum: 1 } } } }),
  )
  assert.equal(unsupported.ok, false)
  assert.match(violationsOf(unsupported), /minimum is not a supported keyword/)

  const undeclaredRequired = validateProgramDefinition(
    definition({ parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } }),
  )
  assert.equal(undeclaredRequired.ok, false)
  assert.match(violationsOf(undeclaredRequired), /required names "b"/)

  const sharedRef = { $ref: '#/definitions/x' }
  const refResult = validateProgramDefinition(
    definition({ parameters: { type: 'object', properties: { a: sharedRef } } }),
  )
  assert.equal(refResult.ok, false)
  assert.match(violationsOf(refResult), /\$ref is not a supported keyword/)

  for (const parameters of [null, undefined, [], 'schema', 5]) {
    const result = validateProgramDefinition(definition({ parameters }))
    assert.equal(result.ok, false, `expected ${JSON.stringify(parameters)} to be rejected`)
    assert.match(violationsOf(result), /parameters:/)
  }

  const minimal = validateProgramDefinition(definition({ parameters: { type: 'object' } }))
  assert.equal(minimal.ok, true, violationsOf(minimal))
})

test('validateProgramDefinition checks source size and static syntax without running it', () => {
  const empty = validateProgramDefinition(definition({ code: '   \n  ' }))
  assert.match(violationsOf(empty), /code: must not be empty/)

  const typed = validateProgramDefinition(definition({ code: 42 }))
  assert.match(violationsOf(typed), /code: must be a string/)

  const broken = validateProgramDefinition(definition({ code: 'return (' }))
  assert.equal(broken.ok, false)
  assert.match(violationsOf(broken), /code: static syntax check failed/)
  assert.match(violationsOf(broken), /SyntaxError/)

  const unbalanced = validateProgramDefinition(definition({ code: 'if (true) {\nreturn 1;' }))
  assert.equal(unbalanced.ok, false)
  assert.match(violationsOf(unbalanced), /static syntax check failed/)

  const esmImport = validateProgramDefinition(definition({ code: 'import value from "some-package";\nreturn value' }))
  assert.equal(esmImport.ok, false)
  assert.match(violationsOf(esmImport), /static syntax check failed/)

  const tiny = `// ${'x'.repeat(LIMITS.maxCodeBytes)}`
  const oversized = validateProgramDefinition(definition({ code: tiny }))
  assert.equal(oversized.ok, false)
  assert.match(violationsOf(oversized), new RegExp(`code: must be at most ${LIMITS.maxCodeBytes} bytes`))

  const boundary = `// ${'x'.repeat(LIMITS.maxCodeBytes - 3)}`
  const accepted = validateProgramDefinition(definition({ code: boundary }))
  assert.equal(accepted.ok, true, violationsOf(accepted))
  assert.equal(Buffer.byteLength(accepted.normalized.code, 'utf8'), LIMITS.maxCodeBytes)

  const expressive = validateProgramDefinition(
    definition({
      code: [
        'const seen = new Set();',
        'for (const item of args.pattern.split(",")) {',
        '  if (seen.has(item)) continue;',
        '  seen.add(item);',
        '}',
        'try {',
        '  const matches = await tools.grep({ pattern: args.pattern });',
        '  return { count: matches.length, seen: [...seen] };',
        '} finally {',
        '  return { seen: [...seen] };',
        '}',
      ].join('\n'),
    }),
  )
  assert.equal(expressive.ok, true, violationsOf(expressive))
})

test('validateProgramDefinition never executes the program body', () => {
  delete globalThis.__ptc_sdk_forge_executed__

  const probe = validateProgramDefinition(
    definition({ code: 'globalThis.__ptc_sdk_forge_executed__ = "yes";\nreturn { ok: true };' }),
  )
  assert.equal(probe.ok, true, violationsOf(probe))
  assert.equal(globalThis.__ptc_sdk_forge_executed__, undefined)

  const thrower = validateProgramDefinition(definition({ code: 'throw new Error("this body must never run")' }))
  assert.equal(thrower.ok, true, violationsOf(thrower))

  const hugeLoop = validateProgramDefinition(definition({ code: 'while (true) { }\nreturn 1;' }))
  assert.equal(hugeLoop.ok, true, violationsOf(hugeLoop))
})

/* ------------------------------------------------- TypeScript program bodies */

/** Erasable TypeScript the official `function-body` PTC flavor executes. */
const ERASABLE_TS_PROGRAMS = Object.freeze({
  'type annotations': 'const count: number = 2;\nconst label: string = `count=${count}`;\nreturn { label };',
  'interface declarations': 'interface Match { path: string; score: number }\nconst match: Match = { path: "a.ts", score: 1 };\nreturn match;',
  'type aliases and unions': 'type Mode = "fast" | "deep";\nconst mode: Mode = "fast";\nreturn { mode };',
  'as assertions': 'const value = { count: 1 } as { count: number };\nreturn value;',
  'chained as assertions': 'const text = "x" as unknown as string;\nreturn { text, length: text.length };',
  satisfies: 'const config = { retries: 2 } satisfies { retries: number };\nreturn config;',
  'generic functions': 'function identity<T>(value: T): T { return value; }\nreturn { value: identity<number>(1) };',
  'generic arrow functions': 'const first = <T,>(items: T[]): T => items[0];\nreturn { first: first([1, 2]) };',
  'non-null assertions': 'const box: { items: number[] } = { items: [1] };\nreturn { item: box.items[0]! };',
  'optional parameters': 'function greet(name?: string): string { return name ?? "anonymous"; }\nreturn { greeting: greet() };',
  'readonly tuples': 'const pair: readonly [number, string] = [1, "a"];\nreturn { pair };',
  'ambient declarations': 'declare const injected: number;\nreturn { hasArgs: typeof args === "object" };',
  'type-only imports': 'type Stats = import("node:fs").Stats;\nreturn { hasArgs: typeof args === "object" };',
  'abstract classes': 'abstract class Base { abstract name(): string }\nclass Impl extends Base { name(): string { return "impl"; } }\nreturn { name: new Impl().name() };',
  'overloaded functions': 'function parse(value: number): number;\nfunction parse(value: string): string;\nfunction parse(value: number | string) { return value; }\nreturn { value: parse(1) };',
  'this parameters': 'function withThis(this: { id: number }): number { return this.id; }\nreturn { id: withThis.call({ id: 3 }) };',
  'keyof and indexed access': 'type Keys = keyof { a: number };\nconst key: Keys = "a";\nreturn { key };',
  'conditional and infer types': 'type Element<T> = T extends (infer U)[] ? U : never;\nconst value: Element<number[]> = 1;\nreturn { value };',
  'private class members': 'class Counter { #value = 1; get value(): number { return this.#value; } }\nreturn { value: new Counter().value };',
  'annotated args access': 'const pattern: string = args.pattern;\nconst limit: number | undefined = args.limit;\nreturn { pattern, limit };',
})

test('validateProgramDefinition accepts erasable TypeScript function bodies unmodified', () => {
  for (const [label, code] of Object.entries(ERASABLE_TS_PROGRAMS)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, true, `${label}: ${violationsOf(result)}`)
    assert.deepEqual(result.violations, [], label)
    // Stored source keeps the TypeScript the author wrote; stripping happens per run.
    assert.equal(result.normalized.code, code, label)
  }
})

test('validateProgramDefinition rejects non-erasable TypeScript with a clear violation', () => {
  const nonErasable = {
    'enum declaration': ['enum Mode { Fast, Deep }\nreturn Mode.Fast;', /TypeScript enum is not supported in strip-only mode/],
    'const enum declaration': ['const enum Mode { Fast }\nreturn Mode.Fast;', /TypeScript enum is not supported in strip-only mode/],
    'namespace declaration': ['namespace Util { export const value = 1; }\nreturn Util.value;', /TypeScript namespace declaration is not supported in strip-only mode/],
    'legacy module declaration': ['module Legacy { export const value = 1; }\nreturn Legacy.value;', /TypeScript namespace declaration is not supported in strip-only mode/],
    'parameter property': ['class Config { constructor(private readonly name: string) {} }\nreturn new Config("x");', /TypeScript parameter property is not supported in strip-only mode/],
  }

  for (const [label, [code, pattern]] of Object.entries(nonErasable)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, false, label)
    const text = violationsOf(result)
    assert.match(text, /code: static syntax check failed/, label)
    assert.match(text, pattern, label)
    assert.match(text, /may only use erasable syntax/, `${label}: ${text}`)
    assert.equal('code' in result.normalized, false, label)
  }
})

test('validateProgramDefinition rejects module syntax and malformed TypeScript statically', () => {
  const rejected = {
    'import statement': ['import { readFile } from "node:fs/promises";\nreturn readFile;', /'import', and 'export' cannot be used outside of module code/],
    'export statement': ['export const value = 1;\nreturn value;', /'import', and 'export' cannot be used outside of module code/],
    'invalid type position': ['const value: = 1;\nreturn value;', /Unexpected token/],
    'with statement': ['with (args) { }\nreturn 1;', /'with' statement is not supported/],
  }

  for (const [label, [code, pattern]] of Object.entries(rejected)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, false, label)
    const text = violationsOf(result)
    assert.match(text, /code: static syntax check failed/, label)
    assert.match(text, pattern, label)
    assert.equal('code' in result.normalized, false, label)
  }
})

test('validateProgramDefinition strips types without evaluating the program', () => {
  delete globalThis.__ptc_sdk_forge_ts_executed__

  const annotated = validateProgramDefinition(
    definition({
      code: [
        'interface Probe { touched: string }',
        'const probe: Probe = { touched: "yes" };',
        'globalThis.__ptc_sdk_forge_ts_executed__ = probe.touched;',
        'return probe;',
      ].join('\n'),
    }),
  )
  assert.equal(annotated.ok, true, violationsOf(annotated))
  assert.equal(globalThis.__ptc_sdk_forge_ts_executed__, undefined)

  const thrower = validateProgramDefinition(
    definition({ code: 'const reason: string = "never";\nthrow new Error(reason);' }),
  )
  assert.equal(thrower.ok, true, violationsOf(thrower))

  const infinite = validateProgramDefinition(
    definition({ code: 'const forever: boolean = true;\nwhile (forever) { }\nreturn forever;' }),
  )
  assert.equal(infinite.ok, true, violationsOf(infinite))
})

/* ---------------------------------------------------------- reserved args */

test('static wrapper mirrors the runtime prelude and pins the JSON guard', async () => {
  assert.equal(ARGS_BINDING_NAME, 'args')
  assert.equal(ARGS_PRELUDE, 'const args = JSON.parse("{}");')
  assert.equal(JSON_BINDING_NAME, 'JSON')
  assert.equal(JSON_GUARD, 'const JSON = globalThis.JSON;')

  const runtime = await import('../src/runtime.js')
  assert.equal(runtime.ARGS_BINDING_NAME, ARGS_BINDING_NAME)

  const runtimeSource = await readFile(new URL('../src/runtime.js', import.meta.url), 'utf8')
  assert.ok(
    runtimeSource.includes('const ${ARGS_BINDING_NAME} = JSON.parse('),
    'runtime.js must build its prelude from the same reserved binding',
  )
  // The runtime prelude is unchanged: JSON is a documented reserved name, not an injected binding.
  assert.ok(!runtimeSource.includes('globalThis.JSON'), 'runtime.js must not inject the compile-only JSON guard')

  const validateSource = await readFile(new URL('../src/validate.js', import.meta.url), 'utf8')
  assert.ok(
    validateSource.includes('(async function () {\\n${JSON_GUARD}\\n${ARGS_PRELUDE}\\n${code}\\n})'),
    'validate.js must compile the program as an async function body behind the guard and the runtime prelude',
  )
})

test('validateProgramDefinition rejects every redeclaration of the reserved args binding', () => {
  const redeclarations = {
    const: 'const args = { pattern: "x" };\nreturn args;',
    let: 'let args = 1;\nreturn args;',
    var: 'var args = 1;\nreturn args;',
    class: 'class args {}\nreturn new args();',
    function: 'function args() {}\nreturn args;',
    'async function': 'async function args() {}\nreturn args;',
    'generator function': 'function* args() {}\nreturn args;',
  }

  for (const [label, code] of Object.entries(redeclarations)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, false, `${label} must be rejected`)
    const text = violationsOf(result)
    assert.match(text, /code: static syntax check failed/, label)
    assert.match(text, /Identifier 'args' has already been declared/, label)
    assert.match(text, /"args" is reserved for the program arguments/, label)
    assert.equal('code' in result.normalized, false, label)
  }
})

test('validateProgramDefinition allows reading and nested shadowing of args', () => {
  const accepted = {
    read: 'return { pattern: args.pattern };',
    destructure: 'const { pattern } = args;\nreturn { pattern };',
    'function parameter shadow': 'function pick(args) { return args; }\nreturn pick(1);',
    'block shadow': '{ const args = 1; }\nreturn args;',
    'type-only alias': 'type args = { pattern: string };\nreturn args;',
    'interface merge': 'interface args { pattern: string }\nreturn args;',
  }

  for (const [label, code] of Object.entries(accepted)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, true, `${label}: ${violationsOf(result)}`)
  }
})

test('validateProgramDefinition rejects every redeclaration of the reserved JSON binding', () => {
  const redeclarations = {
    const: 'const JSON = { parse: () => ({}) };\nreturn JSON;',
    let: 'let JSON = 1;\nreturn JSON;',
    var: 'var JSON = 1;\nreturn JSON;',
    class: 'class JSON {}\nreturn new JSON();',
    function: 'function JSON() {}\nreturn JSON;',
    'async function': 'async function JSON() {}\nreturn JSON;',
    'object destructuring': 'const { JSON } = globalThis;\nreturn JSON;',
    'array destructuring': 'const [JSON] = [1];\nreturn JSON;',
  }

  for (const [label, code] of Object.entries(redeclarations)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, false, `${label} must be rejected`)
    const text = violationsOf(result)
    assert.match(text, /code: static syntax check failed/, label)
    assert.match(text, /Identifier 'JSON' has already been declared/, label)
    assert.match(text, /"JSON" is reserved for canonical JSON serialization/, label)
    assert.equal('code' in result.normalized, false, label)
  }
})

test('validateProgramDefinition still allows reading and nested shadowing of JSON', () => {
  const accepted = {
    'global read': 'return { text: JSON.stringify({ a: 1 }) };',
    'parse read': 'return JSON.parse("{}");',
    'function parameter shadow': 'function encode(JSON) { return JSON; }\nreturn encode(1);',
    'block shadow': '{ const JSON = 1; }\nreturn JSON.stringify([1]);',
    'arrow local shadow': 'const encode = (JSON) => JSON;\nreturn encode(1);',
    'type-only alias': 'type JSON = { x: number };\nreturn JSON.stringify(1);',
    'interface merge': 'interface JSON { x: number }\nreturn JSON.stringify(1);',
  }

  for (const [label, code] of Object.entries(accepted)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, true, `${label}: ${violationsOf(result)}`)
  }
})

test('the static wrapper is an async function body, so function-only syntax compiles', () => {
  const accepted = {
    'new.target': 'return { target: typeof new.target };',
    arguments: 'return { count: arguments.length };',
    this: 'return { kind: typeof this };',
    'return + await + new.target': 'const value: number = await Promise.resolve(1);\nreturn { value, target: new.target };',
  }

  for (const [label, code] of Object.entries(accepted)) {
    const result = validateProgramDefinition(definition({ code }))
    assert.equal(result.ok, true, `${label}: ${violationsOf(result)}`)
  }
})

/* ------------------------------------------------------- parameter schema */

test('LIMITS exposes the parameter and artifact byte bounds', () => {
  assert.equal(LIMITS.maxParametersBytes, 64 * 1024)
  assert.equal(LIMITS.maxParametersDepth, 64)
  assert.equal(LIMITS.maxArtifactBytes, 4 * 1024 * 1024)
  assert.ok(Object.isFrozen(LIMITS))
  assert.ok(LIMITS.maxArtifactBytes > LIMITS.maxParametersBytes)
})

test('validateProgramDefinition bounds the serialized parameter schema', () => {
  const boundary = validateProgramDefinition(
    definition({ parameters: schemaWithSerializedBytes(LIMITS.maxParametersBytes) }),
  )
  assert.equal(boundary.ok, true, violationsOf(boundary))
  assert.equal(Buffer.byteLength(JSON.stringify(boundary.normalized.parameters), 'utf8'), LIMITS.maxParametersBytes)

  const oversizedBytes = LIMITS.maxParametersBytes + 1
  const oversized = validateProgramDefinition(
    definition({ parameters: schemaWithSerializedBytes(oversizedBytes) }),
  )
  assert.equal(oversized.ok, false)
  assert.match(
    violationsOf(oversized),
    new RegExp(
      `parameters: schema must be at most ${LIMITS.maxParametersBytes} bytes when serialized \\(received ${oversizedBytes} bytes\\)`,
    ),
  )
  assert.equal('parameters' in oversized.normalized, false)

  const manyProperties = { type: 'object', properties: {} }
  for (let index = 0; index < 100_000; index += 1) manyProperties.properties[`p${index}`] = { type: 'string' }
  const propertyBytes = Buffer.byteLength(JSON.stringify(manyProperties), 'utf8')
  assert.ok(propertyBytes > LIMITS.maxParametersBytes * 8, 'the fixture must be far past the bound')

  const hundredThousand = validateProgramDefinition(definition({ parameters: manyProperties }))
  assert.equal(hundredThousand.ok, false)
  assert.match(violationsOf(hundredThousand), new RegExp(`received ${propertyBytes} bytes`))

  const elevenMegabytes = 11 * 1024 * 1024
  const huge = validateProgramDefinition(definition({ parameters: schemaWithSerializedBytes(elevenMegabytes) }))
  assert.equal(huge.ok, false)
  assert.match(violationsOf(huge), new RegExp(`received ${elevenMegabytes} bytes`))
})

test('parameter schema cycles are violations, never crashes', () => {
  const cyclic = { type: 'object', properties: {} }
  cyclic.properties.self = cyclic

  const definitionResult = validateProgramDefinition(definition({ parameters: cyclic }))
  assert.equal(definitionResult.ok, false)
  assert.match(violationsOf(definitionResult), /parameters: schema\.properties\.self is circular/)
  assert.equal('parameters' in definitionResult.normalized, false)

  assert.deepEqual(validateProgramArgs(cyclic, {}), ['parameters: schema.properties.self is circular'])
})

test('validateProgramDefinition bounds parameter schema depth without overflowing the stack', () => {
  const boundary = validateProgramDefinition(definition({ parameters: schemaOfDepth(LIMITS.maxParametersDepth) }))
  assert.equal(boundary.ok, true, violationsOf(boundary))
  assert.equal(depthOf(boundary.normalized.parameters), LIMITS.maxParametersDepth)

  const tooDeep = validateProgramDefinition(definition({ parameters: schemaOfDepth(LIMITS.maxParametersDepth + 2) }))
  assert.equal(tooDeep.ok, false)
  // The first level past the bound is the one reported.
  assert.match(
    violationsOf(tooDeep),
    new RegExp(`parameters: schema must be at most ${LIMITS.maxParametersDepth} levels deep \\(received ${LIMITS.maxParametersDepth + 1}\\)`),
  )
  assert.equal('parameters' in tooDeep.normalized, false)

  // 10k levels is far past the stack limit of the official recursive validator
  // and of JSON.stringify; the iterative check must still return a violation.
  let pathological = 'leaf'
  for (let level = 0; level < 10_000; level += 1) pathological = { child: pathological }
  const deep = validateProgramDefinition(definition({ parameters: pathological }))
  assert.equal(deep.ok, false)
  assert.match(violationsOf(deep), /parameters: schema must be at most 64 levels deep \(received 65\)/)

  // A deep cycle reports the depth bound first, and still never throws.
  const deepCycle = {}
  let node = deepCycle
  for (let level = 0; level < 500; level += 1) {
    node.child = {}
    node = node.child
  }
  node.child = deepCycle
  const cyclicDeep = validateProgramDefinition(definition({ parameters: deepCycle }))
  assert.equal(cyclicDeep.ok, false)
  assert.match(violationsOf(cyclicDeep), /parameters: schema must be at most 64 levels deep/)
})

test('validateProgramArgs shares the depth bound instead of throwing', () => {
  let pathological = 'leaf'
  for (let level = 0; level < 10_000; level += 1) pathological = { child: pathological }

  assert.deepEqual(validateProgramArgs(pathological, {}), ['parameters: schema must be at most 64 levels deep (received 65)'])
  assert.throws(
    () => assertSupportedParametersSchema(pathological),
    (error) => {
      assert.ok(error instanceof JsonSchemaError)
      assert.match(error.violations.join('\n'), /must be at most 64 levels deep/)
      return true
    },
  )
})

test('assertSupportedParametersSchema throws JsonSchemaError for an oversized schema', () => {
  const oversized = schemaWithSerializedBytes(LIMITS.maxParametersBytes + 1)
  assert.throws(
    () => assertSupportedParametersSchema(oversized),
    (error) => {
      assert.ok(error instanceof JsonSchemaError)
      assert.match(error.violations.join('\n'), /schema must be at most 65536 bytes when serialized/)
      return true
    },
  )
})

test('validateProgramArgs reports an oversized schema instead of throwing', () => {
  const violations = validateProgramArgs(schemaWithSerializedBytes(LIMITS.maxParametersBytes + 1), {})
  assert.equal(violations.length, 1)
  assert.match(violations[0], /^parameters: schema must be at most 65536 bytes when serialized/)
})

/* ---------------------------------------------------------------- args */

test('validateProgramArgs returns path-qualified violations', () => {
  const parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      limit: { type: 'integer' },
      mode: { type: 'string', enum: ['fast', 'deep'] },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  }

  assert.deepEqual(validateProgramArgs(parameters, { pattern: 'TODO', limit: 2, mode: 'fast', items: [] }), [])

  assert.deepEqual(validateProgramArgs(parameters, {}), ['missing required property "args.pattern"'])
  assert.deepEqual(validateProgramArgs(parameters, { pattern: 7 }), ['"args.pattern" must be a string'])
  assert.deepEqual(validateProgramArgs(parameters, { pattern: 'x', limit: 1.5 }), ['"args.limit" must be an integer'])
  assert.deepEqual(validateProgramArgs(parameters, { pattern: 'x', mode: 'slow' }), [
    '"args.mode" must be one of ["fast","deep"]',
  ])
  assert.deepEqual(validateProgramArgs(parameters, { pattern: 'x', extra: true }), [
    '"args.extra" is not a declared property (additionalProperties: false)',
  ])
  assert.deepEqual(validateProgramArgs(parameters, null), ['"args" must be an object'])
  assert.deepEqual(validateProgramArgs(parameters, 'text'), ['"args" must be an object'])
  assert.deepEqual(validateProgramArgs(parameters, { pattern: 'x', items: [{}, { name: 3 }] }), [
    'missing required property "args.items[0].name"',
    '"args.items[1].name" must be a string',
  ])
})

test('validateProgramArgs refuses an unusable parameters schema instead of throwing', () => {
  const violations = validateProgramArgs({ type: 'string' }, { pattern: 'x' })
  assert.ok(Array.isArray(violations))
  assert.equal(violations.length, 1)
  assert.match(violations[0], /parameters: schema\.type must be "object"/)

  assert.match(validateProgramArgs(null, {}).join('\n'), /parameters:/)
})

test('validateProgramArgs accepts an unconstrained object schema', () => {
  assert.deepEqual(validateProgramArgs({ type: 'object' }, { anything: [1, 2, 3] }), [])
  assert.deepEqual(validateProgramArgs({ type: 'object' }, {}), [])
})

test('validateProgramDefinition validates requiredTools and reports visibility as warnings only', () => {
  const notArray = validateProgramDefinition(definition({ requiredTools: 'read' }))
  assert.equal(notArray.ok, false)
  assert.match(violationsOf(notArray), /requiredTools: must be an array/)

  const notString = validateProgramDefinition(definition({ requiredTools: ['read', 7] }))
  assert.equal(notString.ok, false)
  assert.match(violationsOf(notString), /requiredTools\[1\]: must be a string/)

  const invalidName = validateProgramDefinition(definition({ requiredTools: ['bad tool name'] }))
  assert.equal(invalidName.ok, false)
  assert.match(violationsOf(invalidName), /requiredTools\[0\]/)

  const tooMany = validateProgramDefinition(
    definition({ requiredTools: Array.from({ length: LIMITS.maxRequiredTools + 1 }, (_, index) => `tool-${index}`) }),
  )
  assert.equal(tooMany.ok, false)
  assert.match(violationsOf(tooMany), new RegExp(`requiredTools: must contain at most ${LIMITS.maxRequiredTools}`))

  const warningsOnly = validateProgramDefinition(definition({ requiredTools: ['read', 'grep'] }), {
    availableTools: ['read'],
  })
  assert.equal(warningsOnly.ok, true, violationsOf(warningsOnly))
  assert.equal(warningsOnly.violations.length, 0)
  assert.equal(warningsOnly.warnings.length, 1)
  assert.match(warningsOnly.warnings[0], /grep/)

  const allVisible = validateProgramDefinition(definition({ requiredTools: ['read'] }), { availableTools: ['read', 'grep'] })
  assert.deepEqual(allVisible.warnings, [])

  assert.throws(() => validateProgramDefinition(definition(), { availableTools: 'read' }), TypeError)
})

test('validateProgramDefinition bounds the change note', () => {
  const oversized = validateProgramDefinition(definition({ changeNote: 'n'.repeat(LIMITS.maxChangeNoteChars + 1) }))
  assert.equal(oversized.ok, false)
  assert.match(violationsOf(oversized), new RegExp(`changeNote: must be at most ${LIMITS.maxChangeNoteChars} characters`))

  const boundary = validateProgramDefinition(definition({ changeNote: 'n'.repeat(LIMITS.maxChangeNoteChars) }))
  assert.equal(boundary.ok, true, violationsOf(boundary))
  assert.equal(boundary.normalized.changeNote.length, LIMITS.maxChangeNoteChars)

  const blank = validateProgramDefinition(definition({ changeNote: '   ' }))
  assert.equal(blank.ok, true, violationsOf(blank))
  assert.equal('changeNote' in blank.normalized, false)

  const typed = validateProgramDefinition(definition({ changeNote: 5 }))
  assert.equal(typed.ok, false)
  assert.match(violationsOf(typed), /changeNote: must be a string/)
})

/* ------------------------------------------------------- source hygiene */

test('validate.js compiles statically and never imports an evaluator or a filesystem', async () => {
  const source = await readFile(new URL('../src/validate.js', import.meta.url), 'utf8')

  assert.match(source, /from 'node:module'/)
  assert.match(source, /stripTypeScriptTypes\(/)
  assert.match(source, /mode: 'strip'/)
  assert.match(source, /from 'node:vm'/)
  assert.match(source, /new vm\.Script\(/)
  assert.match(source, /assertObjectJsonSchema/)
  assert.match(source, /assertSupportedJsonSchema/)
  assert.match(source, /validateJsonSchemaValue/)

  // The compile wrapper is an async function expression (the runtime's function-body
  // flavor) and pins the compile-only JSON guard before the runtime prelude.
  assert.ok(source.includes('(async function () {'))
  assert.ok(source.includes('${JSON_GUARD}\\n${ARGS_PRELUDE}'))
  assert.doesNotMatch(source, /\(async \(\) => \{/)

  // Only strip-only erasure, and only compilation: no transform mode, no evaluation.
  assert.doesNotMatch(source, /mode: 'transform'/)
  assert.doesNotMatch(source, /new Function\b/)
  assert.doesNotMatch(source, /\beval\s*\(/)
  assert.doesNotMatch(source, /runInContext|runInNewContext|runInThisContext/)
  assert.doesNotMatch(source, /node:fs/)
  assert.doesNotMatch(source, /node:child_process/)
  assert.doesNotMatch(source, /node:worker_threads/)
})
