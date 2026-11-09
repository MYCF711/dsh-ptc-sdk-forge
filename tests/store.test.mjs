import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  FORMAT_VERSION,
  LIBRARY_LOCK_NAME,
  MAX_ARTIFACT_BYTES,
  PROGRAM_DIR_MODE,
  PROGRAM_FILE_MODE,
  ProgramStoreError,
  createProgramStore,
  selectVersion,
} from '../src/store.js'
import { LIMITS } from '../src/validate.js'

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
const CODE_B = 'return { limited: args.pattern, limit: args.limit };'

const roots = []

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-sdk-store-'))
  roots.push(root)
  return root
}

function definition(overrides = {}) {
  return {
    name: 'repo-evidence-pack',
    description: 'Collect and rank repository evidence.',
    parameters: structuredClone(PARAMETERS_A),
    code: CODE_A,
    requiredTools: ['read'],
    ...overrides,
  }
}

function createClock(start = '2026-11-09T00:00:00.000Z') {
  let millis = Date.parse(start)
  return {
    now() {
      const value = new Date(millis)
      millis += 1000
      return value
    },
  }
}

function programPath(root, name) {
  return path.join(root, 'programs', `${name}.json`)
}

async function readText(file) {
  return readFile(file, 'utf8')
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the operation to reject, but it resolved')
}

async function expectErrorCode(promise, code, pattern) {
  const error = await captureError(promise)
  assert.equal(error.code, code, `expected code ${code}, received ${error.code}: ${error.message}`)
  if (pattern !== undefined) assert.match(error.message, pattern)
  return error
}

function seededArtifact(name, at = '2026-11-09T00:00:00.000Z') {
  const description = `Seeded artifact ${name}.`
  const parameters = { type: 'object', properties: {}, additionalProperties: false }
  return {
    formatVersion: 1,
    name,
    description,
    parameters,
    latestRevision: 1,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    versions: [
      {
        revision: 1,
        description,
        parameters,
        requiredTools: [],
        code: 'return { seeded: true };',
        createdAt: at,
      },
    ],
  }
}

async function seedArtifacts(programsDir, count, prefix = 'seeded') {
  await mkdir(programsDir, { recursive: true })
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}-${String(index).padStart(3, '0')}`
    await writeFile(path.join(programsDir, `${name}.json`), JSON.stringify(seededArtifact(name)))
  }
}

function countJsonFiles(entries) {
  return entries.filter((entry) => entry.endsWith('.json')).length
}

/**
 * A valid parameter schema that fills the schema bound without exceeding it.
 * The artifact on disk is pretty-printed, so this schema grows several times
 * over when it is serialized as part of a revision snapshot.
 */
function maximalParametersSchema() {
  const propertyBytes = 28
  const count = Math.floor((LIMITS.maxParametersBytes - 64) / propertyBytes)
  const properties = {}
  for (let index = 0; index < count; index += 1) properties[`p${index}`] = { type: 'string' }
  const schema = { type: 'object', properties, additionalProperties: false }
  assert.ok(
    Buffer.byteLength(JSON.stringify(schema), 'utf8') <= LIMITS.maxParametersBytes,
    'the fixture must stay inside the parameter schema bound',
  )
  return schema
}

/* ------------------------------------------------------------------ create */

test('save creates revision 1 as a canonical, permission-scoped file', async () => {
  const root = await makeRoot()
  const clock = createClock()
  const store = createProgramStore({ root, now: clock.now })

  const { artifact, version } = await store.save(definition())

  assert.equal(artifact.formatVersion, FORMAT_VERSION)
  assert.equal(artifact.name, 'repo-evidence-pack')
  assert.equal(artifact.description, 'Collect and rank repository evidence.')
  assert.deepEqual(artifact.parameters, PARAMETERS_A)
  assert.equal(artifact.latestRevision, 1)
  assert.equal(artifact.archivedAt, null)
  assert.equal(artifact.createdAt, '2026-11-09T00:00:00.000Z')
  assert.equal(artifact.updatedAt, artifact.createdAt)
  assert.equal(store.programsDir, path.join(root, 'programs'))

  assert.deepEqual(version, {
    revision: 1,
    description: 'Collect and rank repository evidence.',
    parameters: PARAMETERS_A,
    requiredTools: ['read'],
    code: CODE_A,
    createdAt: '2026-11-09T00:00:00.000Z',
  })

  const file = programPath(root, 'repo-evidence-pack')
  const text = await readText(file)
  assert.deepEqual(JSON.parse(text), artifact)
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`)
  assert.deepEqual(await readdir(store.programsDir), ['repo-evidence-pack.json'])
  // the library lock is released, leaving no sibling behind
  assert.deepEqual(await readdir(root), ['programs'])

  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, PROGRAM_FILE_MODE)
    assert.equal((await stat(store.programsDir)).mode & 0o777, PROGRAM_DIR_MODE)
  }

  assert.deepEqual(await store.get('repo-evidence-pack'), artifact)
})

