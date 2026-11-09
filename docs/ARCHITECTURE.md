# 架构契约 · dsh-ptc-sdk-forge

## 1. 一句话

`ptc_sdk` 是一个挂在宿主工具层的普通工具；它在调用内部复用官方 PTC runtime，让任何 Agent 模式都能创建、保存和运行程序化 SDK，而不改变该 Agent 自己的 executor。

## 2. 两层运行模型

```text
┌──────────────────────────────────────────────────────────┐
│ 外层：standard / 创造 / 急速 / PTC / 用户自定义 preset   │
│ 原有 persona、prompt、tools、executor、审批均不变         │
└───────────────────────────┬──────────────────────────────┘
                            │ 普通 tool call: ptc_sdk
                            ▼
┌──────────────────────────────────────────────────────────┐
│ SDK Forge                                                │
│ discover / validate / save / list / get / archive        │
│                         │ test / run                     │
│                         ▼                                │
│ 官方 PTC 执行桥（不是新的外层 executor）                 │
│                         │                                │
│ 调用方 Agent + 当步 toolSet + AbortSignal                │
└─────────────────────────┬────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│ 内层：官方 PTC runtime                                   │
│ tools.<name>(args)、并行、条件、循环、聚合、结果精炼     │
│ 每次 nested 调用仍进入 DSH 共享执行与权限管线            │
└──────────────────────────────────────────────────────────┘
```

禁止把内外两层合并：不得调用 `setExecutor()`，不得把外层工具面替换成只有 `run_code`，也不得重述任何 preset。

## 3. 为什么固定为一个工具

保存一个 SDK 工件不等于注册一个长期工具。每增加一个工件就改变工具列表会导致：

- 系统提示词与 SDK declaration 随工件数膨胀；
- 工具名、版本和权限生命周期混入注册表；
- 每次增删工件破坏模型前缀缓存；
- 常驻工具注册与一次性程序运行生命周期冲突。

因此注册表永远只增加 `ptc_sdk`；工件按名称和 revision 存在独立库中，调用时加载为数据并交给 PTC runtime。

## 4. 工件模型

```json
{
  "formatVersion": 1,
  "name": "repo-evidence-pack",
  "description": "Collect and rank repository evidence.",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string" }
    },
    "required": ["pattern"],
    "additionalProperties": false
  },
  "latestRevision": 2,
  "createdAt": "2026-11-09T00:00:00.000Z",
  "updatedAt": "2026-11-09T01:00:00.000Z",
  "archivedAt": null,
  "versions": [
    {
      "revision": 1,
      "description": "Collect and rank repository evidence.",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": { "type": "string" }
        },
        "required": ["pattern"],
        "additionalProperties": false
      },
      "requiredTools": ["grep"],
      "code": "const matches = await tools.grep({ pattern: args.pattern }); return { matches };",
      "createdAt": "2026-11-09T00:00:00.000Z"
    },
    {
      "revision": 2,
      "description": "Collect and rank repository evidence.",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": { "type": "string" }
        },
        "required": ["pattern"],
        "additionalProperties": false
      },
      "requiredTools": ["grep"],
      "code": "return { pattern: args.pattern };",
      "createdAt": "2026-11-09T01:00:00.000Z",
      "changeNote": "Keep the smoke fixture minimal."
    }
  ]
}
```

规则：

- `name` 是稳定小写 kebab-case 标识，不允许路径字符。
- revision 只递增，不复用；更新通过 `expectedRevision` 做乐观并发控制。
- 新建工件先取库级锁再取文件锁，固定锁序为“库 → 文件”，防止并发新建突破总数上限。
- `parameters` 序列化后最多 64 KiB、嵌套深度最多 64，单个工件最多 4 MiB；全库最多 256 工件，每工件最多 32 revision。4 MiB 是硬上限，可能先于 32 revision 触发。读取先检查文件大小，写侧与读侧都执行同一限制。
- 程序按官方 TypeScript `function-body` 的可擦除语法做静态 type-strip + 编译检查；`args` 与 runtime 使用同一保留绑定，重复声明在保存前拒绝。
- 更新保存完整新快照，旧版本不可变。
- 归档是整个工件的状态，不删除历史；归档后 `get` 仍可读取，`run` 拒绝。
- 源码只是 JSON 字符串，不被 Node 直接 import/eval。
- 不把密钥、token、cookie、私钥、环境快照写入工件。

