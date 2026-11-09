// Public-tree hygiene guard for dsh-ptc-sdk-forge.
//
// Every file outside the exclusions below is published. This test rejects
// local-user absolute paths, email addresses and common credential shapes.
// Workspace-specific names and local identities live in the local-only gate
// `tests/private-hygiene.local.mjs`, which is git-ignored and excluded here.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'artifacts', 'coverage']);
const EXCLUDED_ROOT_FILES = new Set(['TASKS.md', 'HANDOFF.md', 'node.json', 'project.json']);
const isLocalOnlyFile = (name) => name.endsWith('.local.mjs');

const PRIVATE_KEY_MARKER = ['-----BEGIN ', '(?:[A-Z0-9]+ )?', 'PRIVATE KEY-----'].join('');

const RULES = Object.freeze([
  {
    id: 'windows-user-path',
    description: 'absolute Windows user profile path',
    pattern: /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'<>|]+/i,
  },
  {
    id: 'unix-user-path',
    description: 'absolute Unix/macOS user home path',
    pattern: /(?:^|[^\w.'-])\/(?:Users|home|root)\/[A-Za-z0-9._-]+/,
  },
  {
    id: 'email-address',
    description: 'email address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  },
  {
    id: 'qq-number',
    description: 'QQ instant-messaging number',
    pattern: /(?:QQ|Qq|qq)\s*(?:号|number)?\s*[:：]?\s*\d{5,12}\b/,
  },
  {
    id: 'real-agent-id',
    description: 'real goal or session identifier',
    pattern: /(?:^|[^A-Za-z0-9])(?:goal|session)-[0-9a-f]{8,}(?:-[0-9a-f]{4,})*/i,
  },
  {
    id: 'github-token',
    description: 'GitHub access token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/,
  },
  {
    id: 'private-key',
    description: 'PEM private key block',
    pattern: new RegExp(PRIVATE_KEY_MARKER),
  },
  {
    id: 'bearer-token',
    description: 'bearer credential',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  },
  {
    id: 'credential-assignment',
    description: 'hard-coded credential assignment',
    pattern:
      /(?:^|[^A-Za-z0-9])(?:api[_-]?key|secret|token|passwd|password|auth[_-]?token)\s*[:=]\s*["'`][^"'`\s]{16,}["'`]/i,
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack access token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  },
]);

function listPublicFiles(root) {
  const files = [];
  const walk = (absoluteDirectory, relativeDirectory) => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIR_NAMES.has(entry.name)) {
          walk(path.join(absoluteDirectory, entry.name), relative);
        }
        continue;
      }
      // Symlinks are not followed: they can escape the tree or form cycles.
      if (!entry.isFile()) continue;
      if (isLocalOnlyFile(entry.name)) continue;
      if (!relativeDirectory && EXCLUDED_ROOT_FILES.has(entry.name)) continue;
      files.push({ absolute: path.join(absoluteDirectory, entry.name), relative });
    }
  };
  walk(root, '');
  return files;
}

function decodeText(buffer) {
  const probe = buffer.subarray(0, 8192);
  for (const byte of probe) {
    if (byte === 0) return null;
  }
  return buffer.toString('utf8');
}

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function mask(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= 6) return '*'.repeat(Math.max(text.length, 1));
  return `${text.slice(0, 2)}${'*'.repeat(Math.min(text.length - 4, 24))}${text.slice(-2)}`;
}

function scanText(text, relative) {
  const findings = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match === null) continue;
    findings.push({
      file: relative,
      line: lineAt(text, match.index),
      rule: rule.id,
      sample: mask(match[0]),
    });
  }
  return findings;
}

function scanPublicTree(root) {
  const findings = [];
  for (const file of listPublicFiles(root)) {
    const text = decodeText(readFileSync(file.absolute));
    if (text === null) continue;
    findings.push(...scanText(text, file.relative));
  }
  return findings;
}

async function writeFixture(root, relative, contents) {
  const absolute = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

function normalizeMain(value) {
  return path.posix.normalize(String(value).replaceAll('\\', '/')).replace(/^\.\//, '');
}

test('scanner turns red on a careless public tree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ptc-sdk-forge-hygiene-red-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const leakLines = [
    `windows path: ${['C:', 'Users', 'sample-user', 'profile'].join('\\')}`,
    `unix path: ${['', 'home', 'sample-user', 'profile'].join('/')}`,
    `mail: ${['sample', 'example.com'].join('@')}`,
    `qq: ${['QQ', ':', '123456789'].join('')}`,
    `agent: ${['session', '0123456789abcdef'].join('-')}`,
    `github: ${['gh', 'p', '_', 'A'.repeat(24)].join('')}`,
    `npm: ${['npm', '_', 'B'.repeat(36)].join('')}`,
    `pem: ${['-----BEGIN ', 'PRIVATE KEY-----'].join('')}`,
    `auth: ${['Bearer ', 'C'.repeat(32)].join('')}`,
    `credential: ${['token', ' = "', 'D'.repeat(24), '"'].join('')}`,
    `aws: ${['AKIA', 'E'.repeat(16)].join('')}`,
    `slack: ${['xoxb', '-', '123456789012', '-', 'abcdefghijkl'].join('')}`,
  ];
  const cleanLines = [
    '$DSH_HOME/profiles/example',
    'DSH_HOME and DSH_PLUGIN_HOME are environment variable names.',
    'https://example.com/dsh/ptc-sdk-forge',
    'https://github.com/MYCF711/dsh-ptc-sdk-forge',
    'D:/code/dsh and /opt/dsh/profiles are ordinary install paths.',
    'See docs/ARCHITECTURE.md for the public contract; generic example domains are fine.',
  ];

  await writeFixture(root, 'leaks.md', `${leakLines.join('\n')}\n`);
  await writeFixture(root, 'clean.md', `${cleanLines.join('\n')}\n`);
  await writeFixture(root, 'TASKS.md', `${['sample', 'example.com'].join('@')}\n`);
  await writeFixture(root, 'HANDOFF.md', `${['gh', 'p', '_', 'F'.repeat(24)].join('')}\n`);
  await writeFixture(root, 'node.json', `${['', 'home', 'leaky'].join('/')}\n`);
  await writeFixture(root, 'project.json', `${['QQ', ':', '987654321'].join('')}\n`);
  await writeFixture(root, '.git/config', `${['gh', 'p', '_', 'G'.repeat(24)].join('')}\n`);
  await writeFixture(root, 'node_modules/leaky/index.md', `${['', 'home', 'leaky'].join('/')}\n`);
  await writeFixture(root, 'artifacts/evidence.txt', `${['sample', 'example.org'].join('@')}\n`);
  await writeFixture(root, 'coverage/report.txt', `${['session', 'abcdef0123456789'].join('-')}\n`);
  await writeFixture(root, 'nested/clean.local.mjs', `${['sample', 'example.net'].join('@')}\n`);

  const findings = scanPublicTree(root);
  const foundRules = [...new Set(findings.map((finding) => finding.rule))].sort();
  const expectedRules = RULES.map((rule) => rule.id).sort();

  assert.deepEqual(foundRules, expectedRules, 'every forbidden category must be detected');
  assert.ok(findings.length >= RULES.length, 'the red fixture must produce at least one finding per rule');
  assert.ok(
    findings.every((finding) => finding.file === 'leaks.md'),
    'excluded files and directories must not be scanned',
  );
  assert.ok(findings.every((finding) => Number.isInteger(finding.line) && finding.line >= 1));
  assert.ok(findings.every((finding) => finding.sample.includes('*')), 'samples must be masked');
});

test('current public tree has no private or credential material', () => {
  const scanned = new Set(listPublicFiles(PROJECT_ROOT).map((file) => file.relative));
  for (const required of [
    'package.json',
    'package-lock.json',
    'dsh.plugin.json',
    'README.md',
    'src/index.js',
    'tests/public-hygiene.test.mjs',
    '.github/workflows/ci.yml',
  ]) {
    assert.ok(scanned.has(required), `scan must include ${required}`);
  }
  for (const excluded of ['TASKS.md', 'HANDOFF.md', 'node.json', 'project.json']) {
    assert.ok(!scanned.has(excluded), `${excluded} is private and must stay excluded`);
  }
  assert.ok(
    [...scanned].every((relative) => !relative.endsWith('.local.mjs')),
    'git-ignored local gate files must stay out of the scan',
  );

  const findings = scanPublicTree(PROJECT_ROOT);
  assert.deepEqual(
    findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule} (${finding.sample})`),
    [],
    'public project files must not leak local paths or credentials',
  );
});

test('plugin manifest and package manifest agree', () => {
  const manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'dsh.plugin.json'), 'utf8'));

  // The plugin id is namespaced and intentionally differs from the package name.
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0, 'package.json name must not be empty');
  assert.equal(typeof plugin.id, 'string');
  assert.ok(plugin.id.endsWith(`/${manifest.name}`), 'plugin id must stay namespaced under the package name');

  assert.equal(plugin.version, manifest.version, 'plugin and package versions must match');
  assert.equal(
    normalizeMain(plugin.main),
    normalizeMain(manifest.main),
    'plugin and package entrypoints must resolve to the same file',
  );

  assert.equal(typeof manifest.engines?.node, 'string');
  assert.ok(manifest.engines.node.trim().length > 0, 'package.json engines.node must not be empty');
  assert.equal(typeof plugin.engines?.dsh, 'string');
  assert.equal(plugin.engines.dsh, manifest.engines?.dsh, 'plugin and package DSH engine ranges must match');

  assert.ok(Array.isArray(plugin.contributes?.tools), 'contributes.tools must be an array');
  assert.deepEqual(plugin.contributes.tools, ['ptc_sdk'], 'the plugin contributes exactly one fixed tool');
  assert.equal(
    new Set(plugin.contributes.tools).size,
    plugin.contributes.tools.length,
    'contributed tool names must be unique',
  );
  for (const tool of plugin.contributes.tools) {
    assert.match(tool, /^[a-z][a-z0-9_]*$/, `invalid contributed tool name: ${tool}`);
  }

  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'bundle patch must be declared');
  assert.ok(
    readFileSync(path.join(PROJECT_ROOT, manifest.dsh.bundle.patch), 'utf8').includes(manifest.name),
    'bundle patch must reference the package name',
  );
});