test('get returns the whole artifact and rejects unknown names or revisions', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  await store.save(definition())

  const full = await store.get('repo-evidence-pack')
  assert.equal(full.versions.length, 1)
  assert.equal(full.versions[0].code, CODE_A)

  assert.deepEqual(await store.get('repo-evidence-pack', 1), full)

  await expectErrorCode(store.get('missing-program'), 'PROGRAM_NOT_FOUND', /does not exist/)
  await expectErrorCode(store.get('repo-evidence-pack', 2), 'PROGRAM_REVISION_NOT_FOUND', /has no revision 2/)
  await expectErrorCode(store.get('repo-evidence-pack', 0), 'REVISION_INVALID', /positive integer/)
  await expectErrorCode(store.get('repo-evidence-pack', 1.5), 'REVISION_INVALID')
  await expectErrorCode(store.get('repo-evidence-pack', '1'), 'REVISION_INVALID')
  // beyond Number.MAX_SAFE_INTEGER the value is not a usable revision
  await expectErrorCode(store.get('repo-evidence-pack', 2 ** 53), 'REVISION_INVALID')
  await expectErrorCode(store.get('repo-evidence-pack', Number.MAX_SAFE_INTEGER + 1), 'REVISION_INVALID')
})

/* ------------------------------------------------------------------ append */

test('every revision keeps a complete immutable snapshot while the top level projects the latest', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'snapshot-fixture'

  const created = await store.save(definition({ name }))
  const firstSnapshot = structuredClone(created.artifact.versions[0])

  const appended = await store.save(
    definition({
      name,
      description: 'Collect evidence with an enforced limit.',
      parameters: structuredClone(PARAMETERS_B),
      requiredTools: ['grep', 'read', 'grep'],
      code: CODE_B,
      changeNote: 'Require an explicit limit.',
      expectedRevision: 1,
    }),
  )

  assert.equal(appended.artifact.latestRevision, 2)
  assert.deepEqual(appended.artifact.versions.map((entry) => entry.revision), [1, 2])

  // revision 1 is byte-for-byte the snapshot it was created with
  assert.deepEqual(appended.artifact.versions[0], firstSnapshot)
  assert.deepEqual(appended.artifact.versions[0].parameters, PARAMETERS_A)
  assert.deepEqual(appended.artifact.versions[0].requiredTools, ['read'])

  // revision 2 carries its own description, schema, dependencies and source
  assert.deepEqual(appended.artifact.versions[1], {
    revision: 2,
    description: 'Collect evidence with an enforced limit.',
    parameters: PARAMETERS_B,
    requiredTools: ['grep', 'read'],
    code: CODE_B,
    createdAt: '2026-11-09T00:00:01.000Z',
    changeNote: 'Require an explicit limit.',
  })

  // the artifact-level view mirrors the latest revision for list/summary use
  assert.equal(appended.artifact.description, 'Collect evidence with an enforced limit.')
  assert.deepEqual(appended.artifact.parameters, PARAMETERS_B)
  assert.equal(appended.artifact.createdAt, '2026-11-09T00:00:00.000Z')
  assert.equal(appended.artifact.updatedAt, '2026-11-09T00:00:01.000Z')

  // a historical revision resolves to its own schema, never the latest one
  const historical = selectVersion(appended.artifact, 1)
  assert.deepEqual(historical.parameters, PARAMETERS_A)
  assert.deepEqual(historical.requiredTools, ['read'])
  assert.equal(historical.description, 'Collect and rank repository evidence.')
  assert.equal(historical.code, CODE_A)

  const latest = selectVersion(appended.artifact)
  assert.equal(latest.revision, 2)
  assert.deepEqual(latest.parameters, PARAMETERS_B)

  // the on-disk file keeps both snapshots, and a reload preserves them
  const onDisk = JSON.parse(await readText(programPath(root, name)))
  assert.deepEqual(onDisk.versions[0].parameters, PARAMETERS_A)
  assert.deepEqual(onDisk.versions[1].parameters, PARAMETERS_B)

  const reloaded = createProgramStore({ root })
  const stored = await reloaded.get(name)
  assert.deepEqual(stored.versions, appended.artifact.versions)
  assert.deepEqual(selectVersion(stored, 1).parameters, PARAMETERS_A)
  assert.deepEqual(selectVersion(stored, 2).parameters, PARAMETERS_B)
})

test('save appends a revision only when expectedRevision matches the latest', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'revision-fixture'
  const file = programPath(root, name)

  await store.save(definition({ name }))
  const afterCreate = await readText(file)

  const appended = await store.save(
    definition({ name, code: CODE_B, changeNote: 'Second shape.', expectedRevision: 1 }),
  )
  assert.equal(appended.artifact.latestRevision, 2)
  assert.equal(appended.version.revision, 2)
  assert.equal(appended.version.changeNote, 'Second shape.')
  const afterAppend = await readText(file)
  assert.notEqual(afterAppend, afterCreate)

  const conflict = await expectErrorCode(
    store.save(definition({ name, code: 'return { stale: true };', expectedRevision: 1 })),
    'REVISION_CONFLICT',
    /expectedRevision 1/,
  )
  assert.deepEqual(conflict.details, { expectedRevision: 1, latestRevision: 2 })

  // a rejected write leaves the previous complete revision untouched
  assert.equal(await readText(file), afterAppend)

  await expectErrorCode(store.save(definition({ name })), 'EXPECTED_REVISION_REQUIRED', /expectedRevision/)
  await expectErrorCode(store.save(definition({ name, expectedRevision: '2' })), 'REVISION_INVALID')
  await expectErrorCode(store.save(definition({ name, expectedRevision: 0 })), 'REVISION_INVALID')
  await expectErrorCode(store.save(definition({ name, expectedRevision: 2 ** 53 })), 'REVISION_INVALID')

  // creating with any expectedRevision is refused: a retried create must not
  // silently append a second revision, so the caller has to state its intent.
  for (const expectedRevision of [1, 4]) {
    const error = await expectErrorCode(
      store.save(definition({ name: 'retry-fixture', expectedRevision })),
      'REVISION_CONFLICT',
      /does not exist/,
    )
    assert.deepEqual(error.details, { expectedRevision, latestRevision: null })
  }
  await assert.rejects(lstat(programPath(root, 'retry-fixture')), { code: 'ENOENT' })
})

