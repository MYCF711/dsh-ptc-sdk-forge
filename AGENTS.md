# AGENTS.md · dsh-ptc-sdk-forge

> 给在本仓库工作的 Agent。先读本文件和 `docs/ARCHITECTURE.md`，再读代码。README 是给人的短入口，不替代这里的工程契约。

## 1. 产品目标

交付一个 DSH Host 插件，只注册一个普通工具 `ptc_sdk`。任何标准、创造、急速、PTC 或用户自定义 Agent 模式，都可以在宿主工具面允许时使用它：

1. 发现当前调用方可用的普通 tools 及其 schema；
2. 编写并静态验证一个 PTC 程序；
3. 显式测试未保存程序；
4. 把程序保存为有名称、说明、参数 JSON Schema、源码、revision 和时间戳的 SDK 工件；
5. 跨会话、跨模式发现并读取工件；
6. 按名称、revision 和参数运行工件；
7. 归档工件，不在工具里提供不可逆物理删除。

正确语义是：**任意模式都能调用以 PTC 为内部运行时的 SDK**，不是“让所有模式改跑 PTC”。

## 2. 不可破坏的架构边界

1. **禁止调用 `ctx.tools.setExecutor()`**，也禁止修改 `tool-executor-native` / `tool-executor-ptc` 的任何行。
2. 不注册 Agent preset，不判断 `standard` / `minimal` / `ptc` / `cordis` 等模式名称，不生成模式变体。
3. 不写 `app.asar`、live `home*/profiles/*/cordis.patch.yml` 或当前运行配置；不安装、不重启、不关闭 DSH/magpie。
4. 不复制旧领域 preset 项目的领域白名单、五类 preset、SDK 文本补丁或 own-scope guard。
5. 内层执行必须复用官方 `@deepseek-ai/dsh-ptc-runtime` 与官方工具执行管线；不得用 `eval()` / `new Function()` 自造一个“类似 PTC”的运行时。
6. 外层工具是普通 `ToolDefinition`。不得要求模型直接只能看到 `run_code`，不得注入 `tools:ptc-only` 或改写外层 SDK prompt。
7. 每次执行按**调用方 Agent、当步 toolSet、signal 和权限**解析工具。显式 deny/restrict 必须保留，不能为了“任何模式”绕过门禁。
8. PTC 不是 Node 权限沙箱。审批、文件策略、guard 和嵌套工具结果仍由 DSH 权威管线决定。

## 3. 单工具契约

工具名固定为 `ptc_sdk`，action 固定为：

| action | 用途 | 是否执行程序 | 是否写库 |
|---|---|---:|---:|
| `discover` | 查看当前可用工具名称；按需返回指定工具的 schema | 否 | 否 |
| `validate` | 校验工件元数据、源码和声明依赖，不产生副作用 | 否 | 否 |
| `test` | 执行未保存源码，便于保存前验证 | **是** | 否 |
| `save` | 新建工件或基于 `expectedRevision` 追加一个 revision | 否 | **是** |
| `list` | 列出库中工件摘要，默认不返回源码 | 否 | 否 |
| `get` | 读取指定工件，可选 revision；编辑时需要源码 | 否 | 否 |
| `run` | 按名称、可选 revision 和 args 执行已保存工件 | **是** | 否 |
| `archive` | 归档整个工件；历史版本保留，默认不再运行 | 否 | **是** |

约束：

- 名称使用 `^[a-z][a-z0-9-]{0,63}$`，它就是稳定标识，不使用显示名寻址。
- revision 是从 1 开始的正整数。新建为 1；更新必须携带 `expectedRevision`，成功追加 `latest + 1`。
- `save` 只做静态验证，**不得为了验证而自动执行代码**。`test` / `run` 是明确执行动作。
- `parameters` 必须是 `type: "object"` 的 JSON Schema；运行 args 必须按该 schema 验证。
- 工件不注册为新的常驻工具。所有工件共享 `ptc_sdk` 这一个固定工具面，避免工具列表和 KV 前缀随工件数漂移。
- 所有返回都是 canonical JSON 可表达的数据；不得返回 Map、AbortSignal、Agent、Context、函数或 runtime handle。

## 4. 工件与持久化

- 工件是**数据**，不是被动态 import 的插件；源码只能交给官方 PTC runtime 执行。
- 默认库应位于当前 DSH home 下的插件专属目录，而不是项目工作区；可用行 Config 显式覆盖，测试必须指向隔离临时目录。
- 一个工件一个 JSON 文件，包含 `formatVersion`、`name`、`description`、`parameters`、`latestRevision`、`archivedAt`、`createdAt`、`updatedAt`、`versions[]`。
- 每个版本保存完整 `description`、`parameters`、`requiredTools`、`code`、`revision`、`createdAt` 快照；如支持 `changeNote`，必须是短文本而不是第二份源码。运行历史版本只能使用该版本自己的 schema 与源码。
- 写入必须串行、原子、读回校验；损坏文件 fail-loud，不能静默重置成空库。
- 路径只能由已校验名称派生；拒绝 `..`、斜杠、反斜杠、绝对路径、设备名和隐藏路径。
- 限制名称、说明、源码、版本数、工件数和返回体大小：256 工件、每工件 32 revision、源码 64 KiB、description 2000 字、changeNote 500 字、parameters 64 KiB / 深度 64、单工件 4 MiB；新建先取库级锁再取文件锁，固定锁序“库 → 文件”。
- 不保存 token、cookie、私钥或环境变量快照。文档必须提醒 Agent 不要把秘密写入代码、args、description、changeNote 或 parameters。

