# Web Portal 企业账号登录网关

`dsh-web-portal` 用独立 Harness profile 提供账号密码登录，并将通过验证的用户连接到各自的 Docker Harness 实例。兼容 Harness 0.1.7-alpha.1；源码和部署脚本位于 `selfPlugin/web-portal`，不修改官方 `packages/` 或 ERP 数据库。

## 登录与隔离

浏览器提交账号密码到 `/portal/login`，网关复用 `enterprise-auth` 的 HTTP 登录适配器调用配置的业务后端。只有后端返回有效 Token、租户 ID 和用户 ID 后，才准备用户实例并发放登录 Cookie。错误密码返回 401；后端或实例启动失败返回 503，不发放登录态。密码不落盘，浏览器不接收业务 Token、模型密钥或 Harness 原生管理员 Token。

实例由后端身份中的 `(tenantId, userId)` 决定。不同用户和不同租户使用独立容器、网络、HOME、工作目录、会话文件与业务凭据。同一身份在多个浏览器登录时共享自己的工作区。浏览器提供的用户名、URL 参数或转发头不能指定实例目标。网关代理 HTTP 和原生 WebSocket，并替换上游凭据。

浏览器登录态保存在网关内存中，最长有效期由 `sessionTtlMs` 和业务 Token 过期时间共同限制。退出、过期立即撤销该浏览器的 HTTP 流和 WebSocket；最后一个登录态消失后停止该用户实例，但保留其 HOME 和工作目录。网关重启后需重新登录。已在线的同用户凭据刷新失败时，旧实例与全部同身份登录态会失效，避免继续使用已失效的业务身份。

用户模型请求通过网关的限时能力令牌转发，真实模型密钥只在网关中读取。用户容器不挂载 Docker socket、管理员 `.dsh` 或其他用户目录；用户可运行自己实例内的 Harness 工具，因此部署必须同时安装并验证 Docker 网络隔离规则。仅创建不同目录不能替代容器和网络隔离。Web 用户不会自动继承管理员微信、飞书绑定或定时任务。

## 页面与接口

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| `/` | GET / HEAD | 匿名时显示登录页，登录后代理自己的 Harness |
| `/login` | GET / HEAD | 登录页；已登录时提供进入工作区和退出按钮 |
| `/portal/login` | POST | JSON `{ "account": "…", "password": "…" }`，调用业务后端验证 |
| `/portal/session` | GET | 查询当前浏览器是否登录及过期时间 |
| `/portal/logout` | POST | 撤销当前浏览器登录态并清 Cookie |
| `/web-portal/*` | GET / HEAD | 已构建的登录页资源与账号入口样式 |

工作区首页提供“账号 / 退出”入口，前往 `/login`。登录页保留账号密码必填校验、密码显隐、回车提交及手机布局；错误时清空密码。会话 Cookie 为 HttpOnly、SameSite=Strict，HTTPS 环境同时使用 Secure。请求 Host/Origin 必须匹配 `publicOrigin`，写操作需要同源 Origin。

## 配置与部署入口

网关使用专用 `portal` profile，默认监听 23080；已有管理员和 IM 服务继续使用 3080。不要将本插件加入已有的 `web` profile：插件检测到共享原生 connection 时会拒绝启动。单独运行 `docker start deepseek-harness` 只会启动原服务，不会自动出现登录网关。

完整的 Linux 构建、私有配置、网络验证、启动与更新步骤见 [iStoreOS 部署说明](deploy/DEPLOYMENT.md)。配置参考 [gateway.json](examples/gateway.json)：

- `backend`：复用企业登录适配器字段，示例将账号映射为 `email`，从返回值读取 `token`、`user.id`、`tenant.id` 和 `expires_at`。根据真实接口核对；不会把任意非空账号密码视为成功。
- `publicOrigin`：浏览器实际访问的完整 origin。示例为回环验证地址；公网反向代理切换时设置 `https://harness.nextbos.cn` 并保留 Host、Origin 和 WebSocket 转发。
- `docker`：镜像、宿主机数据目录及网关容器内挂载路径；限制实例数量、CPU、内存、PID、总启动时限和单次 Docker 请求时限。iStoreOS 使用 `vfs` 存储驱动时，容器创建可能超过两分钟，应相应提高 `activationTimeoutMs` 和 `requestTimeoutMs`。
- `model`：上游模型地址、模型名及仅网关可读的密钥文件。用户侧地址固定指向网关模型路由。
- `networkPolicyFile`：宿主机实际安装规则并通过检查后生成的标记；缺失或不匹配时拒绝启动。
- `businessTimeoutMs` / `goodsMaxItems`：业务工具超时不超过 60000 毫秒，每次商品查询上限不超过 100。

服务器目录统一位于 `/mnt/sata4-2/www/code/deepseek-harness-runtime/portal`：`gateway/` 存放私有配置与模型密钥，`users/` 存放每用户数据，`build/` 存放镜像构建上下文。模型密钥、业务 Token、密码、会话文件和构建输出不得提交 Git。备份数据时同时保留目录权限；日志不得输出凭据。

用户启动脚本通过正式编译后的 `dsh` CLI 启动 `web` profile，在其 profile 补丁中配置模型和界面。遗留 `settings.yaml` 会原样重命名为带随机后缀的备份，避免旧配置导入覆盖网关生成的模型配置；原生凭据与会话数据保留。

## 本地构建与验证

先按仓库说明完成官方 Harness 构建及 `enterprise-auth`、`enterprise-tools` 构建，再在仓库根目录运行：

```sh
npm --prefix selfPlugin/web-portal run setup
npm --prefix selfPlugin/web-portal/client ci
npm --prefix selfPlugin/web-portal run check
npm --prefix selfPlugin/web-portal test
```

`setup` 在创建链接前逐项检查 manifest 中的 peer 版本，将插件连接到同一份 Harness。插件不加入官方 pnpm workspace；`dist/`、`client/dist/` 和依赖目录不入 Git。Mac 与 Linux 的依赖及原生产物不能混用。

测试使用临时目录、端口和测试凭据，覆盖登录拒绝、后端身份选实例、跨租户隔离、退出与过期、流和 WebSocket 撤销、凭据刷新并发、模型代理与 Docker 请求约束。正式 CLI profile 测试启动两个真实 Harness 实例，验证模型加载、会话列表分离和原生 Cookie 不能跨用；独立网关测试通过真实 HTTP 登录适配器拒绝错误密码。测试不调用真实 ERP 或模型，也不创建业务订单。

Docker API fixture、部署脚本测试与本机 CLI 验证不等于 Linux 容器隔离验收。服务器启用前仍需执行部署脚本中的实际 nft 检查和网络探测；实时检查严格验证优先级为 -20 的独立隔离表，并接受 nft 对集合和条件表达式的等价规范化。公网域名切换单独执行。独立持久化关系由目录、Docker 配置及 HTTP 行为验证，本插件不发布空的 runtime invariant。