/* ----------------------------------------------------------------- archive */

test('archive keeps every revision, hides it from list, and is idempotent', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'archive-fixture'
  const file = programPath(root, name)

  await store.save(definition({ name }))
  await store.save(definition({ name, code: CODE_B, expectedRevision: 1 }))

  const [summary] = await store.list()
  assert.deepEqual(Object.keys(summary).sort(), [
    'archivedAt',
    'createdAt',
    'description',
    'latestRevision',
    'name',
    'updatedAt',
  ])
  assert.equal(summary.latestRevision, 2)
  assert.ok(!JSON.stringify(summary).includes(CODE_B))
  assert.ok(!JSON.stringify(summary).includes('parameters'))

  const archived = await store.archive(name)
  assert.match(archived.archivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(archived.updatedAt, archived.archivedAt)
  assert.equal(archived.latestRevision, 2)
  assert.deepEqual(archived.versions.map((entry) => entry.revision), [1, 2])
  assert.deepEqual(archived.versions[1].parameters, PARAMETERS_A)

  assert.deepEqual(await store.list(), [])
  assert.equal((await store.list({ includeArchived: true })).length, 1)
  assert.equal((await store.list({ includeArchived: false })).length, 0)

  // archived artifacts stay readable, revisions and source included
  const fetched = await store.get(name, 2)
  assert.equal(fetched.archivedAt, archived.archivedAt)
  assert.equal(fetched.versions[0].code, CODE_A)
  assert.equal(fetched.versions[1].code, CODE_B)

  const beforeRepeat = await readText(file)
  const repeated = await store.archive(name)
  assert.equal(repeated.archivedAt, archived.archivedAt)
  assert.equal(await readText(file), beforeRepeat)

  await expectErrorCode(store.save(definition({ name, expectedRevision: 2 })), 'PROGRAM_ARCHIVED', /archived/)
})

test('archiving a missing artifact never materializes the library', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })

  await expectErrorCode(store.archive('missing-program'), 'PROGRAM_NOT_FOUND')
  await assert.rejects(lstat(path.join(root, 'programs')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(root), [])

  await expectErrorCode(store.get('missing-program'), 'PROGRAM_NOT_FOUND')
  await assert.rejects(lstat(path.join(root, 'programs')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(root), [])
})

/* ------------------------------------------------------------------ limits */

test('save refuses a new artifact beyond the library limit yet still updates existing ones', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const programsDir = store.programsDir
  await seedArtifacts(programsDir, LIMITS.maxPrograms)

  const overflow = await expectErrorCode(
    store.save(definition({ name: 'overflow-program' })),
    'PROGRAM_LIMIT_EXCEEDED',
    /limit/,
  )
  assert.equal(overflow.details.limit, LIMITS.maxPrograms)
  assert.equal(countJsonFiles(await readdir(programsDir)), LIMITS.maxPrograms)
  await expectErrorCode(store.get('overflow-program'), 'PROGRAM_NOT_FOUND')

  const updated = await store.save(definition({ name: 'seeded-000', expectedRevision: 1 }))
  assert.equal(updated.artifact.latestRevision, 2)
  assert.equal(countJsonFiles(await readdir(programsDir)), LIMITS.maxPrograms)
})

test('two concurrent new names cannot both take the last free slot', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const programsDir = store.programsDir
  await seedArtifacts(programsDir, LIMITS.maxPrograms - 1)
  assert.equal(countJsonFiles(await readdir(programsDir)), LIMITS.maxPrograms - 1)

  const settled = await Promise.allSettled([
    store.save(definition({ name: 'last-slot-a' })),
    store.save(definition({ name: 'last-slot-b' })),
  ])

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled')
  const rejected = settled.filter((entry) => entry.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'exactly one create may take the last free slot')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'PROGRAM_LIMIT_EXCEEDED')
  assert.equal(countJsonFiles(await readdir(programsDir)), LIMITS.maxPrograms)

  // a mixed create/append/read load still settles: library -> artifact is acyclic
  const mixed = await Promise.allSettled([
    store.save(definition({ name: 'mixed-new' })),
    store.save(definition({ name: 'seeded-001', expectedRevision: 1 })),
    store.list(),
    store.get('seeded-002'),
  ])
  assert.deepEqual(
    mixed.map((entry) => entry.status),
    ['rejected', 'fulfilled', 'fulfilled', 'fulfilled'],
  )
  assert.equal(mixed[0].reason.code, 'PROGRAM_LIMIT_EXCEEDED')
  assert.deepEqual(await readdir(root), ['programs'])
})

