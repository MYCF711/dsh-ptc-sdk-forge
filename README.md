# dsh-ptc-sdk-forge

A DSH host plugin that registers exactly one ordinary tool, `ptc_sdk`. Any Agent mode —
standard, creative, fast, PTC or user-defined — can call it whenever its tool surface
allows. Its `test` and `run` actions execute the official PTC runtime *inside* the tool;
the caller's own executor, prompt and tool list are never replaced.

- **One fixed tool.** Saving a program never registers another tool and never rewrites the
  tool list, so system prompts and prefix caches stay stable.
- **Versioned JSON artifacts.** A program is a JSON file with a name, a description, a
  `parameters` JSON Schema, immutable revisions and timestamps.
- **Explicit execution.** `validate` and `save` never run code. `test` and `run` do.

## Not a preset, not a switch, not a sandbox

This plugin does not register Agent presets, does not flip a global PTC executor, does not
call `setExecutor()`, and does not edit host configuration or running profiles. It also
does not create a permission boundary: approvals, file policy, tool guards and nested tool
results still come from the existing host pipeline.

## Actions

| action | runs code | writes library | purpose |
|---|---:|---:|---|
| `discover` | no | no | list tools visible to the caller; return schemas for named tools |
| `validate` | no | no | static check of metadata, code and declared dependencies |
| `test` | **yes** | no | execute unsaved code before saving |
| `save` | no | **yes** | create an artifact, or append a revision with `expectedRevision` |
| `list` | no | no | library summaries, no source by default |
| `get` | no | no | read one artifact, optionally at a specific revision |
| `run` | **yes** | no | execute a saved revision with validated `args` |
| `archive` | no | **yes** | mark the whole artifact archived; history is kept |

Names match `^[a-z][a-z0-9-]{0,63}$` and are the stable identity; display names are never
used for lookup. Revisions start at `1` and only increase: an update must send
`expectedRevision` and appends `latest + 1`. `parameters` must be an object JSON Schema and
`args` are validated against it before anything executes.

## Example: save a program

```json
{
  "action": "save",
  "name": "repo-evidence-pack",
  "description": "Collect and rank repository evidence.",
  "parameters": {
    "type": "object",
    "properties": { "pattern": { "type": "string" } },
    "required": ["pattern"],
    "additionalProperties": false
  },
  "code": "const matches = await tools.grep({ pattern: args.pattern });\nreturn { matches };"
}
```

The first save creates revision `1`. Saving the same name again with `"expectedRevision": 1`
appends revision `2`; a stale value is rejected instead of overwriting.

## Example: run it

```json
{
  "action": "run",
  "name": "repo-evidence-pack",
  "revision": 1,
  "args": { "pattern": "TODO" }
}
```

Omitted `revision` means the latest revision. Failed arg validation returns an error and
runs nothing.

## Execution and side effects

`test` and `run` are real execution. A program calls tools through the PTC runtime, so its
nested calls behave like tool calls made by the Agent itself: they can read files, write
files and reach any other side-effecting tool. Do not treat them as a sandbox dry run.

Tools are resolved per call from the calling Agent, the current step's tool set, its signal
and its permissions. Programs receive the read-only reserved `args` value and
`tools.<name>` bindings. Top-level `JSON` declarations are rejected because the argument
prelude relies on that built-in. A program cannot carry a tool into an Agent that is
explicitly denied it, and archived artifacts cannot be run.

## Library

Each artifact is one JSON file inside a plugin-specific directory under the current DSH
home, not the project workspace; plugin config can point the library elsewhere. Files carry
`formatVersion`, `latestRevision`, `archivedAt` and a `versions[]` list. Writes are
serialized, atomic and read back, and a corrupt file fails loudly instead of becoming an
empty library. The library holds at most 256 artifacts and 32 revisions per artifact.
Parameter schemas are capped at 64 KiB and artifacts at 4 MiB; concurrent creation also
shares a library-level lock. `archive` keeps every revision; the tool offers no physical delete.

Do not put tokens, cookies, private keys or environment snapshots into code, `args`,
descriptions, change notes or parameter schemas — stored metadata is readable by later sessions.

## Requirements and development

- Node.js 24 or newer and DSH **0.2.2-rc.1**; official peer packages are pinned to that host version.
- The host composition must provide `tools`, `systemPrompt`, and the TypeScript `ptcRuntime`
  service. These are hard dependencies, not optional integrations; the official base bundle provides them.
- Program artifacts currently use the TypeScript `function-body` PTC flavor. Stateful REPL
  and script modes are rejected before execution, and a Python PTC runtime is rejected
  explicitly rather than being fed JavaScript source.
- Programs use the host runtime's default timeout and do not expose program-level sandbox
  escalation parameters. Host sandbox denial details are preserved in execution results.
- The bundle patch inserts one plugin row; it changes no executor and no preset.
- `npm test` runs the unit and contract suites.
- `npm run test:rc1` runs the compatibility probe against a real host. Set
  `DSH_RC1_INSTALL` to the host's `resources/app.asar/dsh` directory and
  `DSH_RC1_ELECTRON` to its Electron executable; the probe uses an isolated temporary home.
- `npm run pack:check` lists what the package would publish.

Every action returns canonical JSON. Expected failures use an `{ ok: false, error }` envelope;
unexpected collaborator failures are thrown. Neither path is reported as a silent success.

## License

`UNLICENSED`. All rights reserved; publishing this showcase does not grant a reuse license.

## 中文速览

- 一个普通工具 `ptc_sdk`：任意 Agent 模式在工具面允许时都能用，外层 executor 不变。
- 内部才走官方 PTC runtime，nested 调用仍受宿主权限与审批管线约束。
- `discover / validate / test / save / list / get / run / archive`，工具面固定、不随工件增加。
- 工件是版本化 JSON：名称、说明、`parameters` schema、不可变 revision。
- `validate` / `save` 不执行代码；`test` / `run` 会真实执行，可能经 nested 工具产生副作用。
- 不是 preset、不是全局 PTC 开关、不是权限沙箱。
