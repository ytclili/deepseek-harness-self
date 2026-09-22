# Web Portal 登录页插件

将 NextBOS 智能体登录页面挂到 Harness Web profile。源码位于 `selfPlugin/web-portal`，不修改官方 `packages/`，不新增数据库或持久化文件。

## 当前能力

- 未登录访问 `/` 显示登录页；`/login` 可直接打开。
- 深色布局、粒子球、账号密码必填校验、密码显隐、回车提交和手机布局。
- 页面资源统一使用 `/web-portal/`，仅提供已构建的 JS、CSS、SVG，未知资源返回 404。
- 原生管理员启动链接 `/?token=...` 仍由 Harness Connection 验证和设置 Cookie；已获得原生 Cookie 的浏览器进入原 Harness 页面。
- `/api` 和实时连接继续由原插件处理。公开页面不注入 Harness 启动数据，不发放管理员 Cookie。

**这是登录界面插件，账号服务尚未接入。** 表单提交只演示加载和提示，清空密码，不发送网络请求、不保存账号密码、不创建登录态、不跳转进入 Harness。原生管理员 Cookie 仍代表当前实例的共享管理权限，并不代表独立用户。不能将本阶段当作多用户隔离方案，也不要向普通用户分发管理员 Token。

## 构建与测试

先按仓库文档安装并构建 Harness，然后在 Harness 根目录执行：

```sh
npm --prefix selfPlugin/web-portal run setup
npm --prefix selfPlugin/web-portal/client ci
npm --prefix selfPlugin/web-portal run check
npm --prefix selfPlugin/web-portal test
```

`setup` 将 Host 依赖链接到同一份 Harness，避免 Cordis 被重复加载。`client/` 独立维护 npm 锁文件，不纳入官方 pnpm workspace。构建输出为 `dist/` 和 `client/dist/`，均忽略入 Git。不要跨 Mac/Linux 复制 `node_modules`，应在服务器重新运行以上命令。

## 安装到 Web profile

在准备启用的机器上，从 Harness 根目录执行：

```sh
pnpm dsh plugin --profile web add link:./selfPlugin/web-portal --ignore-scripts
```

然后重启原有 Harness 进程。开发环境也可用以下命令启动；如果已有进程占用 3080，先关闭对应进程或选择另一个端口，不要重复启动包含 IM/定时任务的同一 profile：

```sh
pnpm dsh web --no-open
```

访问 `http://127.0.0.1:3080/login` 查看页面。匿名访问根路径也显示该页面。域名部署继续沿用既有 `trustedHosts` 设置；本插件不更改监听端口、反向代理或域名配置。重建插件后重启 Harness，使内存中的页面和资源更新。

## 配置

默认 `cordis.patch.yml` 注册 `web-portal`，设置 `takeoverRoot: true`。如只想提供 `/login`，在相应 profile 的补丁文件加入：

```yaml
- id: web-portal
  config:
    takeoverRoot: false
```

`harnessDistIndex` 是可选的原生前端 `index.html` 绝对路径，只有部署使用自定义原生前端构建时需要设置。默认解析当前 Harness 的 `@deepseek-ai/dsh-web-frontend/dist/index.html`。缺少构建文件时插件启动失败，不会留下部分路由。

## 取消启用

```sh
pnpm dsh plugin --profile web remove dsh-web-portal
```

再重启原有进程。插件所有路由通过 Cordis effect 注册，卸载会撤销自身路由，恢复官方首页的鉴权行为。

## 验证范围

`npm test` 使用临时端口、临时原生页面和内存凭据，组合真实 Cordis、WebServer、Connection 插件，覆盖匿名入口、原生 Token/Cookie、未登录 API 拒绝、Host/Origin 拒绝、资源范围、HEAD、非读取方法拒绝、卸载重载及加载失败清理。测试不访问 ERP、不调用模型、不创建业务数据。

不发布独立 runtime invariant：插件没有独立持久化状态，所有路由生命周期由 Cordis effect 管理，安全行为通过 HTTP 测试观察。

后续真实登录需独立接入账号验证、用户身份和实例/数据隔离；微信/飞书身份与 Web 身份的绑定不在本阶段实现。