test('save enforces the per-artifact revision limit without touching the last revision', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'revision-limit-fixture'
  const file = programPath(root, name)

  await store.save(definition({ name }))
  for (let revision = 1; revision < LIMITS.maxVersions; revision += 1) {
    const appended = await store.save(definition({ name, code: `return ${revision};`, expectedRevision: revision }))
    assert.equal(appended.artifact.latestRevision, revision + 1)
  }

  const full = await store.get(name)
  assert.equal(full.versions.length, LIMITS.maxVersions)
  const before = await readText(file)

  const overflow = await expectErrorCode(
    store.save(definition({ name, code: 'return "overflow";', expectedRevision: LIMITS.maxVersions })),
    'VERSION_LIMIT_EXCEEDED',
    /revisions/,
  )
  assert.equal(overflow.details.limit, LIMITS.maxVersions)
  assert.equal(await readText(file), before)
  assert.equal((await store.get(name)).latestRevision, LIMITS.maxVersions)
})

test('oversized description, change note and source are rejected before any file appears', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })

  const cases = [
    [definition({ name: 'limit-description', description: 'x'.repeat(LIMITS.maxDescriptionChars + 1) }), /description/],
    [definition({ name: 'limit-change-note', changeNote: 'n'.repeat(LIMITS.maxChangeNoteChars + 1) }), /changeNote/],
    [definition({ name: 'limit-code', code: `// ${'x'.repeat(LIMITS.maxCodeBytes)}` }), /code/],
    [definition({ name: 'limit-schema', parameters: { type: 'string' } }), /parameters/],
  ]

  for (const [input, pattern] of cases) {
    const error = await expectErrorCode(store.save(input), 'PROGRAM_INVALID_DEFINITION')
    assert.ok(Array.isArray(error.violations) && error.violations.length > 0)
    assert.ok(
      error.violations.some((violation) => pattern.test(violation)),
      `expected a ${pattern} violation, received ${JSON.stringify(error.violations)}`,
    )
  }

  await assert.rejects(lstat(store.programsDir), { code: 'ENOENT' })

  const accepted = await store.save(
    definition({
      name: 'limit-boundary',
      description: '字'.repeat(LIMITS.maxDescriptionChars),
      changeNote: 'n'.repeat(LIMITS.maxChangeNoteChars),
      code: `// ${'x'.repeat(LIMITS.maxCodeBytes - 3)}`,
    }),
  )
  assert.equal(accepted.version.revision, 1)
  assert.equal(Buffer.byteLength(accepted.version.code, 'utf8'), LIMITS.maxCodeBytes)
  assert.equal(accepted.version.changeNote.length, LIMITS.maxChangeNoteChars)
  assert.equal([...accepted.artifact.description].length, LIMITS.maxDescriptionChars)
})

test('an artifact above the byte limit is rejected on write and on read', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })

  assert.equal(MAX_ARTIFACT_BYTES, 4 * 1024 * 1024)

  // read side: a file above the limit is refused before it is parsed as data
  await store.save(definition({ name: 'read-limit' }))
  const readLimitFile = programPath(root, 'read-limit')
  await writeFile(readLimitFile, 'x'.repeat(MAX_ARTIFACT_BYTES + 1))
  const readError = await expectErrorCode(store.get('read-limit'), 'PROGRAM_STORE_CORRUPT', /artifact limit/)
  assert.ok(readError.message.includes('programs/read-limit.json'), readError.message)
  await expectErrorCode(store.list(), 'PROGRAM_STORE_CORRUPT', /artifact limit/)

  // write side: every revision may sit inside its own bounds while the artifact
  // as a whole grows past the artifact bound, so the append is refused.
  const name = 'write-limit'
  const parameters = maximalParametersSchema()
  const code = `// ${'x'.repeat(LIMITS.maxCodeBytes - 3)}`
  const input = (expectedRevision) =>
    definition({
      name,
      description: 'Extreme artifact.',
      parameters,
      code,
      requiredTools: [],
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    })

  let latest = (await store.save(input())).artifact.latestRevision
  let limitError
  while (latest < LIMITS.maxVersions && limitError === undefined) {
    try {
      latest = (await store.save(input(latest))).artifact.latestRevision
    } catch (error) {
      if (error.code !== 'PROGRAM_ARTIFACT_TOO_LARGE') throw error
      limitError = error
    }
  }

  assert.ok(limitError, `the ${MAX_ARTIFACT_BYTES}-byte bound must be reachable within ${LIMITS.maxVersions} revisions`)
  assert.equal(limitError.details.limit, MAX_ARTIFACT_BYTES)
  assert.ok(limitError.details.size > MAX_ARTIFACT_BYTES)
  assert.ok(limitError.message.includes('programs/write-limit.json'), limitError.message)

  // the rejected write left the last complete revision, still inside the read bound
  const stored = await store.get(name)
  assert.equal(stored.latestRevision, latest)
  assert.ok(Buffer.byteLength(await readText(programPath(root, name)), 'utf8') <= MAX_ARTIFACT_BYTES)
})

/* ------------------------------------------------------------- concurrency */

test('concurrent creates of different names keep every artifact', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const names = Array.from({ length: 12 }, (_, index) => `parallel-create-${String(index).padStart(2, '0')}`)

  const results = await Promise.all(names.map((name) => store.save(definition({ name }))))
  assert.equal(results.length, names.length)

  const listed = await store.list()
  assert.deepEqual(
    listed.map((entry) => entry.name),
    [...names].sort(),
  )
  for (const name of names) {
    const artifact = await store.get(name)
    assert.equal(artifact.name, name)
    assert.equal(artifact.latestRevision, 1)
    assert.deepEqual(artifact.versions[0].parameters, PARAMETERS_A)
  }
  assert.deepEqual(
    (await readdir(store.programsDir)).sort(),
    names.map((name) => `${name}.json`),
  )
  assert.deepEqual(await readdir(root), ['programs'])
})