## 5. 模块与写权限

- `src/index.js`：公共入口、依赖装配、注册和 dispose；不写业务分支。
- `src/tool.js`：单工具 schema、action 分发、canonical 输出；不得直接操作文件路径。
- `src/store.js`：纯持久化与 revision 并发控制；不得 import Cordis/PTC。
- `src/runtime.js`：官方 PTC 执行桥；不得写工件库或改变外层 executor。
- `src/validate.js`：名称、metadata、JSON Schema 和静态源码校验；不得执行源码。
- `tests/`：单元、契约、真实 rc1 探针；不得写 live home。
- `docs/`：架构、数据契约和验收证据；本地任务派单表不属于公开展示内容。
- 同一文件单写者。子代理只能写任务书分配的路径，父级负责集成并亲自复验。

## 6. 实现纪律

1. 先读后写；优先小文件、纯函数和官方公开 API，不依赖 TypeScript `private` 的运行时穿透。
2. 生产代码保持无构建的 ESM JavaScript；`src/` 就是发布内容。
3. Host 静态 peer import 必须谨慎：优先宿主加载通道。`tools`、`ptcRuntime`、`systemPrompt` 是本插件的**硬依赖**（后两者由私有 PtcExecutor 间接使用），不是可选集成；宿主组合必须显式提供，不支持无 PTC runtime 的独立 bundle。
4. `apply` 使用箭头函数，返回异步 disposer；重复 dispose 不得重复清理或抛错。
5. 所有运行中的 PTC 调用在 dispose/abort 时必须停止并等待嵌套调用 settle；不能遗留 timer、子进程或后台 Job。
6. 不捕获错误后改成假成功。校验失败、权限拒绝、runtime error、存储损坏必须保留可诊断信息。
7. `test` 与 `run` 都可能通过 nested tools 产生真实副作用；工具描述和 README 必须明确，不能称其为“沙箱试运行”。
8. 不从网络安装工件，不解析工件里的 import 去加载包，不提供远程市场功能。

## 7. 测试门槛

### 单元与契约

- 所有 action 的成功与失败分支；无效 action、缺失字段和未知字段。
- 新建、追加 revision、expectedRevision 冲突、读取历史版本、归档、跨实例重载。
- 并发写不丢版本；原子写失败不破坏旧文件；损坏 JSON 不变为空库。
- 名称路径攻击、超大输入、非 object 参数 schema、args 校验失败。
- PTC 程序真实调用普通 tool，能并行/条件/聚合并只返回精炼结果。
- 工具 restrict/guard、signal、callId、toolSet 透传；外层 native/PTC/custom executor 不变。
- `save` / `validate` 零 nested 工具执行（`requiredTools` 可见性 discover 查询除外）；`test` 零工件写入。

### 真实 DSH 0.2.2-rc.1

至少覆盖 standard、minimal、ptc、cordis、一个显式 native 的自定义 preset 和一个无 executor 的自定义 preset：

- `ptc_sdk` 作为普通工具出现；显式 allow/deny 的组合按预期受控。
- 各模式原有 executor 在 save/run 前后保持一致。
- 保存 → 另一 Agent 读取并运行 → 新 store 实例重载后运行。
- nested 普通工具实际执行，guard/权限不被绕过。
- dispose 后工具注销、活动程序停止、无遗留 fiber/timer/Job，探针 `cleanShutdown=true`。

不得用 mock 结果冒充真实宿主通过。长命令一律 `timeout`，后台任务必须登记并回收。

## 8. Git 与交付

- 远端固定为公开 `MYCF711/dsh-ptc-sdk-forge`，用于向 DSH 官方展示；只提交经过筛选和脱敏的源码、文档与可公开测试。旧领域 preset 项目保持私密，不迁移、不改名、不删除。
- 禁止 `git add -A`、强推、改写已推送历史；按文件显式暂存。
- beta 在本地验收；推送/发布前必须有全量测试、真实 rc1 验收、pack dry-run、独立审查和 CI 证据。维护本机私有词表时，还必须运行 `npm run hygiene:private`；该 `tests/*.local.mjs` 文件只留本地，绝不提交。
- 最终更新 `CHANGELOG.md`，并更新**本地工作区**的 `HANDOFF.md`、`project.json` / `node.json` 的 `lastActiveAt`；这些元数据不属于公开仓库。仅在原工作区运行根目录 `node tools/workspace-doctor.mjs`，干净 clone 无此命令。
- 交付必须写清：测试命令与退出码、证据路径、未验证项、回滚方式。未实测不得写通过。
- 完成后提醒用户填写 DSH 插件作者与合作意向表；本次只开发，不代填、不提交表单。
