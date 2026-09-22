# 企业工具

DeepSeek Harness 原生插件，当前提供 `goods_list`。插件在根层注册，因此未过滤它的 Web / 同 Host 飞书会话均可调用；用户问“有哪些商品”或“查询商品列表”时，模型可选择该工具。PTC 模式通过 `run_code` 中的 `tools.goods_list({})` 调用。此包没有独立 HTTP 服务，无需单独常驻启动。

## 文件与扩展

- `src/index.ts`：插件入口，统一注册工具。
- `src/tools/goods-list.ts`：工具描述、返回字段、商品解析及展示。
- `src/api-client.ts`：固定 GET 请求、Bearer 认证、取消、超时与响应上限。
- `src/config.ts`：插件配置及校验。
- `cordis.patch.yml`：通过包管理器安装时使用的组合包配置。
- `scripts/install-local.mjs`：为当前本地 Web profile 添加绝对入口，备份并保留已有插件配置。

增加工具时，在 `src/tools/` 新增定义，并在 `apply()` 中注册。业务接口调用继续复用认证与错误处理；不修改 Harness 核心。

## 本地准备

要求 Node.js `^22.19 || >=24`，所属 `deepseek-harness` 已安装依赖并构建。`harness-version.txt` 记录兼容基准 commit，setup 要求 HEAD 中 `selfPlugin/` 以外的文件与该基准一致，单独提交插件改动不影响校验；不会校验未提交的修改。源码位于 `selfPlugin/enterprise-tools/`，开发脚本默认链接上两级 Harness 目录的依赖，不下载新依赖，也不修改其源码。在本插件目录执行：

```sh
npm run setup
npm run build
npm run check
npm test
```

需要指定其他 Harness checkout 时执行 `node scripts/link-harness.mjs /绝对路径/deepseek-harness`。

当前兼容基准为 Harness 0.1.7-alpha.1、Cordis 4.0.3、Schemastery 3.18.3。setup 同时核对 peerDependencies 中的依赖版本，官方更新后需重新验证插件再更新版本和基准；不能直接跳过校验。

## 认证与本地启用

Token 是纯文本单行文件，不带 `Bearer ` 前缀，权限必须为 `600`。默认本机位置是 `$HOME/.dsh/secrets/enterprise-tools.token`。不要把 Token 写进代码、Prompt、配置 patch 或聊天中。插件每次调用读取该文件，更新 Token 后无需重启；读取失败明确报错，不退回匿名请求。

在终端中安全录入 Token（macOS/Linux Bash；输入不回显）：

```sh
bash -c 'umask 077; mkdir -p "$HOME/.dsh/secrets"; read -r -s -p "业务 Token: " enterprise_token; printf "\n"; printf "%s" "$enterprise_token" > "$HOME/.dsh/secrets/enterprise-tools.token"; unset enterprise_token'
npm run install:local
```

安装脚本默认修改 `$HOME/.dsh/profiles/web/cordis.patch.yml`，保留其他插件配置，原文件备份到 `$HOME/.dsh/backups/enterprise-tools/`。可通过 `DSH_HOME`、`ENTERPRISE_TOKEN_FILE` 指定其他运行目录或凭证文件路径。重复安装在原位置更新管理块，保留其后覆盖或禁用条目的顺序；会恢复管理块的默认参数，因此自定义参数请在安装后修改。已有非空流式 YAML 数组会转换为块式布局，其行内注释保留在原文件备份中，`!!js` 表达式保持原含义且安装时不执行。

已运行的 Web profile 若开启 `patchReload: live`，新增配置可以热加载；否则在原 Harness 终端按 Ctrl+C 后重新 `pnpm dsh web`。不要同时启动第二个飞书连接。修改 TypeScript 后执行 `npm run build` 并重启 Harness，同路径代码没有自动重载保证。无需启动 Hermes。

在 Web 或飞书输入“请调用 goods_list 查询商品列表”。飞书需要已经连接本 Host；此插件不安装或替换飞书通信插件。

只运行真实工具、不开模型且不发飞书消息的自检：

```sh
ENTERPRISE_TOKEN_FILE="$HOME/.dsh/secrets/enterprise-tools.token" npm run smoke
```

自检只输出成功状态和数量，不输出 Token 或商品明细。

## 配置与响应

`baseUrl` 默认为 `http://127.0.0.1:5002`，必须是没有账号、路径、查询参数的 origin；仅回环地址允许 HTTP，远端使用 HTTPS。`tokenFile` 是凭证文件绝对路径。`timeoutMs` 默认 10000（1–60000），`maxResponseBytes` 默认 1048576（最大 1 MiB），`maxItems` 默认 100（1–100）。

`goods_list` 只接受 `{}`，固定访问 `/api/v1/shop/goods`。按现有接口读取 `{code: 200, data: {items, total}}`，保留 `id/name/unit/price/inventory/spec/image_url`，返回 `{items, total, returned_count, has_more}`。超过条数限制截取前 N 条并标记 `has_more`；不自动翻页。字段缺失或类型不符直接失败，不猜测币种，不把不同单位库存相加。

不跟随重定向，不自动重试。取消信号和超时覆盖请求及响应体读取。HTTP/业务错误、错误原文、响应附加字段、请求头均不会直接返回给模型。卡片标题为“企业工具 · 商品列表”。

## 服务器部署

部署包含 `selfPlugin/` 的整个 Harness 仓库，先在服务器安装并构建固定版本 Harness，再在 `selfPlugin/enterprise-tools/` 执行 setup/build/check/test。不要复制 macOS 的 node_modules；链接与构建在目标机器重建。Token 单独通过服务器配置管理，按上面的本地启用方式接入服务器已有 profile，并把 baseUrl 改为服务器可访问的业务服务地址。容器内 `127.0.0.1` 指容器本身；跨容器/机器请使用 HTTPS 服务入口。

也可在 Harness 根目录执行 `pnpm dsh plugin --profile web add link:./selfPlugin/enterprise-tools --ignore-scripts`，随后配置 `ENTERPRISE_TOKEN_FILE` 并重启；此方式和 `install:local` 选一种，避免重复插件配置。包名为 `dsh-enterprise-tools`，可私有维护，不必发布市场。

## 当前范围

第一版使用单个配置账号的 Token，调用者共享该账号能访问的数据。尚未实现飞书员工→业务用户/门店的权限映射，不能把“允许访问机器人”等同于业务授权。没有 Text2SQL、图表、商品修改或分页参数。本地接口当前即使不带 Token 也能返回商品；插件仍按配置发送 Bearer，后端是否校验 Token 由业务服务负责。

测试使用临时本地服务与假 Token，覆盖真实 Cordis 注册/系统提示组装/工具执行/卸载及错误隔离；不会使用真实飞书或模型 API。