test('concurrent updates of one revision let exactly one writer win', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'cas-fixture'
  await store.save(definition({ name }))

  const attempts = Array.from({ length: 6 }, (_, index) =>
    store.save(definition({ name, code: `return { writer: ${index} };`, expectedRevision: 1 })),
  )
  const settled = await Promise.allSettled(attempts)

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled')
  const rejected = settled.filter((entry) => entry.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 5)
  for (const entry of rejected) assert.equal(entry.reason.code, 'REVISION_CONFLICT')

  const artifact = await store.get(name)
  assert.equal(artifact.latestRevision, 2)
  assert.deepEqual(artifact.versions.map((entry) => entry.revision), [1, 2])
})

test('retrying writers on two store instances never lose a revision', async () => {
  const root = await makeRoot()
  const stores = [
    createProgramStore({ root, now: createClock('2026-11-09T00:00:00.000Z').now }),
    createProgramStore({ root, now: createClock('2026-11-09T00:00:00.000Z').now }),
  ]
  const name = 'append-race-fixture'
  await stores[0].save(definition({ name }))

  const appendOnce = async (worker) => {
    const reader = stores[worker % 2]
    const writer = stores[(worker + 1) % 2]
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const current = await reader.get(name)
      try {
        return await writer.save(
          definition({
            name,
            description: `Worker ${worker} revision.`,
            code: `return { worker: ${worker}, attempt: ${attempt} };`,
            requiredTools: worker % 2 === 0 ? ['read'] : ['grep'],
            expectedRevision: current.latestRevision,
          }),
        )
      } catch (error) {
        if (error.code !== 'REVISION_CONFLICT') throw error
      }
    }
    throw new Error(`worker ${worker} exhausted its attempts`)
  }

  const results = await Promise.all([0, 1, 2, 3].map((worker) => appendOnce(worker)))

  const artifact = await stores[0].get(name)
  assert.equal(artifact.latestRevision, 5)
  assert.deepEqual(
    artifact.versions.map((entry) => entry.revision),
    [1, 2, 3, 4, 5],
  )

  const written = artifact.versions.slice(1)
  assert.equal(new Set(written.map((entry) => entry.code)).size, 4)
  for (const result of results) {
    assert.ok(written.some((entry) => entry.code === result.version.code))
    assert.equal(result.version.description, result.artifact.description)
  }
  for (const entry of written) {
    assert.ok(entry.parameters, 'each revision keeps its own schema snapshot')
    assert.ok(Array.isArray(entry.requiredTools))
  }

  // no lock or temp file survives the race
  assert.deepEqual(await readdir(stores[0].programsDir), [`${name}.json`])
  assert.deepEqual(await readdir(root), ['programs'])
})

/* ---------------------------------------------------------------- integrity */

test('corrupt artifact files fail loudly and never reset the library', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'corrupt-fixture'
  const file = programPath(root, name)

  const { artifact } = await store.save(definition({ name }))

  await writeFile(file, '{ "formatVersion": 1, ')
  const broken = await readText(file)

  await expectErrorCode(store.get(name), 'PROGRAM_STORE_CORRUPT', /corrupt|invalid JSON/i)
  await expectErrorCode(store.list(), 'PROGRAM_STORE_CORRUPT')
  await expectErrorCode(store.save(definition({ name, expectedRevision: 1 })), 'PROGRAM_STORE_CORRUPT')
  assert.equal(await readText(file), broken, 'a failed save must not overwrite the corrupt file')

  const reloaded = createProgramStore({ root })
  await expectErrorCode(reloaded.list(), 'PROGRAM_STORE_CORRUPT')

  const mutations = [
    ['formatVersion', (value) => ({ ...value, formatVersion: 2 })],
    ['name', (value) => ({ ...value, name: 'other-program' })],
    ['latestRevision', (value) => ({ ...value, latestRevision: 9 })],
    ['description projection', (value) => ({ ...value, description: 'Diverged from the latest revision.' })],
    ['parameters projection', (value) => ({ ...value, parameters: { type: 'object' } })],
    ['description type', (value) => ({ ...value, description: 7 })],
    ['updatedAt', (value) => ({ ...value, updatedAt: 'yesterday' })],
    ['archivedAt', (value) => ({ ...value, archivedAt: 'never' })],
    ['unknown field', (value) => ({ ...value, surprise: true })],
    ['empty versions', (value) => ({ ...value, versions: [] })],
    ['revision gap', (value) => ({ ...value, versions: [{ ...value.versions[0], revision: 2 }] })],
    ['version code', (value) => ({ ...value, versions: [{ ...value.versions[0], code: '' }] })],
    ['version description', (value) => ({ ...value, versions: [{ ...value.versions[0], description: '' }] })],
    ['version parameters', (value) => ({ ...value, versions: [{ ...value.versions[0], parameters: { type: 'string' } }] })],
    ['version requiredTools type', (value) => ({ ...value, versions: [{ ...value.versions[0], requiredTools: 'read' }] })],
    ['version requiredTools name', (value) => ({ ...value, versions: [{ ...value.versions[0], requiredTools: ['bad tool name'] }] })],
    ['version requiredTools duplicate', (value) => ({ ...value, versions: [{ ...value.versions[0], requiredTools: ['read', 'read'] }] })],
    ['version unknown field', (value) => ({ ...value, versions: [{ ...value.versions[0], extra: 1 }] })],
  ]

  for (const [label, mutate] of mutations) {
    await writeFile(file, JSON.stringify(mutate(artifact)))
    await expectErrorCode(store.get(name), 'PROGRAM_STORE_CORRUPT', undefined)
    await expectErrorCode(store.list(), 'PROGRAM_STORE_CORRUPT', undefined)
    assert.ok(label.length > 0)
  }

  // an unexpected file name inside the library is reported, not ignored
  await rm(file)
  await writeFile(path.join(store.programsDir, 'Bad Name.json'), '{}')
  await expectErrorCode(store.list(), 'PROGRAM_STORE_CORRUPT', /unexpected program file/)
  await rm(path.join(store.programsDir, 'Bad Name.json'))

  // a case variant is the same artifact on a case-insensitive filesystem, so it
  // is reported instead of being silently skipped
  await writeFile(path.join(store.programsDir, 'Case.JSON'), '{}')
  await expectErrorCode(store.list(), 'PROGRAM_STORE_CORRUPT', /unexpected program file/)
  await rm(path.join(store.programsDir, 'Case.JSON'))

  // a reserved device name is store corruption, not a caller error
  await writeFile(path.join(store.programsDir, 'con.json'), '{}')
  await expectErrorCode(store.list(), 'PROGRAM_STORE_CORRUPT', /unexpected program file/)
  await rm(path.join(store.programsDir, 'con.json'))

  // a directory where the artifact file belongs is not silently repaired
  await mkdir(file)
  await expectErrorCode(store.get(name), 'PROGRAM_STORE_CORRUPT', /regular file/)
  await expectErrorCode(store.save(definition({ name })), 'PROGRAM_STORE_CORRUPT', /regular file/)
})

