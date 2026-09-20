# 开单吧 · 定时商品推送

DeepSeek Harness 同进程插件，入口为「设置 → 定时商品推送」。保存的任务持久化到当前 profile；到点调用现有 `goods_list`，通过已有 IM 插件向选定目标发送商品文字。无需单独启动 5186 网页。

## 使用

依赖已启用的 `enterprise-tools`（注册 `goods_list`）和 `@xmanrui/dsh-im`（对照版本 4.21.2），Node.js 22.19+，开发使用 Node.js 24。源码位于 Harness 的 `selfPlugin/kaidanba-scheduler/`，在本插件目录执行：

```bash
npm ci --ignore-scripts
npm run build
npm test
cd ../..
pnpm dsh plugin --profile web add link:./selfPlugin/kaidanba-scheduler --ignore-scripts
pnpm dsh web
```

已经安装本地 link 时，只需重新构建插件，停止旧 Harness 进程，再运行 `pnpm dsh web` 并刷新浏览器。不要重复启动导致 3080 端口冲突。

1. 打开「设置 → 定时商品推送 → 新建推送任务」。
2. 填写名称、描述，选择单次日期时间或每日时刻（固定北京时间）。
3. 选择平台、机器人和客户/群/已聊会话，核对收件目标后保存并启用。
4. 刷新页面确认任务仍在，并核对下次执行时间。预览仅查询商品，不发送；立即执行需要再次确认，会实际发送。
5. 到点后查看执行记录。“平台已接受”不是客户已读；“结果待确认”不要直接重发，应先核对 IM。

旧版本的内存草稿没有持久化，无法迁移，需要重新创建一次。Harness 必须持续运行；电脑休眠、进程停止或断网都可能影响投递。离线错过的任务不补发。设置 19:00 后如果当天已超过该时间，每日任务安排在次日。

## 存储与限制

默认文件为当前 profile 根目录下 `data/kaidanba-scheduler/state.json`，标准 web profile 对应 `~/.dsh/profiles/web/data/kaidanba-scheduler/state.json`；可用插件配置 `stateFile` 指定绝对路径。目录 0700、文件 0600。不修改业务数据库，不保存凭据或完整商品消息。

单 profile 单实例，最多 200 条任务及创建去重保留项（正式任务删除后仍保留创建标识并占容量），保留最近 1000 条执行记录；每个任务最多 1000 次独立手动执行请求，去重摘要不淘汰。保存重试复用创建标识，防止网络异常产生重复任务。保存、暂停、删除均持久化，并检查版本冲突。发送前记录执行意图；发送结果不明时不自动重试。一次任务的“已结束”表示该时点已处理，投递是否成功以执行记录为准。

商品文字只包含名称、规格、单位和价格。当前商品工具最多返回 100 条；返回不完整、数据格式异常或文字超过 3500 UTF-8 字节时记录失败，不静默截断发送。全部任务使用企业工具配置的同一业务账户，不包含多租户授权或客户专属报价。微信主动投递仍受平台会话条件限制。

已聊会话第一次保存为任务时，会通过现有 IM 管理接口创建正式投递目标；之后复用该目标。若创建目标后任务保存失败，该 IM 目标会保留，重试会复用，不自动删除。管理员修改 IM 目标的路由后，任务会跟随该目标的新路由。

## 备份、恢复与服务器部署

先停止 Harness，再运行以下命令；备份文件必须是新路径：

```bash
node --experimental-strip-types scripts/state-backup.mjs backup "$HOME/.dsh/profiles/web/data/kaidanba-scheduler/state.json" /安全目录/scheduler-backup.json
node --experimental-strip-types scripts/state-backup.mjs restore /安全目录/scheduler-backup.json "$HOME/.dsh/profiles/web/data/kaidanba-scheduler/state.json"
```

恢复工具校验完整性，恢复的未结束任务全部暂停。核对数据源、机器人和收件目标后手动启用；不要直接覆盖运行中的 JSON。回退旧备份可能丢失最近发送记录，不能据此自动重发。

异常退出可能留下 `.scheduler.lock`。仅在停止所有 Harness 实例、核对锁内 `owner.json` 的主机/PID 已退出并备份数据后，才可删除该锁目录。不要删除存活实例的锁。状态损坏、权限不正确或版本不兼容时会拒绝启动，不会清空任务。

服务器需部署 Harness、此插件、企业工具和 IM，并分别安装依赖、构建及注册插件；不要复制 macOS 的 `node_modules`。另外迁移 IM/企业工具配置与凭据，使用上述恢复流程迁移调度数据。以进程管理器保持 Harness 运行，使用宿主管理端认证和安全反向代理控制访问。本插件不是独立的多用户权限系统。

## 代码和验证

- `src/index.ts`：Host 生命周期、profile 存储路径与管理 RPC 注册。
- `src/runtime.ts`、`src/runtime/`：调度、原子存储、执行状态、恢复及去重。
- `src/host-adapters.ts`：复用 `goods_list` 与 IM，商品消息格式。
- `src/host-rpc.ts`、`src/scheduler-api.ts`：宿主管理接口与页面请求。
- `src/client.tsx`、`src/SchedulerPreview.tsx`、`src/TaskEditor.tsx`：Harness 设置入口和表单。
- `src/im-directory.ts`：IM 账号、保存目标、会话发现与目标创建。

`npm test` 构建并运行后端测试，使用假工具/IM，不发送真实消息。浏览器与前端交互由用户测试；`npm run test:client` 是单独的可选前端测试，不在本次执行范围。独立开发预览不提供宿主调度接口，正式使用请进入 Harness。
