# Enterprise Auth Implementation Plan

Goal: 实现已确认的首个 nextbos ERP 系统 enterprise-auth 插件：auth_login、可信 IM 身份绑定、加密 Token 持久化及业务 HTTP 请求服务。账号密码由模型提取并仅用于登录；不实现 refresh token、订单工具、前端登录页或业务权限副本。

Architecture: 独立 Cordis Host 插件；身份由可信接入适配器提供，不能接受模型填写微信 ID。登录 API 请求/响应必须依据用户提供的接口约定配置，不猜测正式接口。现有业务接口继续负责授权。

已确认登录约定：`POST https://api.nextbos.cn/api/v1/auth/login`，JSON 请求字段 `email`、`password`；成功响应字段为顶层 `token`、`user.id`、`tenant.id`、顶层 `expires_at`，无业务 `code`。示例与 bundle 的 `config.backend` 同步使用 `loginResponseMode: http-status`；示例文件不自动读取，bundle 默认已配置，不含真实账号、密码或 Token。

登录模式实现由主代理完成：新增 `backend.loginResponseMode`，默认 `business-code` 保持兼容；`http-status` 仅对登录跳过业务 code 校验，业务请求继续校验 codePath 与数字 code。业务响应格式尚未核对，`codePath=code`、`successCode=200`、`unauthorizedCode=401`、`forbiddenCode=403` 仅沿用原策略，业务工具接入时必须核实，不能据此宣称所有 nextbos 业务接口已适配。

Data impact: 不修改业务数据库、Harness 会话 schema 或现有企业工具的固定 Token。新增 profile 内独立私有目录，保存 AES-256-GCM 加密的绑定记录及单独的 0600 密钥。绑定键包含平台、机器人、发送者；记录系统人员、租户、Token、可选过期时间及凭据版本。不保存账号密码。写入串行且原子，单实例锁；注销/401 按凭据版本删除，避免旧请求误删新登录。损坏、密钥缺失或未验证来源时拒绝继续。

Authorization: 用户明确确认服务器绑定/Token 存储方案并要求开始写第一个插件。继续完成必要实现；不重复申请批准。无 Git 分支/提交，无真实登录、下单或外发消息测试，无前端测试。

- [x] 核对 Harness tool/IM 真实身份扩展点；确认现有 IM 缺少公开可信发送者传递接口。
- [x] 定义共享类型、配置与安全错误。
- [x] TDD 实现私有加密存储、重启恢复、多用户隔离及并发写入。
- [x] TDD 实现登录及同源业务请求；Token 不进入工具输出，401/403 分离，不自动重试写请求。
- [x] 注册 auth_login 与内部服务、实现可信来源登记与解析、配置示例和安装说明。
- [x] 完成最终独立复核、构建和后端假数据测试；同步独立项目。

此前交付验证记录（不代表本轮验证）：`/Users/yifeisun/code/github_code/enterprise-auth` 已链接本地 Harness 依赖，`npm test` 构建成功，96/96 后端测试通过。复核发现的编码路径绕过和不明确写结果分类问题均已增加回归并修复。当时未安装到运行 profile，未启动真实登录或 IM 发送。

本轮文档任务范围：仅更新 `/private/tmp/enterprise-auth` 中 README.md、examples/backend.example.json、cordis.patch.yml、package.json、docs/implementation-plan.md。仅做文档与配置静态核对，以及 src/http.ts、src/config.ts、tests/http.test.mjs 的只读复核；不修改源码或测试、不运行测试、不使用真实网络、不读取秘密、不操作 Git、不写入正式目录；不构成真实登录验证。

本轮主代理验证记录：据主代理反馈，新增 4 项 HTTP 测试并参数化 Host lifecycle 后，`npm test` 已 101/101 通过；本次文档任务未重复运行测试。只读复核未发现登录模式改动的阻塞项：无 code 的成功登录仍验证凭据、身份和过期时间，HTTP 错误状态先于模式分支处理，业务响应仍执行 codePath 与数字 code 校验。正式目录尚待同步。

真实联调待办（不属于已验证结果）：

- [x] 用户已提供真实登录 API 请求/响应约定，同步 backend 示例与 bundle 默认配置。
- [x] 主代理完成登录响应模式实现与对应验证（主代理反馈：101/101 通过）。
- [ ] 同步本轮改动到正式目录。
- [ ] 接入完成后验证 nextbos ERP 系统真实登录；目前未进行。
- [ ] 为当前 IM 实现可信发送者到 promptRpcId 的适配，连通微信私聊。
- [ ] 核实 nextbos ERP 系统业务响应格式及错误码；现有业务工具尚未改用 enterpriseAuth.request，后续接入并实现需要时的待办恢复和下单幂等。

Verification: Node test runner + TypeScript/build。仅使用假 Token/密码与本机模拟登录服务。验证身份伪造拒绝、跨用户隔离、加密后不出现假 Token、重启恢复、失败不保存、重定向不泄漏凭据、旧401不清除新Token、无来源/无Token拒绝、取消和超时、生命周期与工具输出。
