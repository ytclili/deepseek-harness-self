# enterprise-auth 企业身份插件

nextbos ERP 系统登录与业务 Token 管理的独立 DeepSeek Harness Host 插件。提供 `auth_login` 工具和 `ctx.enterpriseAuth` 服务。第一版不刷新 Token，不实现订单工具，不重复业务后端的权限判断，也不增加登录网页。

## 实现与接入状态

已实现账号密码登录适配、Token 加密持久化、按平台/机器人/发送者隔离、业务接口自动注入 Bearer、401 失效清理、403 权限错误区分及重启恢复。此前验证使用假账号和假 Token；尚未进行 nextbos ERP 系统真实登录验证。

微信和飞书的入站接线通过本目录的 `patches/dsh-im-4.21.2.patch` 提供，适用于已核对的 `@xmanrui/dsh-im` 4.21.2。同进程 Host 在提交真实私聊前登记平台、机器人、发送者与该消息的 sessionId/rpcId，完整 ask 结束或取消后释放。仅安装本插件、未安装 IM 补丁时仍拒绝登录；不从提示词、标题或会话历史猜测身份。配置外部 harnessBaseUrl 的 IM 不跨 HTTP 传递身份，仍不支持企业登录。

已有 `enterprise-tools` 仍使用它自己的固定 Token 文件。本轮没有自动切换旧工具、定时任务或新增下单逻辑；后续业务工具需通过本插件的 request 服务取代各自直接读 Token 的实现。

## 构建与加载

开发对照 Harness 0.1.7-alpha.1、Cordis 4.0.3、Schemastery 3.18.3；Node.js 22.19+ 或 24+。setup 按本插件的 peerDependencies 核对 Harness 依赖版本，不匹配时拒绝链接。源码位于 Harness 的 `selfPlugin/enterprise-auth/`，默认链接上两级 Harness 目录的现有依赖，无需下载 npm 包。在本插件目录执行：

```bash
npm run setup
npm test
cd ../..
pnpm dsh plugin --profile web add link:./selfPlugin/enterprise-auth --ignore-scripts
```

加载后需要停止旧 Harness，再执行 `pnpm dsh web`，避免两个进程争用端口。服务器应重新执行依赖链接和构建，不复制 macOS 的 node_modules。

### 微信与飞书 IM 接线补丁

在本插件目录运行以下命令准备临时构建依赖并安装补丁。脚本核对版本、五个源文件与 Host bundle 的 SHA-256，拒绝覆盖未知改动；支持官方原版安装及已核验微信补丁的增量升级。先在临时目录构建，再备份原文件并安装，不会修改 IM 凭据或启动 Harness。

```bash
npm install --prefix .im-build-deps --ignore-scripts --no-audit --no-fund esbuild@0.25.9 @larksuiteoapi/node-sdk@1.73.0 @whiskeysockets/baileys@7.0.0-rc14 semver@7.8.5 react@18.3.1
node scripts/patch-dsh-im.mjs "$HOME/.dsh/profiles/web/node_modules/@xmanrui/dsh-im" .im-build-deps/node_modules
node scripts/patch-dsh-im.mjs "$HOME/.dsh/profiles/web/node_modules/@xmanrui/dsh-im" --check
```

备份路径及补丁 revision 记录在 IM 包目录的 `.enterprise-auth-patch.json` 中；回滚前停止现有 Harness，将备份中的五个源文件和 `lib/index.js` 复制回原路径，增量升级还需恢复备份的 receipt（`.enterprise-auth-patch.json`），全量安装回滚则移除新 receipt，再重启。增量升级备份恢复到升级前的微信版本，全量安装备份恢复到官方原版。补丁不修改官方版本号；IM 重装或升级可能覆盖补丁，升级后必须重新核对适配，不能强行绕过版本/hash 检查。构建和测试完成不等于运行中进程已加载新代码；安装后仍需重启现有 Harness。

## 登录接口配置

在该插件的 Cordis 配置中设置 `backend`，字段参见 `examples/backend.example.json`。示例文件不会自动读取；`cordis.patch.yml` 的 enterprise-auth insert 条目已通过 `config.backend` 配置相同的默认值，供已安装插件重启加载后使用。未通过 bundle 加载时需自行设置 backend；缺少该配置时，插件可加载，但 `auth_login` 返回 `NOT_CONFIGURED`。两处配置均不含账号、密码或 Token。

用户提供的 nextbos ERP 系统登录约定为 `POST https://api.nextbos.cn/api/v1/auth/login`，JSON 请求字段为 `email`、`password`。登录成功响应的 Token 位于顶层 `token`，人员和企业标识分别为 `user.id`、`tenant.id`，过期时间为顶层 `expires_at`；响应不含业务 `code`。

第一版发送 JSON POST，accountField/passwordField 决定账号密码字段名；tokenPath/userIdPath/tenantIdPath/expiresAtPath/codePath 使用点分字段路径。`backend.loginResponseMode` 默认值为 `business-code`，保留原有登录业务码校验以兼容既有配置；nextbos 默认配置使用 `http-status`，仅登录请求跳过业务 code 校验，依据 HTTP 状态判断成功或失败，仍需校验登录响应中的 Token、人员、企业及配置的过期时间字段。不能直接把聊天中声称的人员信息当作绑定。

业务响应格式尚未核对：`codePath=code`、`successCode=200`、`unauthorizedCode=401`、`forbiddenCode=403` 只沿用原策略，业务请求仍执行现有的 codePath 和数字 code 校验，不受登录的 `http-status` 模式影响。业务工具接入时必须核实响应结构与错误码，并按实际约定调整配置；目前不能视为已适配 nextbos ERP 系统的所有业务接口。