test('only canonical UTC timestamps are accepted', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'timestamp-fixture'
  const file = programPath(root, name)
  const { artifact } = await store.save(definition({ name }))

  const rejected = [
    ['offset form', (value) => ({ ...value, updatedAt: '2026-11-09T00:00:00+08:00' })],
    ['calendar overflow', (value) => ({ ...value, updatedAt: '2026-02-30T00:00:00.000Z' })],
    ['hour overflow', (value) => ({ ...value, createdAt: '2026-11-09T24:00:00.000Z' })],
    ['missing milliseconds', (value) => ({ ...value, createdAt: '2026-11-09T00:00:00Z' })],
    ['version offset form', (value) => ({ ...value, versions: [{ ...value.versions[0], createdAt: '2026-11-09T00:00:00+08:00' }] })],
  ]

  for (const [label, mutate] of rejected) {
    await writeFile(file, JSON.stringify(mutate(artifact)))
    const error = await expectErrorCode(store.get(name), 'PROGRAM_STORE_CORRUPT', /canonical UTC ISO timestamp/)
    assert.ok(label.length > 0)
    assert.ok(error.message.includes('programs/timestamp-fixture.json'), error.message)
  }

  // exactly the form this library writes is accepted
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`)
  assert.deepEqual(await store.get(name), artifact)
})

test('artifact files and library directories must not be symlinks', async (t) => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'symlink-fixture'
  await store.save(definition({ name }))

  const file = programPath(root, name)
  const target = path.join(root, 'elsewhere.json')
  await writeFile(target, await readText(file))
  await rm(file)
  try {
    await symlink(target, file)
  } catch (error) {
    t.skip(`symlinks are unavailable on this platform: ${error.code ?? error.message}`)
    return
  }

  await expectErrorCode(store.get(name), 'PROGRAM_STORE_CORRUPT', /symbolic link/)
  await expectErrorCode(store.list(), 'PROGRAM_STORE_CORRUPT', /symbolic link/)

  const linkedRoot = await makeRoot()
  const realDir = path.join(linkedRoot, 'real')
  await mkdir(realDir, { recursive: true })
  try {
    await symlink(realDir, path.join(linkedRoot, 'programs'), 'dir')
  } catch (error) {
    t.skip(`directory symlinks are unavailable on this platform: ${error.code ?? error.message}`)
    return
  }
  const linkedStore = createProgramStore({ root: linkedRoot })
  await expectErrorCode(linkedStore.list(), 'PROGRAM_STORE_CORRUPT', /symbolic link/)
})

test('path attacks never reach the filesystem', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })

  const attacks = [
    '../escape',
    '..',
    '.hidden',
    '/absolute',
    'nested/inside',
    'nested\\inside',
    'C:/windows/temp/escape',
    'con',
    'nul',
    'com1',
    'lpt9',
    'UPPER',
    '1st',
    'a'.repeat(65),
  ]

  for (const name of attacks) {
    for (const error of [
      await expectErrorCode(store.get(name), 'INVALID_PROGRAM_NAME'),
      await expectErrorCode(store.save(definition({ name })), 'INVALID_PROGRAM_NAME'),
      await expectErrorCode(store.archive(name), 'INVALID_PROGRAM_NAME'),
      await expectErrorCode(store.get(name, 1), 'INVALID_PROGRAM_NAME'),
    ]) {
      // the public surface only exposes the store error type
      assert.ok(error instanceof ProgramStoreError, `${name} must raise ProgramStoreError`)
      assert.equal(error.name, 'ProgramStoreError')
    }
  }

  assert.deepEqual(await readdir(root), [])
  await assert.rejects(lstat(path.join(root, 'programs')), { code: 'ENOENT' })
  await assert.rejects(lstat(path.join(root, 'escape.json')), { code: 'ENOENT' })
})

test('a writer that cannot take the library or artifact lock fails without touching the artifact', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'lock-fixture'
  const file = programPath(root, name)

  await store.save(definition({ name }))
  const before = await readText(file)

  // artifact-level contention
  const fileLock = `${file}.lock`
  await writeFile(fileLock, `${process.pid}\n`)
  const blocked = createProgramStore({
    root,
    now: createClock('2026-11-10T00:00:00.000Z').now,
    lockWaitMs: 120,
  })
  await expectErrorCode(
    blocked.save(definition({ name, expectedRevision: 1 })),
    'PROGRAM_LOCK_TIMEOUT',
    /timed out waiting for the writer lock/,
  )
  assert.equal(await readText(file), before)
  await rm(fileLock)

  // library-level contention: a create must not slip past the library lock
  const libraryLock = path.join(root, `${LIBRARY_LOCK_NAME}.lock`)
  await writeFile(libraryLock, `${process.pid}\n`)
  await expectErrorCode(
    blocked.save(definition({ name: 'library-lock-fixture' })),
    'PROGRAM_LOCK_TIMEOUT',
    /\.library\.lock/,
  )
  await assert.rejects(lstat(programPath(root, 'library-lock-fixture')), { code: 'ENOENT' })
  await rm(libraryLock)

  const recovered = await blocked.save(definition({ name, expectedRevision: 1 }))
  assert.equal(recovered.artifact.latestRevision, 2)
  assert.deepEqual(await readdir(store.programsDir), [`${name}.json`])
  assert.deepEqual(await readdir(root), ['programs'])
})

/* ------------------------------------------------------------- side effects */

test('missing library directories stay unmaterialized until the first write', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })

  assert.deepEqual(await store.list(), [])
  await assert.rejects(lstat(store.programsDir), { code: 'ENOENT' })

  await store.save(definition())
  assert.equal((await stat(store.programsDir)).isDirectory(), true)
})

test('save never executes program source', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  delete globalThis.__ptc_sdk_forge_saved_probe__

  const result = await store.save(
    definition({
      name: 'no-exec',
      code: 'globalThis.__ptc_sdk_forge_saved_probe__ = "executed";\nreturn { ok: true };',
    }),
  )

  assert.equal(result.version.revision, 1)
  assert.equal(result.artifact.versions[0].code.includes('__ptc_sdk_forge_saved_probe__'), true)
  assert.equal(globalThis.__ptc_sdk_forge_saved_probe__, undefined)
})

test('store construction and options reject unusable input', async () => {
  for (const config of [undefined, {}, { root: '' }, { root: '   ' }, { root: 7 }, { root: null }]) {
    assert.throws(
      () => createProgramStore(config),
      (error) => error instanceof ProgramStoreError && error.code === 'PROGRAM_STORE_INVALID_ROOT',
    )
  }

  const root = await makeRoot()
  assert.throws(() => createProgramStore({ root, lockWaitMs: 0 }), { code: 'PROGRAM_INVALID_OPTION' })
  assert.throws(() => createProgramStore({ root, lockWaitMs: 'soon' }), { code: 'PROGRAM_INVALID_OPTION' })
  assert.throws(() => createProgramStore({ root, now: 5 }), { code: 'PROGRAM_INVALID_OPTION' })

  // surrounding whitespace is not part of the library path
  const padded = createProgramStore({ root: `  ${root}  ` })
  assert.equal(padded.root, path.resolve(root))
  assert.equal(padded.programsDir, path.join(path.resolve(root), 'programs'))

  const store = createProgramStore({ root, now: createClock().now })
  await expectErrorCode(store.list({ includeArchived: 'yes' }), 'PROGRAM_INVALID_OPTION')
  await expectErrorCode(store.list(null), 'PROGRAM_INVALID_OPTION')
  await expectErrorCode(store.save(definition({ name: 'bad-schema', parameters: { type: 'string' } })), 'PROGRAM_INVALID_DEFINITION')

  // a clock outside the four-digit-year form is a clock error, not a crash
  for (const now of [
    () => 8.64e15 + 1,
    () => Number.NaN,
    () => 'not-a-date',
    () => 253402300800000,
    () => -62167219200001,
    () => new Date('+010000-01-01T00:00:00.000Z'),
  ]) {
    const broken = createProgramStore({ root, now })
    await expectErrorCode(broken.save(definition({ name: 'clock-fixture' })), 'PROGRAM_STORE_INVALID_CLOCK')
  }

  // the last representable instant inside 0000–9999 is still accepted
  const edge = createProgramStore({ root, now: () => 253402300799999 })
  const edgeResult = await edge.save(definition({ name: 'clock-edge' }))
  assert.equal(edgeResult.version.createdAt, '9999-12-31T23:59:59.999Z')
  const first = createProgramStore({ root, now: () => -62167219200000 })
  const firstResult = await first.save(definition({ name: 'clock-floor' }))
  assert.equal(firstResult.version.createdAt, '0000-01-01T00:00:00.000Z')
})

test('definitions and arguments from another realm are accepted', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })

  const foreign = vm.runInNewContext(`(${JSON.stringify(definition({ name: 'realm-fixture' }))})`)
  assert.notEqual(Object.getPrototypeOf(foreign), Object.prototype)

  const { artifact, version } = await store.save(foreign)
  assert.equal(version.revision, 1)
  assert.deepEqual(artifact.parameters, PARAMETERS_A)

  const stored = await store.get('realm-fixture')
  assert.deepEqual(stored, artifact)

  const listed = await store.list({ includeArchived: true })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'realm-fixture')
  assert.equal(selectVersion(stored, 1).revision, 1)
})

test('error messages never expose absolute filesystem paths', async () => {
  const root = await makeRoot()
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'message-fixture'
  await store.save(definition({ name }))

  const messages = [
    (await captureError(store.get('missing-program'))).message,
    (await captureError(store.get(name, 9))).message,
    (await captureError(store.save(definition({ name, code: 'return 1;', expectedRevision: 9 })))).message,
  ]

  await writeFile(programPath(root, name), 'not json')
  const corrupt = await captureError(store.get(name))
  messages.push(corrupt.message)
  messages.push((await captureError(store.list())).message)
  assert.ok(corrupt.message.includes('programs/message-fixture.json'), corrupt.message)

  const lockRoot = await makeRoot()
  const lockStore = createProgramStore({ root: lockRoot, now: createClock().now, lockWaitMs: 100 })
  const lockName = 'lock-message-fixture'
  await lockStore.save(definition({ name: lockName }))
  const lockFile = programPath(lockRoot, lockName)
  await writeFile(`${lockFile}.lock`, `${process.pid}\n`)
  const timeoutMessage = (await captureError(lockStore.save(definition({ name: lockName, expectedRevision: 1 })))).message
  messages.push(timeoutMessage)
  await rm(`${lockFile}.lock`)
  assert.ok(timeoutMessage.includes('programs/lock-message-fixture.json.lock'), timeoutMessage)

  for (const message of messages) {
    assert.ok(!message.includes(root), `leaked the absolute root: ${message}`)
    assert.ok(!message.includes(lockRoot), `leaked the absolute root: ${message}`)
    assert.ok(!/(^|[^A-Za-z0-9_.-])[A-Za-z]:[\\/]/.test(message), `leaked a drive path: ${message}`)
  }
})

test('filesystem failures surface as PROGRAM_STORE_IO with a relative label', async (t) => {
  // the library directory is actually a regular file: every entry point reports a
  // typed I/O failure instead of letting a raw errno (with an absolute path) escape
  const root = await makeRoot()
  await writeFile(path.join(root, 'programs'), 'not a directory')
  const store = createProgramStore({ root, now: createClock().now })
  const name = 'io-fixture'

  const attempts = [
    ['read', () => store.get(name)],
    ['list', () => store.list()],
    ['write', () => store.save(definition({ name }))],
    ['archive', () => store.archive(name)],
  ]

  for (const [operation, run] of attempts) {
    const error = await expectErrorCode(run(), 'PROGRAM_STORE_IO', /\(E[A-Z]+\)$/)
    assert.equal(error.name, 'ProgramStoreError')
    assert.ok(error.message.includes('programs'), error.message)
    assert.ok(!error.message.includes(root), `leaked the absolute root: ${error.message}`)
    assert.ok(error.cause === undefined || error.cause instanceof Error, 'the original error survives only as cause')
    assert.ok(
      ['ENOTDIR', 'EEXIST', 'EISDIR', 'EPERM', 'EACCES'].includes(error.details.errno),
      `unexpected errno ${error.details.errno} for ${operation}`,
    )
    assert.equal(typeof error.details.operation, 'string')
    assert.ok(error.details.path.startsWith('programs'), error.details.path)
  }

  // a read-only artifact file cannot be replaced on Windows: the failure is typed
  // and the previous complete revision survives
  const readOnlyRoot = await makeRoot()
  const readOnlyStore = createProgramStore({ root: readOnlyRoot, now: createClock().now })
  const readOnlyName = 'readonly-fixture'
  await readOnlyStore.save(definition({ name: readOnlyName }))
  const readOnlyFile = programPath(readOnlyRoot, readOnlyName)
  const before = await readText(readOnlyFile)
  await chmod(readOnlyFile, 0o444)
  try {
    const outcome = await readOnlyStore
      .save(definition({ name: readOnlyName, expectedRevision: 1 }))
      .then(() => null, (error) => error)
    if (outcome === null) {
      t.diagnostic('this filesystem replaces a read-only file by rename; the write-side guard was not exercised')
    } else {
      assert.equal(outcome.code, 'PROGRAM_STORE_IO')
      assert.ok(!outcome.message.includes(readOnlyRoot), `leaked the absolute root: ${outcome.message}`)
      assert.equal(await readText(readOnlyFile), before, 'a failed write must not damage the previous revision')
    }
  } finally {
    await chmod(readOnlyFile, 0o600)
  }

  // a programmer error is not a filesystem error and must not be re-typed
  const brokenClock = createProgramStore({
    root: await makeRoot(),
    now: () => {
      throw new TypeError('clock exploded')
    },
  })
  await assert.rejects(
    brokenClock.save(definition({ name: 'clock-type-fixture' })),
    (error) => {
      assert.ok(error instanceof TypeError, `expected TypeError, received ${error?.constructor?.name}`)
      assert.equal(error.code, undefined)
      assert.equal(error.message, 'clock exploded')
      return true
    },
  )
})