test('package manifest keeps private evidence out of the published package', () => {
  const manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

  assert.equal(manifest.private, true, 'private:true prevents an accidental public npm publish');
  assert.equal(typeof manifest.engines?.dsh, 'string', 'engines.dsh must declare the supported DSH range');
  assert.ok(manifest.engines.dsh.trim().length > 0, 'engines.dsh must not be empty');
  assert.equal(
    manifest.exports?.['./package.json'],
    './package.json',
    'exports must expose ./package.json for tooling',
  );

  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'files must be a non-empty array');
  const published = manifest.files.map((entry) => String(entry).replaceAll('\\', '/').replace(/^\.\//, ''));
  const privatePatterns = [/^TASKS\.md$/i, /^HANDOFF\.md$/i, /^docs(\/|$)/i, /^artifacts(\/|$)/i];
  for (const entry of published) {
    for (const pattern of privatePatterns) {
      assert.ok(!pattern.test(entry), `package.json files must not publish private evidence: ${entry}`);
    }
  }
  assert.ok(published.includes('src'), 'package.json files must publish src');
});

test('CI workflow stays on the public contract', () => {
  const workflow = readFileSync(path.join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.match(workflow, /os:\s*\[ubuntu-latest,\s*windows-latest\]/, 'CI must cover both hosted platforms');
  assert.match(workflow, /node:\s*\[24\]/, 'CI must pin Node.js 24');
  assert.match(workflow, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/, 'CI must run on the matrix platform');
  assert.match(
    workflow,
    /npm ci --ignore-scripts --no-audit --no-fund/,
    'CI must install deterministically without lifecycle scripts',
  );
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm pack --dry-run/);
  assert.match(workflow, /git show --check --first-parent --format= HEAD/, 'CI must check merge and regular commit patches for whitespace errors');
  assert.doesNotMatch(workflow, /git diff --check/, 'the no-op working-tree diff check must not come back');
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/, 'CI must keep the token read-only');

  assert.doesNotMatch(workflow, /test:rc1/, 'CI must not run local-only rc1 probes');
  assert.doesNotMatch(workflow, /\bnpm publish\b/, 'CI must not publish');
  assert.doesNotMatch(workflow, /\bgit push\b/, 'CI must not push');
  assert.doesNotMatch(workflow, /secrets\./, 'CI must not consume repository secrets');
  assert.doesNotMatch(workflow, /upload-artifact/, 'CI must not upload build output');
});
