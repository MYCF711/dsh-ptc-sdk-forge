/**
 * File-backed artifact library for `ptc_sdk`.
 *
 * One artifact is one JSON file at `<root>/programs/<name>.json`, and every
 * revision is a complete immutable snapshot (description, parameter schema,
 * declared tools, source, timestamp), so running an old revision always uses the
 * schema it was authored against. The artifact-level `description` and
 * `parameters` are the latest revision's, which keeps `list` cheap and stable.
 *
 * Writes are serialized by two official writer locks: a library-level lock that
 * makes "count the artifacts, then create one" a single atomic decision, and the
 * artifact-level lock that serializes revisions of one file. The acquisition
 * order is always library → artifact, and the only un-nested acquisition is the
 * artifact lock taken by updates and archives, so the two levels cannot deadlock.
 * Every write commits through the official atomic writer and is read back before
 * it is reported as saved.
 *
 * Reads refuse to follow a symlink, re-check the opened file descriptor, and
 * refuse an artifact above {@link MAX_ARTIFACT_BYTES}. A file that cannot be
 * parsed, or that no longer satisfies the format, raises a corrupt-store error:
 * it is never treated as an empty library. A real filesystem failure is reported
 * as `PROGRAM_STORE_IO` naming only the operation and a root-relative label, so
 * no diagnostic can leak an absolute path; the original error is kept as
 * `cause`, and a non-filesystem programmer error is rethrown untouched.
 *
 * @module dsh-ptc-sdk-forge/store
 */
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises'
import path from 'node:path'

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isPlainJsonArray, isPlainJsonRecord } from '@deepseek-ai/dsh-tools'

import {
  LIMITS,
  ProgramNameError,
  TOOL_NAME_PATTERN,
  assertSupportedParametersSchema,
  assertValidName,
  exceedsCharacterLimit,
  validateProgramDefinition,
} from './validate.js'

/** Format written into every artifact file; a reader rejects anything newer. */
export const FORMAT_VERSION = 1

/** Directory inside `root` that holds one file per artifact. */
export const PROGRAMS_DIRECTORY = 'programs'

/** Artifact files are readable and writable by their owner only. */
export const PROGRAM_FILE_MODE = 0o600

/** The library directory is traversable by its owner only. */
export const PROGRAM_DIR_MODE = 0o700

/** Library-level writer lock, a sibling of the artifact directory. */
export const LIBRARY_LOCK_NAME = '.library'

/**
 * Largest artifact file this library accepts.
 *
 * The bound is shared with `validate.js` when it declares one, so a definition
 * that validates can never be too large to persist. Full-size revisions can
 * reach this bound before the 32-revision cap does, because one revision may
 * carry a 64 KiB schema *and* 64 KiB of source; the revision limit is therefore
 * not the only guard against an oversized artifact.
 */
export const MAX_ARTIFACT_BYTES =
  typeof LIMITS.maxArtifactBytes === 'number' && Number.isSafeInteger(LIMITS.maxArtifactBytes) && LIMITS.maxArtifactBytes > 0
    ? LIMITS.maxArtifactBytes
    : 4 * 1024 * 1024

/** Writer-lock wait budget; a longer hold means a stuck writer, not normal work. */
const DEFAULT_LOCK_WAIT_MS = 15_000

/** A file name the library owns. Anything else carrying `.json` is reported. */
const PROGRAM_FILE_PATTERN = /^[a-z][a-z0-9-]{0,63}\.json$/

/** `O_NOFOLLOW` where the platform defines it; the descriptor re-check covers the rest. */
const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

/**
 * Range a stored timestamp may occupy: the library only ever writes instants that
 * `toISOString()` renders with a four-digit year, so a clock outside 0000–9999
 * cannot be persisted without changing the format.
 */
const MIN_TIMESTAMP_MILLIS = Date.parse('0000-01-01T00:00:00.000Z')
const MAX_TIMESTAMP_MILLIS = Date.parse('9999-12-31T23:59:59.999Z')

/** Fields an artifact file may carry; a stale writer cannot smuggle extra state. */
const ARTIFACT_FIELDS = new Set([
  'formatVersion',
  'name',
  'description',
  'parameters',
  'latestRevision',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'versions',
])

/** Fields one revision snapshot may carry. */
const VERSION_FIELDS = new Set([
  'revision',
  'description',
  'parameters',
  'requiredTools',
  'code',
  'createdAt',
  'changeNote',
])

/**
 * Canonical on-disk timestamp form: UTC, millisecond precision, four-digit year.
 * Offsets, missing fractions, and calendar overflow (`2026-02-30`) are rejected
 * by the round-trip check in {@link isIsoTimestamp}.
 */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** errno codes a filesystem call reports; everything else is a programmer error. */