业务请求与登录请求使用同一个 baseUrl。远端必须 HTTPS，仅回环地址允许 HTTP。禁止跟随重定向，业务路径必须位于 allowedApiPrefixes 下，禁止通过统一业务请求入口再次调用登录端点。可选 expiresAtPath 指向未来的 ISO 日期时间；nextbos 配置为 `expires_at`，未设置时以接口返回的登录失效为准。HTTP 或配置的业务错误码区分未登录、无权限、业务失败。

timeoutMs 默认 10000；maxLoginAttempts 默认 5，loginWindowMs 默认 60000。入站凭据有效期 ingressTtlMs 默认 30 分钟，maxPendingIngress 默认 1000。到期拒绝继续使用旧来源，不能自动继承到别的会话。

## 工具与内部服务

`auth_login` 只有 account/password 参数。成功返回 `{status:"authenticated",code:"AUTHENTICATED",message:"登录成功，可以继续操作。"}`；失败返回固定错误码和说明，不返回上游响应、Token 或密码。

业务插件通过 `ctx.enterpriseAuth.request(exec, {method, path, body?, idempotencyKey?})` 请求数据；exec 必须来自当前工具执行。该服务解析当前真实入站身份后取得 Token，没有 getToken 工具或接受模型填写 senderId 的参数。

可信 IM 适配器使用 `ctx.enterpriseAuth.registerIngress({sessionId,rpcId,principal:{platform,botId,senderId}})` 在提交消息前登记，rpcId 必须与随后真实 user/message 的 source.rpcId 一致。返回的释放函数必须在该消息对应执行彻底结束后调用。不能只登记 sessionId 并让所有未来消息继承身份；不能从模型参数反向填充 principal。本接口仅供宿主中受信任的接入代码使用，没有向聊天用户开放管理 HTTP 接口。

支持微信和飞书私聊，不支持群聊或子代理继承登录身份。微信适配器从准入后的真实 `from_user_id` 和运行配置中的机器人 `botId` 构造身份。飞书在 `src/channels/feishu/bridge.mjs` 的共用提交入口，仅接受 `chat_type=p2p`、真实 `sender.sender_id.open_id` 与 Host 配置中的 `botId`；不会回退使用 `user_id`，不会给群聊登记身份。两者共用 `src/channels/shared/harness-client.mjs` 与同进程 `harnessConnection` 登记。RPC 返回 accepted 不会释放；ask 完成、取消或异常退出时释放，TTL 到期也拒绝使用。不同平台的相同 botId/senderId 字符串仍是不同身份，微信登录不自动授权飞书。

插件在 `agent/pre-step` 读取本步最终输入及同一轮仍有效的登记，追加不含身份标识的来源说明。它仅帮助模型选择是否调用工具，不能授权；实际执行仍由实时 Session 事件与当前 assistant tool-call 校验。普通 Host instructions/notice/snapshot 不代表另一个用户，也不授予身份；混入未登记 Web 消息或其他发送者会使该轮失效。Web 全局提示应描述宿主提供 GUI，不应将宿主类型当作每条消息的来源。

新版来源说明使用 `source.kind=enterprise-auth`；允许 Harness 的 `runtime-context` 快照及清空标记，也保留 IM 补丁的旧 `plugin` 上下文格式。未知来源不会仅因声明 instructions/notice/snapshot 而被忽略，宿主上下文本身不能建立登录身份。

登录不会自动重放任何下单请求。后续订单工具负责保留业务参数、查单和幂等，不能把网络超时当作确定失败后重下。统一请求服务不自动重试写请求；结果不明返回 RESULT_UNKNOWN。

## 存储及日志

默认目录为当前 profile 的 `data/enterprise-auth/`；也可配置绝对路径 dataDirectory。目录权限 0700，key.bin 和 state.json 为 0600。绑定对象和 Token 采用 AES-256-GCM 加密，状态整体校验；不单独保存登录密码。最多 10000 个绑定，写入串行、原子替换，同一目录只允许一个运行实例。

密钥与数据必须一同备份，备份前停止 Harness；不要向模型、日志、Git 或聊天导出密钥和 Token。已有状态缺少密钥、状态被篡改或权限不正确时拒绝启动，不重置为空。异常退出留下 store.lock 时，必须先确认所有使用该目录的实例已退出、备份 key.bin/state.json，再人工处理残留锁；不能删除存活实例的锁。

加密保护磁盘文件，不构成同一操作系统用户内的隔离：能读取数据和密钥的进程仍有能力解密。部署时应限制 Agent 的任意文件/终端访问，或隔离凭据服务。宿主插件属于受信任代码，不能把插件内部服务当作针对恶意同进程插件的安全沙箱。

按用户选择，账号密码经过微信或飞书聊天与模型服务；Harness 本身还可能保存原始用户消息与工具参数。本插件的结果和展示卡片不回显凭据，但不会声称这些上游记录已被清除。不要在群聊中提供密码。

## 代码

- src/index.ts：Host 服务、生命周期与工具注册。
- src/tool.ts：auth_login 参数、工具结果和展示。
- src/ingress.ts：逐消息来源登记与执行身份解析。
- src/service.ts：登录流程、凭据版本、错误处理与请求调度。
- src/http.ts：可配置登录字段、固定业务源 HTTP 请求。
- src/store.ts：绑定和 Token 的加密、落盘、恢复与版本比较删除。

`npm test` 运行构建和后端测试；IM 接线测试默认读取当前用户 Web profile 的 IM 源码，也可通过 `DSH_IM_SOURCE=/path/to/patched/im` 指定。测试使用假账号、假 Token 和模拟网络，不进行真实 IM 发送或 ERP 登录。每个实际模型步骤新增一段来源说明；它会进入该会话记录，不包含 botId/senderId/凭据。
