# 自定义插件

三个插件随 Harness 仓库一起维护，源码纳入 Git。依赖、构建产物、本地备份和凭据不入库。插件保持独立包，不加入官方 pnpm workspace。

```text
selfPlugin/
  enterprise-auth/      企业登录和身份绑定
  enterprise-tools/     商品查询工具
  kaidanba-scheduler/   定时商品推送
```

## 构建

先在 Harness 根目录安装并构建官方项目（`pnpm install`、`pnpm run build`），再从同一根目录执行：

```sh
npm --prefix selfPlugin/enterprise-auth run setup
npm --prefix selfPlugin/enterprise-auth test
npm --prefix selfPlugin/enterprise-tools run setup
npm --prefix selfPlugin/enterprise-tools test
npm --prefix selfPlugin/kaidanba-scheduler ci --ignore-scripts
npm --prefix selfPlugin/kaidanba-scheduler test
npm --prefix selfPlugin/kaidanba-scheduler run test:client
```

`enterprise-tools/harness-version.txt` 记录兼容的 Harness 基准 commit；setup 比对 HEAD 中 `selfPlugin/` 以外的文件，允许单独提交插件代码，不校验未提交的修改。官方更新后先验证兼容性，再更新版本记录。`enterprise-auth` 的 setup 也检查 Harness tools 包版本。不要直接复制其他机器的 node_modules 或绝对路径链接。

## 接入和运行

本机 Web profile 已使用本目录的新路径，日常只需重新构建改动的插件并重启 Harness。新服务器在准备好 Web profile 和 IM 插件后，从 Harness 根目录执行以下命令建立当地路径链接：

```sh
pnpm dsh plugin --profile web add link:./selfPlugin/enterprise-auth --ignore-scripts
pnpm dsh plugin --profile web add link:./selfPlugin/kaidanba-scheduler --ignore-scripts
npm --prefix selfPlugin/enterprise-tools run install:local
```

按 [enterprise-tools 的配置说明](enterprise-tools/README.md) 设置业务服务地址和 Token 文件，按 [enterprise-auth 的补丁说明](enterprise-auth/README.md#微信与飞书-im-接线补丁) 安装对应版本的 IM 补丁后，在 Harness 根目录执行 `pnpm dsh web --no-open`。三个插件由 Harness 加载，无需各自启动常驻进程。

源码目录统一不代表运行数据已迁入仓库。Web profile 配置和 IM 状态仍在 `~/.dsh/profiles/web/`，授权数据在其 `data/enterprise-auth/`，定时任务在其 `data/kaidanba-scheduler/`，商品工具 Token 默认在 `~/.dsh/secrets/enterprise-tools.token`。部署新服务器时单独配置或按各插件的备份恢复说明迁移，不能只复制仓库就得到原来的登录和任务数据。

## 更新官方代码

先提交自己的插件修改，再拉取官方更新。只改 `selfPlugin/` 时，通常不会与官方源码冲突；双方修改同一文件同一区域、官方新增同名路径，或本地未提交改动会被覆盖时，仍可能冲突或阻止拉取。Git 合并成功也不保证插件接口兼容，更新后需重新构建和验证。