const FILE_SYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'EEXIST',
  'EIO',
  'ENAMETOOLONG',
  'ELOOP',
  'EMLINK',
  'EXDEV',
  'ENOTEMPTY',
  'EFBIG',
  'ENODEV',
  'ENXIO',
  'ENOSYS',
  'EAGAIN',
])

/** Failure raised by the artifact library, carrying a stable diagnostic code. */
export class ProgramStoreError extends Error {
  /**
   * @param {string} code - stable machine-readable reason.
   * @param {string} message - human-readable diagnostic; never an absolute path.
   * @param {{ violations?: string[], cause?: Error } & Record<string, unknown>} [details] - structured context.
   */
  constructor(code, message, details) {
    super(message, details?.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'ProgramStoreError'
    this.code = code
    if (details !== undefined) {
      this.details = details
      if (Array.isArray(details.violations)) this.violations = details.violations
    }
  }
}

/**
 * Pick the revision a caller asked for from a full artifact.
 *
 * Callers must validate `args` against the returned version's own `parameters`
 * and run its own `code`: a historical revision is never upgraded to the latest
 * schema or source.
 *
 * @param {object} artifact - artifact returned by {@link createProgramStore}.
 * @param {unknown} [revision] - revision to select; omitted means the latest.
 * @returns {object} the requested revision snapshot.
 */
export function selectVersion(artifact, revision) {
  if (!isPlainJsonRecord(artifact) || !isPlainJsonArray(artifact.versions)) {
    throw new ProgramStoreError('PROGRAM_STORE_INVALID_ARTIFACT', 'selectVersion requires an artifact returned by the program store')
  }
  const target = revision === undefined || revision === null ? artifact.latestRevision : revision
  if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 1) {
    throw new ProgramStoreError('REVISION_INVALID', `revision must be a positive integer (received ${describeValue(revision)})`)
  }
  const version = artifact.versions.find((entry) => entry.revision === target)
  if (version === undefined) {
    throw new ProgramStoreError(
      'PROGRAM_REVISION_NOT_FOUND',
      `program "${artifact.name}" has no revision ${target} (latest ${artifact.latestRevision})`,
      { name: artifact.name, revision: target, latestRevision: artifact.latestRevision },
    )
  }
  return version
}

/**
 * Open the program library rooted at `root`.
 *
 * @param {{ root: string, now?: () => Date | string | number, lockWaitMs?: number }} config
 *   `root` is the caller-chosen library root (surrounding whitespace is ignored);
 *   `now` is injectable for tests; `lockWaitMs` bounds how long a writer waits
 *   for a cross-process lock.
 * @returns {{
 *   root: string,
 *   programsDir: string,
 *   list: (options?: { includeArchived?: boolean }) => Promise<object[]>,
 *   get: (name: string, revision?: number) => Promise<object>,
 *   save: (input: object) => Promise<{ artifact: object, version: object }>,
 *   archive: (name: string) => Promise<object>,
 * }}
 */