## 5. action 数据流

### discover

读取当前调用方可见工具。默认只返回名称与描述，指定 `toolNames` 时才返回完整参数/输出 schema，避免无界输出。不得借此绕过 restrict。

### validate

校验名称、说明、参数 schema、源码大小与静态语法、声明依赖及当前可见性。**不得执行 PTC 程序或 nested 工具**。可见性缺失是报告信息，不应把“另一个模式可见的工具”误判成全局不存在。

### save

执行与 `validate` 相同的静态检查，然后在串行写锁内重新读取最新文件、检查 `expectedRevision`、追加版本并原子替换。不得运行源码。

### test

接收未保存 `code` 与 `args`，直接走内嵌 PTC 执行桥；不得创建或修改工件。可能执行真实 nested 工具并产生副作用。

### run

读取指定工件版本，校验 args，然后走与 `test` 完全相同的执行桥。不能在运行前静默升级到另一个 revision。

### list / get / archive

`list` 只给摘要；`get` 可返回指定版本源码；`archive` 是非破坏性状态标记，物理删除不属于本工具。

## 6. 权限与信任边界

1. 工件库共享不等于权限共享。每次运行重新使用调用方 Agent 的工具面与审批上下文。
2. 工件作者声明的 `requiredTools` 只是兼容性元数据，不是提权声明。
3. 程序无法通过保存时拥有某工具，把该工具携带到另一个明确禁止它的 Agent 中。
4. `test` / `run` 不是“无风险 dry run”；真正安全隔离只能来自 DSH 既有 sandbox/approval/tool guard。
5. 工件来自网络或他人时必须视为不可信输入。首版不提供网络导入、市场、远程安装或自动更新。
6. 不把工具执行中产生的 secret 自动持久化到运行日志或工件 metadata。

## 7. 失败与生命周期

- 损坏工件、写入冲突、runtime error、权限拒绝和 abort 必须保持不同错误语义。
- 写文件失败不得破坏上一个完整版本；不得把无法解析的文件当成空库。
- dispose 需要注销工具、中止活动执行并等待 nested settle；重复 dispose 幂等。
- 固定上限覆盖源码、说明、版本数、工件数和返回体；禁止把库当通用文件系统。

## 8. 执行桥的已知边界

- 内层使用一个插件私有的 `PtcExecutor`，每次只合成一条 `run_code` 批次；从不调用外层 `setExecutor()`。
- 合成批次**不携带 `log`**，避免伪造一对额外的 root `tool/call` / `tool/result` 历史。内层 nested 仍产生官方 PTC dispatch 事件，因此 UI 的 dispatch 关联不应被描述成官方原生 `run_code` 卡片。
- 公开 `ToolBatchInput` 没有 `rootCallId` / `parent` 字段，合成 transport 以当前 `ptc_sdk` callId 作为 root；真正的 nested 工具调用仍由官方 runtime 设置正确 parent。这一关联缺口不得伪装成完全相等的事件拓扑。
- `ptc_sdk` 会从内层 binding 中删除，保存的程序不能递归调用 Forge 自身。
- 当前 args 前导和静态语法检查只支持 TypeScript `function-body`；Python runtime、persistent-in-memory/repl、vm-script/script 和 retainsState 都会在执行前明确拒绝。缺少调用步 `toolSet` 时 fail-closed，不退化成仅无条件工具准入。
- args 是只读保留绑定；顶层 `JSON` 声明同样拒绝，防止参数前导被用户作用域遮蔽。程序级 timeout/sandbox 升级参数不开放，宿主返回的 sandbox 拒绝信息会保留在有界结果中。Node 24 的 `stripTypeScriptTypes` 首次调用可能输出一次 ExperimentalWarning，这不是程序执行或测试失败。
- 每个 bridge 只构造一个 `PtcExecutor`，dispose 会 abort 并等待活动执行 settle，避免全局监听器与程序泄漏。

## 9. 非目标

- 全局 PTC executor 开关；
- 领域 Agent presets；
- 新一代工具权限沙箱；
- 第二个 workflow engine；
- 远程 SDK 市场或自动安装；
- Python PTC flavor（当前保存物只接受 TypeScript `function-body`，遇到 Python runtime 必须明确拒绝）；
- 动态把每个保存物注册成工具；
- 迁移、改名或删除旧领域 preset 项目。