export function createProgramStore(config) {
  const settings = config === undefined ? {} : config
  if (!isPlainJsonRecord(settings)) {
    throw new ProgramStoreError(
      'PROGRAM_STORE_INVALID_ROOT',
      'createProgramStore requires a configuration object with { root } set to the library directory',
    )
  }
  const { root, now, lockWaitMs } = settings
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new ProgramStoreError(
      'PROGRAM_STORE_INVALID_ROOT',
      'createProgramStore requires { root } as a non-empty directory path',
    )
  }
  if (now !== undefined && typeof now !== 'function') {
    throw new ProgramStoreError('PROGRAM_INVALID_OPTION', 'now must be a function returning a Date or a timestamp')
  }
  const waitMs = lockWaitMs === undefined ? DEFAULT_LOCK_WAIT_MS : lockWaitMs
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0) {
    throw new ProgramStoreError('PROGRAM_INVALID_OPTION', 'lockWaitMs must be a positive number of milliseconds')
  }

  // Trim before resolving: a padded path would otherwise address a different directory.
  const resolvedRoot = path.resolve(root.trim())
  const programsDir = path.join(resolvedRoot, PROGRAMS_DIRECTORY)
  const libraryLockPath = path.join(resolvedRoot, LIBRARY_LOCK_NAME)
  const clock = typeof now === 'function' ? now : () => new Date()

  /** Root-relative diagnostic label, so no message can leak an absolute path. */
  function relativeLabel(target) {
    const relative = path.relative(resolvedRoot, target)
    return relative === '' ? '.' : relative.split(path.sep).join('/')
  }

  /**
   * Run one public operation, normalizing real filesystem failures.
   *
   * Only errno-coded failures are converted: a programmer error (a `TypeError`
   * from a bad internal call, a bug) still propagates untouched so it cannot hide
   * behind a store error. The diagnostic names the operation and the root-relative
   * label, and the original error survives only as `cause`.
   */
  async function guardIo(operation, label, run) {
    try {
      return await run()
    } catch (error) {
      if (isFileSystemError(error)) {
        throw new ProgramStoreError('PROGRAM_STORE_IO', `cannot ${operation} ${label} (${error.code})`, {
          cause: error,
          operation,
          path: label,
          errno: error.code,
        })
      }
      throw error
    }
  }

  /** Current instant as an ISO string, from the injected clock when present. */
  function timestamp() {
    const value = clock()
    let millis
    if (value instanceof Date) millis = value.getTime()
    else if (typeof value === 'string') millis = Date.parse(value)
    else if (typeof value === 'number') millis = value
    else {
      throw new ProgramStoreError(
        'PROGRAM_STORE_INVALID_CLOCK',
        'now() must return a Date, an ISO timestamp string, or epoch milliseconds',
      )
    }
    if (!Number.isFinite(millis) || millis < MIN_TIMESTAMP_MILLIS || millis > MAX_TIMESTAMP_MILLIS) {
      throw new ProgramStoreError(
        'PROGRAM_STORE_INVALID_CLOCK',
        'now() must be an instant between 0000-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z',
      )
    }
    return new Date(millis).toISOString()
  }

  /** One corrupt-store diagnostic naming the file relatively and the reason. */
  function corruptError(label, reason) {
    return new ProgramStoreError('PROGRAM_STORE_CORRUPT', `program file ${label} is corrupt: ${reason}`, {
      path: label,
      reason,
    })
  }

  /**
   * The library path exists but is not a directory.
   *
   * Some platforms report `ENOENT` for a child of a regular file, which would
   * disguise a misconfigured library as a missing artifact, so the misconfiguration
   * is reported directly as an I/O failure with a relative label.
   */
  function libraryNotDirectoryError() {
    const label = relativeLabel(programsDir)
    return new ProgramStoreError('PROGRAM_STORE_IO', `cannot use ${label} (ENOTDIR)`, {
      operation: 'use',
      path: label,
      errno: 'ENOTDIR',
    })
  }

  /** Reject a directory that a symlink stands in for. */
  async function assertRealDirectory(directory) {
    const stats = await lstat(directory)
    if (stats.isSymbolicLink()) throw corruptError(relativeLabel(directory), 'is a symbolic link, not a real directory')
    if (!stats.isDirectory()) throw libraryNotDirectoryError()
  }

  /**
   * Verify the library directory exists and is not a symlink; `false` when absent.
   */
  async function assertProgramsDirectory() {
    let stats
    try {
      stats = await lstat(programsDir)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    if (stats.isSymbolicLink()) throw corruptError(relativeLabel(programsDir), 'is a symbolic link, not a real directory')
    if (!stats.isDirectory()) throw libraryNotDirectoryError()
    return true
  }

  /** Create the library directory with owner-only permissions. */
  async function ensureProgramsDir() {
    await mkdir(programsDir, { recursive: true, mode: PROGRAM_DIR_MODE })
    await assertRealDirectory(programsDir)
    if (process.platform === 'win32') return
    try {
      await chmod(programsDir, PROGRAM_DIR_MODE)
    } catch (error) {
      // A concurrently removed directory is recreated by the next write.
      if (error?.code !== 'ENOENT') throw error
    }
  }

  /** Wrap a name violation in the store error type the public surface promises. */
  function assertProgramName(name) {
    try {
      return assertValidName(name)
    } catch (error) {
      if (error instanceof ProgramNameError) {
        throw new ProgramStoreError('INVALID_PROGRAM_NAME', error.message, { cause: error })
      }
      throw error
    }
  }

  /** Derive the only path an artifact may occupy from its validated name. */
  function filePathFor(name) {
    const validated = assertProgramName(name)
    const filePath = path.join(programsDir, `${validated}.json`)
    if (path.dirname(filePath) !== programsDir || path.basename(filePath) !== `${validated}.json`) {
      throw new ProgramStoreError('INVALID_PROGRAM_NAME', `program name ${describeValue(validated)} cannot be mapped to a library file`)
    }
    return filePath
  }

  /** `lstat` result, or `undefined` when the path does not exist. */
  async function lstatOrUndefined(target) {
    try {
      return await lstat(target)
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Validated artifact names currently present in the library directory. */
  async function listProgramFileNames() {
    if (!(await assertProgramsDirectory())) return []
    const entries = await readdir(programsDir, { withFileTypes: true })
    const names = []
    for (const entry of entries) {
      // A case variant or a trailing dot/space is the same artifact name on some
      // filesystems, so it is reported instead of being silently skipped.
      const lowered = entry.name.toLowerCase()
      if (!lowered.endsWith('.json') && !/\.json[. ]+$/.test(lowered)) continue
      const label = relativeLabel(path.join(programsDir, entry.name))
      if (!PROGRAM_FILE_PATTERN.test(entry.name)) {
        throw corruptError(
          label,
          `unexpected program file ${JSON.stringify(entry.name)}: file names must match ^[a-z][a-z0-9-]{0,63}\\.json$ exactly (case, trailing dots and spaces are not allowed)`,
        )
      }
      const name = entry.name.slice(0, -'.json'.length)
      try {
        // Device names and other non-identities are store corruption, not a caller error.
        assertValidName(name)
      } catch {
        throw corruptError(
          label,
          `unexpected program file ${JSON.stringify(entry.name)}: file names must be valid artifact identities`,
        )
      }
      names.push(name)
    }
    return names.sort()
  }

  /**
   * Read one artifact file without following a symlink or trusting its size.
   * @returns {Promise<string | undefined>} artifact text, or `undefined` when absent.
   */
  async function readArtifactText(filePath) {
    const label = relativeLabel(filePath)
    const before = await lstatOrUndefined(filePath)
    if (before === undefined) return undefined
    if (before.isSymbolicLink()) throw corruptError(label, 'is a symbolic link, not a regular artifact file')
    if (!before.isFile()) throw corruptError(label, 'is not a regular file')
    if (before.size > MAX_ARTIFACT_BYTES) {
      throw corruptError(label, `exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit (received ${before.size})`)
    }

    let handle
    try {
      handle = await open(filePath, OPEN_NOFOLLOW | constants.O_RDONLY)
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
        throw corruptError(label, 'is a symbolic link, not a regular artifact file')
      }
      throw error
    }
    try {
      const opened = await handle.stat()
      if (!opened.isFile()) throw corruptError(label, 'is not a regular file')
      if (opened.size > MAX_ARTIFACT_BYTES) {
        throw corruptError(label, `exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit (received ${opened.size})`)
      }
      // The path may have been swapped between the lstat and the open. When the
      // filesystem cannot report an identity the check cannot be made, so the read
      // fails closed instead of trusting an unverifiable file.
      if (before.ino === 0 || before.dev === 0 || opened.ino === 0 || opened.dev === 0) {
        throw corruptError(label, 'cannot verify the artifact file identity on this filesystem')
      }
      if (before.dev !== opened.dev || before.ino !== opened.ino) {
        throw corruptError(label, 'changed while it was being opened')
      }
      const buffer = await handle.readFile()
      if (buffer.byteLength > MAX_ARTIFACT_BYTES) {
        throw corruptError(label, `exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit (received ${buffer.byteLength})`)
      }
      return buffer.toString('utf8')
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** Read and verify one artifact, or `undefined` when it does not exist. */
  async function readArtifactIfPresent(name, filePath) {
    const text = await readArtifactText(filePath)
    if (text === undefined) return undefined
    return parseArtifact(text, name, filePath)
  }

  /** Parse artifact text, refusing to hand back anything structurally wrong. */
  function parseArtifact(text, expectedName, filePath) {
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw corruptError(relativeLabel(filePath), `is not valid JSON (${error.message})`)
    }
    const problems = describeArtifactProblems(raw, expectedName)
    if (problems.length > 0) throw corruptError(relativeLabel(filePath), problems.join('; '))
    return normalizeArtifact(raw)
  }

  /** Every structural problem with a stored artifact, in walk order. */
  function describeArtifactProblems(raw, expectedName) {
    if (!isPlainJsonRecord(raw)) return ['must be a JSON object']

    const problems = []
    for (const key of Object.keys(raw)) {
      if (!ARTIFACT_FIELDS.has(key)) problems.push(`unsupported field ${JSON.stringify(key)}`)
    }
    if (raw.formatVersion !== FORMAT_VERSION) {
      problems.push(`formatVersion must be ${FORMAT_VERSION} (received ${describeValue(raw.formatVersion)})`)
    }
    if (raw.name !== expectedName) {
      problems.push(`name must be "${expectedName}" (received ${describeValue(raw.name)})`)
    }
    if (!isIsoTimestamp(raw.createdAt)) problems.push('createdAt must be a canonical UTC ISO timestamp')
    if (!isIsoTimestamp(raw.updatedAt)) problems.push('updatedAt must be a canonical UTC ISO timestamp')
    if (raw.archivedAt !== null && !isIsoTimestamp(raw.archivedAt)) {
      problems.push('archivedAt must be null or a canonical UTC ISO timestamp')
    }
    if (typeof raw.description !== 'string') problems.push('description must be a string')

    if (!isPlainJsonArray(raw.versions)) return [...problems, 'versions must be an array']
    if (raw.versions.length === 0) return [...problems, 'versions must not be empty']
    if (raw.versions.length > LIMITS.maxVersions) {
      problems.push(`versions must contain at most ${LIMITS.maxVersions} snapshots`)
    }
    for (const [index, version] of raw.versions.entries()) {
      problems.push(...describeVersionProblems(version, index + 1))
    }
    if (raw.latestRevision !== raw.versions.length) {
      problems.push(`latestRevision must equal the number of revisions (${raw.versions.length})`)
    }

    const latest = raw.versions[raw.versions.length - 1]
    if (isPlainJsonRecord(latest)) {
      if (typeof raw.description === 'string' && latest.description !== raw.description) {
        problems.push('description must mirror the latest revision')
      }
      if (!isJsonEquivalent(raw.parameters, latest.parameters)) {
        problems.push('parameters must mirror the latest revision')
      }
    }
    return problems
  }

  /** Every structural problem with one stored revision snapshot. */
  function describeVersionProblems(version, expectedRevision) {
    const label = `versions[${expectedRevision - 1}]`
    if (!isPlainJsonRecord(version)) return [`${label} must be a JSON object`]

    const problems = []
    for (const key of Object.keys(version)) {
      if (!VERSION_FIELDS.has(key)) problems.push(`${label}: unsupported field ${JSON.stringify(key)}`)
    }
    if (version.revision !== expectedRevision) {
      problems.push(`${label}.revision must be ${expectedRevision} (received ${describeValue(version.revision)})`)
    }
    if (typeof version.description !== 'string' || version.description.trim().length === 0) {
      problems.push(`${label}.description must be a non-empty string`)
    } else if (exceedsCharacterLimit(version.description, LIMITS.maxDescriptionChars)) {
      problems.push(`${label}.description must be at most ${LIMITS.maxDescriptionChars} characters`)
    }
    try {
      assertSupportedParametersSchema(version.parameters)
    } catch (error) {
      const detail = Array.isArray(error?.violations) ? error.violations.join('; ') : String(error?.message ?? error)
      problems.push(`${label}.parameters: ${detail}`)
    }
    if (version.requiredTools !== undefined) {
      for (const problem of describeRequiredToolsProblems(version.requiredTools)) {
        problems.push(`${label}.requiredTools ${problem}`)
      }
    }
    if (typeof version.code !== 'string' || version.code.trim().length === 0) {
      problems.push(`${label}.code must be a non-empty string`)
    } else if (Buffer.byteLength(version.code, 'utf8') > LIMITS.maxCodeBytes) {
      problems.push(`${label}.code must be at most ${LIMITS.maxCodeBytes} bytes`)
    }
    if (!isIsoTimestamp(version.createdAt)) problems.push(`${label}.createdAt must be a canonical UTC ISO timestamp`)
    if (version.changeNote !== undefined) {
      if (typeof version.changeNote !== 'string') {
        problems.push(`${label}.changeNote must be a string`)
      } else if (exceedsCharacterLimit(version.changeNote, LIMITS.maxChangeNoteChars)) {
        problems.push(`${label}.changeNote must be at most ${LIMITS.maxChangeNoteChars} characters`)
      }
    }
    return problems
  }

  /**
   * The same `requiredTools` rules `validate.js` enforces for a new definition:
   * an array of unique, well-formed tool names within the count bound.
   * @param {unknown} value - stored `requiredTools`.
   * @returns {string[]} problems; empty means canonical.
   */
  function describeRequiredToolsProblems(value) {
    if (!isPlainJsonArray(value)) return ['must be an array of tool names']
    if (value.length > LIMITS.maxRequiredTools) return [`must contain at most ${LIMITS.maxRequiredTools} entries`]

    const problems = []
    const seen = new Set()
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'string') {
        problems.push(`[${index}] must be a string tool name`)
        continue
      }
      if (!TOOL_NAME_PATTERN.test(entry)) {
        problems.push(`[${index}] ${JSON.stringify(entry)} is not a valid tool name`)
        continue
      }
      if (seen.has(entry)) problems.push(`[${index}] ${JSON.stringify(entry)} is duplicated`)
      seen.add(entry)
    }
    return problems
  }

  /**
   * Rebuild the canonical artifact from its revisions.
   * The artifact-level description/parameters are projections of the latest
   * revision, so they can never drift from the snapshot that will be run.
   */
  function normalizeArtifact(raw) {
    const versions = raw.versions.map((version) => {
      const snapshot = {
        revision: version.revision,
        description: version.description,
        parameters: cloneJson(version.parameters),
        requiredTools: isPlainJsonArray(version.requiredTools) ? [...version.requiredTools] : [],
        code: version.code,
        createdAt: version.createdAt,
      }
      if (typeof version.changeNote === 'string' && version.changeNote.length > 0) {
        snapshot.changeNote = version.changeNote
      }
      return snapshot
    })
    const latest = versions[versions.length - 1]
    return {
      formatVersion: FORMAT_VERSION,
      name: raw.name,
      description: latest.description,
      parameters: cloneJson(latest.parameters),
      latestRevision: versions.length,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      archivedAt: raw.archivedAt ?? null,
      versions,
    }
  }

  /** One immutable revision snapshot built from a validated definition. */
  function createVersion(normalized, revision, at) {
    const snapshot = {
      revision,
      description: normalized.description,
      parameters: cloneJson(normalized.parameters),
      requiredTools: [...normalized.requiredTools],
      code: normalized.code,
      createdAt: at,
    }
    if (normalized.changeNote !== undefined) snapshot.changeNote = normalized.changeNote
    return snapshot
  }

  /**
   * Write one artifact and prove it round-trips.
   * The artifact must stay inside the byte bound, and the bytes on disk must read
   * back identically before the write is reported as successful; a failed write
   * never removes the previous complete revision.
   */
  async function commitArtifact(filePath, name, artifact) {
    const canonical = normalizeArtifact(artifact)
    const problems = describeArtifactProblems(canonical, name)
    if (problems.length > 0) {
      throw new ProgramStoreError(
        'PROGRAM_STORE_INVALID_ARTIFACT',
        `refusing to write an invalid artifact for "${name}": ${problems.join('; ')}`,
        { violations: problems },
      )
    }
    const text = serializeArtifact(canonical)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_ARTIFACT_BYTES) {
      throw new ProgramStoreError(
        'PROGRAM_ARTIFACT_TOO_LARGE',
        `artifact ${relativeLabel(filePath)} would be ${bytes} bytes, above the ${MAX_ARTIFACT_BYTES}-byte limit`,
        { limit: MAX_ARTIFACT_BYTES, size: bytes },
      )
    }
    await writeFileAtomic(filePath, text, { mode: PROGRAM_FILE_MODE, dirMode: PROGRAM_DIR_MODE })

    let written
    try {
      written = await readArtifactText(filePath)
    } catch (error) {
      if (error instanceof ProgramStoreError) throw error
      throw new ProgramStoreError(
        'WRITE_VERIFICATION_FAILED',
        `program file ${relativeLabel(filePath)} could not be read back after writing (${error?.code ?? 'unknown error'})`,
        { cause: error },
      )
    }
    if (written !== text) {
      throw new ProgramStoreError(
        'WRITE_VERIFICATION_FAILED',
        `program file ${relativeLabel(filePath)} did not round-trip byte-for-byte after writing`,
      )
    }
    const verified = parseArtifact(written, name, filePath)
    const last = verified.versions[verified.versions.length - 1]
    if (verified.latestRevision !== canonical.latestRevision || last.code !== canonical.versions[canonical.versions.length - 1].code) {
      throw new ProgramStoreError(
        'WRITE_VERIFICATION_FAILED',
        `program file ${relativeLabel(filePath)} lost revision ${canonical.latestRevision} after writing`,
      )
    }
    return verified
  }

  /** Acquire one writer lock, translating a contention timeout into a store error. */
  async function holdLock(lockPath, operation) {
    try {
      return await withFileLock(lockPath, operation, { waitMs })
    } catch (error) {
      if (error instanceof ProgramStoreError) throw error
      if (typeof error?.message === 'string' && error.message.includes('timed out waiting for the writer lock')) {
        throw new ProgramStoreError(
          'PROGRAM_LOCK_TIMEOUT',
          `timed out waiting for the writer lock on ${relativeLabel(`${lockPath}.lock`)}; another writer still holds it`,
          { cause: error },
        )
      }
      throw error
    }
  }

  /** Take the library level lock; always acquired before an artifact lock. */
  async function holdLibraryLock(operation) {
    return holdLock(libraryLockPath, operation)
  }

  /** Take one artifact's writer lock. */
  async function holdArtifactLock(filePath, operation) {
    return holdLock(filePath, operation)
  }

  /** Normalize an optional revision selector. */
  function revisionNumber(value, label) {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new ProgramStoreError(
        'REVISION_INVALID',
        `${label} must be a positive integer (received ${describeValue(value)})`,
      )
    }
    return value
  }

  /** The read-only projection `list` returns: no source, no schema bodies. */
  function summarize(artifact) {
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
   * Summarize the library, newest fields from the latest revision of each artifact.
   * @param {{ includeArchived?: boolean }} [options] - archived artifacts are hidden unless requested.
   * @returns {Promise<object[]>} summaries sorted by name.
   */
  async function list(options) {
    const settings = options === undefined ? {} : options
    if (!isPlainJsonRecord(settings)) {
      throw new ProgramStoreError('PROGRAM_INVALID_OPTION', 'list options must be an object such as { includeArchived: true }')
    }
    const includeArchived = settings.includeArchived === undefined ? false : settings.includeArchived
    if (typeof includeArchived !== 'boolean') {
      throw new ProgramStoreError('PROGRAM_INVALID_OPTION', 'list option includeArchived must be a boolean')
    }

    return guardIo('list', PROGRAMS_DIRECTORY, async () => {
      const summaries = []
      for (const name of await listProgramFileNames()) {
        const artifact = await readArtifactIfPresent(name, filePathFor(name))
        if (artifact === undefined) continue
        if (!includeArchived && artifact.archivedAt !== null) continue
        summaries.push(summarize(artifact))
      }
      return summaries
    })
  }

  /**
   * Read one complete artifact. The caller selects the revision it needs, so a
   * historical run always sees that revision's own schema and source.
   * @param {string} name - artifact identity.
   * @param {number} [revision] - assert that this revision exists; all revisions are returned.
   * @returns {Promise<object>} the full artifact, archived or not.
   */
  async function get(name, revision) {
    const filePath = filePathFor(name)
    const target = revisionNumber(revision, 'revision')

    return guardIo('read', relativeLabel(filePath), async () => {
      await assertProgramsDirectory()
      const artifact = await readArtifactIfPresent(name, filePath)
      if (artifact === undefined) {
        throw new ProgramStoreError('PROGRAM_NOT_FOUND', `program "${name}" does not exist`, { name })
      }
      if (target !== undefined && !artifact.versions.some((entry) => entry.revision === target)) {
        throw new ProgramStoreError(
          'PROGRAM_REVISION_NOT_FOUND',
          `program "${name}" has no revision ${target} (latest ${artifact.latestRevision})`,
          { name, revision: target, latestRevision: artifact.latestRevision },
        )
      }
      return artifact
    })
  }

  /**
   * Create revision 1, or append `latest + 1` when `expectedRevision` matches.
   *
   * Creating takes the library lock first, so counting the artifacts and writing
   * the new one is one atomic decision; a create never carries `expectedRevision`
   * because a retried create must not silently append a second revision.
   *
   * @param {object} input - definition plus optional `expectedRevision` and `changeNote`.
   * @returns {Promise<{ artifact: object, version: object }>} the stored artifact and the new snapshot.
   */
  async function save(input) {
    const candidate = isPlainJsonRecord(input) ? input : {}
    const name = assertProgramName(candidate.name)
    const definition = validateProgramDefinition(input)
    if (!definition.ok) {
      throw new ProgramStoreError(
        'PROGRAM_INVALID_DEFINITION',
        `program "${name}" is not a valid definition: ${definition.violations.join('; ')}`,
        { violations: definition.violations },
      )
    }
    const normalized = definition.normalized
    const expectedRevision = revisionNumber(candidate.expectedRevision, 'expectedRevision')
    const filePath = filePathFor(name)

    return guardIo('write', relativeLabel(filePath), async () => {
      await ensureProgramsDir()
      return holdLibraryLock(() =>
        holdArtifactLock(filePath, async () => {
          const existing = await readArtifactIfPresent(name, filePath)
          const committedAt = timestamp()

          if (existing === undefined) {
            if (expectedRevision !== undefined) {
              throw new ProgramStoreError(
                'REVISION_CONFLICT',
                `cannot create program "${name}" at expectedRevision ${expectedRevision}: the program does not exist`,
                { expectedRevision, latestRevision: null },
              )
            }
            const count = (await listProgramFileNames()).length
            if (count >= LIMITS.maxPrograms) {
              throw new ProgramStoreError(
                'PROGRAM_LIMIT_EXCEEDED',
                `the program library already holds ${count} artifacts (limit ${LIMITS.maxPrograms})`,
                { limit: LIMITS.maxPrograms, count },
              )
            }
            const version = createVersion(normalized, 1, committedAt)
            const stored = await commitArtifact(filePath, name, {
              formatVersion: FORMAT_VERSION,
              name,
              latestRevision: 1,
              createdAt: committedAt,
              updatedAt: committedAt,
              archivedAt: null,
              versions: [version],
            })
            return { artifact: stored, version: stored.versions[0] }
          }

          if (existing.archivedAt !== null) {
            throw new ProgramStoreError(
              'PROGRAM_ARCHIVED',
              `program "${name}" is archived since ${existing.archivedAt}; archived artifacts do not accept new revisions`,
              { name, archivedAt: existing.archivedAt },
            )
          }
          if (expectedRevision === undefined) {
            throw new ProgramStoreError(
              'EXPECTED_REVISION_REQUIRED',
              `program "${name}" already exists at revision ${existing.latestRevision}; pass expectedRevision to append a revision`,
              { name, latestRevision: existing.latestRevision },
            )
          }
          if (expectedRevision !== existing.latestRevision) {
            throw new ProgramStoreError(
              'REVISION_CONFLICT',
              `expectedRevision ${expectedRevision} does not match the latest revision ${existing.latestRevision} of program "${name}"`,
              { expectedRevision, latestRevision: existing.latestRevision },
            )
          }
          if (existing.versions.length >= LIMITS.maxVersions) {
            throw new ProgramStoreError(
              'VERSION_LIMIT_EXCEEDED',
              `program "${name}" already holds ${existing.versions.length} revisions (limit ${LIMITS.maxVersions})`,
              { limit: LIMITS.maxVersions, latestRevision: existing.latestRevision },
            )
          }
          const version = createVersion(normalized, existing.latestRevision + 1, committedAt)
          const stored = await commitArtifact(filePath, name, {
            ...existing,
            latestRevision: version.revision,
            updatedAt: committedAt,
            versions: [...existing.versions, version],
          })
          return { artifact: stored, version: stored.versions[stored.versions.length - 1] }
        }),
      )
    })
  }

  /**
   * Mark the whole artifact archived. Revisions are kept and stay readable; a
   * repeated archive is a no-op rather than a second timestamp.
   *
   * A missing artifact is reported before anything is created on disk, so
   * archiving a typo never materializes the library.
   *
   * @param {string} name - artifact identity.
   * @returns {Promise<object>} the archived artifact.
   */
  async function archive(name) {
    const filePath = filePathFor(name)

    return guardIo('archive', relativeLabel(filePath), async () => {
      await assertProgramsDirectory()
      const existing = await readArtifactIfPresent(name, filePath)
      if (existing === undefined) {
        throw new ProgramStoreError('PROGRAM_NOT_FOUND', `program "${name}" does not exist`, { name })
      }
      if (existing.archivedAt !== null) return existing

      await ensureProgramsDir()
      return holdArtifactLock(filePath, async () => {
        const current = await readArtifactIfPresent(name, filePath)
        if (current === undefined) {
          throw new ProgramStoreError('PROGRAM_NOT_FOUND', `program "${name}" does not exist`, { name })
        }
        if (current.archivedAt !== null) return current
        const archivedAt = timestamp()
        return commitArtifact(filePath, name, { ...current, archivedAt, updatedAt: archivedAt })
      })
    })
  }

  return { root: resolvedRoot, programsDir, list, get, save, archive }
}

/** Serialize one artifact in the canonical on-disk form. */
function serializeArtifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`
}

/** Detached canonical JSON copy of a schema. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Whether a value is exactly the canonical UTC timestamp form this library writes. */
function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return false
  const millis = Date.parse(value)
  // A round-trip rejects calendar overflow such as `2026-02-30`, which `Date`
  // silently normalizes, without accepting any other spelling of the instant.
  return Number.isFinite(millis) && new Date(millis).toISOString() === value
}

/** Whether an error came from a filesystem call rather than from a programmer mistake. */
function isFileSystemError(error) {
  if (error instanceof ProgramStoreError) return false
  if (typeof error?.code !== 'string') return false
  return typeof error?.syscall === 'string' || FILE_SYSTEM_ERROR_CODES.has(error.code)
}

/** Structural JSON equality, independent of key order. */
function isJsonEquivalent(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

/** Key-order-insensitive JSON rendering used only for comparison. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** Short, safe rendering of an untrusted value in a diagnostic. */
function describeValue(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return typeof value
}
