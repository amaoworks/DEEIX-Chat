# 站内消息（VoceChat）部署说明

首版使用 DEEIX 自己的 UI 与 API；VoceChat 仅在 Docker 内网保存消息并提供实时事件。浏览器不会直接访问 VoceChat，也不会拿到它的 `X-SECRET` 或访问令牌。

## Docker Compose 自动初始化

将 `VOCECHAT_IMAGE` 设为已经审查过的 VoceChat tag 或 digest；不要使用浮动的 `latest`。然后启动 overlay：

```bash
VOCECHAT_IMAGE='privoce/vocechat-server@sha256:dc3ad835c05e997852d0327aba958e11e46730ae89e249faa0b760931ac9eb87' \
  docker compose -f docker-compose.yml -f docker-compose.vocechat.yml up -d
```

`vocechat-init` 会在 VoceChat 健康后自动完成以下操作：

1. 首次部署时生成随机管理员凭据并调用初始化 API；凭据只保存在独立的 `vocechat_init_state` 卷。
2. 获取 third-party secret，以 `0400` 写入 `vocechat_secrets` 卷。
3. DEEIX app 只读挂载 secret 卷，通过 `INTERNAL_MESSAGING_SECRET_FILE` 读取密钥。
4. 初始化成功后该容器退出，DEEIX app 才开始启动。后续启动会验证并复用已有密钥。

使用该 overlay 时不需要在 `config.yaml` 中填写 `secret`，也不需要手工创建 VoceChat 管理员。overlay 会自动设置：

```yaml
internal_messaging:
  enabled: true
  vocechat_url: "http://vocechat:3000"
  secret_file: "/run/secrets/vocechat/third-party-secret"
  timeout_ms: 10000
```

随附的 VoceChat 配置已经开启 `[login] third_party = true`，不要关闭。

## 本地源码调试

一条命令同时启动 VoceChat、DEEIX API 和 DEEIX Web：

```bash
./scripts/dev-deeix.sh
```

脚本以前台方式运行 DEEIX，Web 明确监听 `0.0.0.0:3000`，启动时会检测主机主要 IPv4 并同时输出本机和外部访问地址。按 `Ctrl+C` 后会停止开发容器但保留本地数据。已有根目录 `config.yaml` 时脚本会沿用它；没有时自动使用隔离的 SQLite/内存缓存配置，数据位于 `.deeix/deeix/`。

自动检测适用于直接拥有可达 IPv4 的主机。NAT、多网卡或域名访问时通过 `DEEIX_DEV_ADVERTISE_HOST` 指定浏览器实际使用的地址：

```bash
DEEIX_DEV_ADVERTISE_HOST='203.0.113.10' ./scripts/dev-deeix.sh
```

脚本会把该地址同步传入 Next.js 的 `allowedDevOrigins`，因此外部浏览器可以加载开发资源和 HMR。需要同时允许多个域名或 IP 时可使用逗号分隔：

```bash
DEEIX_DEV_ADVERTISE_HOST='203.0.113.10' \
DEEIX_NEXT_ALLOWED_DEV_ORIGINS='203.0.113.10,dev.example.com' \
  ./scripts/dev-deeix.sh
```

开发 Web 和 API 会临时暴露在网络上，请用防火墙或安全组限制来源，并在调试完成后按一次 `Ctrl+C` 关闭。启动器会删除临时 API 容器并终止整个 Turbo/Next/pnpm 进程组，最多等待 3 秒后强制清理，避免残留后台进程继续占用 `3000` 或 `8080`。VoceChat 仍只监听 `127.0.0.1`，并会随启动器退出而停止。

后端使用固定 Go 1.26.5 的开发工具链容器，不依赖宿主机的 `make` 或 Go 版本。第一次运行会构建该轻量镜像并下载 Go 模块，后续启动复用 `.deeix/deeix/` 下的模块与构建缓存；源码和 SQLite 数据仍位于当前工作区。

如需覆盖浏览器访问的 API 地址或保留 VoceChat 容器：

```bash
DEEIX_DEV_API_URL='http://server.example:8080' \
DEEIX_DEV_WEB_URL='http://server.example:3000' \
DEEIX_DEV_KEEP_VOCECHAT=true \
  ./scripts/dev-deeix.sh
```

以下命令只启动 VoceChat，适合分别调试前后端：

一条命令启动并自动初始化本地 VoceChat：

```bash
./scripts/dev-vocechat.sh up
```

脚本会输出可直接放入本地 `config.yaml` 的配置。生成的数据、管理员状态和 secret 位于被 Git 忽略的 `.deeix/vocechat/`；不需要复制或显示 key。

每次执行 `up` 都会重新创建无状态的开发容器，以确保端口、镜像、配置和目录挂载使用本次参数；消息数据、管理员状态和 secret 会继续复用 `.deeix/vocechat/` 中的持久化内容。

当 `VOCECHAT_DEV_BIND=0.0.0.0` 时，脚本会检测主机的主要 IPv4 地址，并用该地址输出可访问 URL 和 `vocechat_url`。多网卡、NAT 或需要公布公网地址时，可通过 `VOCECHAT_DEV_ADVERTISE_HOST` 明确指定，例如：

```bash
VOCECHAT_DEV_BIND=0.0.0.0 \
VOCECHAT_DEV_PORT=3101 \
VOCECHAT_DEV_ADVERTISE_HOST=203.0.113.10 \
  ./scripts/dev-vocechat.sh up
```

常用命令：

```bash
./scripts/dev-vocechat.sh status
./scripts/dev-vocechat.sh logs
./scripts/dev-vocechat.sh down
```

`down` 只移除开发容器，保留消息数据和密钥。

默认只监听 `127.0.0.1:3001`。SSH 远程开发时，建议继续使用本地监听并通过 SSH 转发端口。如果确实需要允许局域网或外部主机直接访问，可重建开发容器并设置监听地址：

```bash
./scripts/dev-vocechat.sh down
VOCECHAT_DEV_BIND=0.0.0.0 ./scripts/dev-vocechat.sh up
```

也可通过 `VOCECHAT_DEV_PORT` 修改宿主机端口。监听 `0.0.0.0` 会将 VoceChat 暴露到服务器网络，请同时使用防火墙或安全组限制来源。

## 恢复与轮换

正常重启不需要任何管理员输入。如果 VoceChat 数据仍在，但 `vocechat_secrets` 卷损坏，初始化器会使用独立状态卷中的凭据恢复 secret。

如果 secret 和初始化状态卷同时丢失、而 VoceChat 数据仍然存在，则必须提供已有管理员凭据一次，不能绕过 VoceChat 权限边界：

```bash
VOCECHAT_ADMIN_EMAIL='admin@example.test' \
VOCECHAT_ADMIN_PASSWORD='replace-me' \
  docker compose -f docker-compose.yml -f docker-compose.vocechat.yml \
  run --rm \
  -e VOCECHAT_ADMIN_EMAIL \
  -e VOCECHAT_ADMIN_PASSWORD \
  vocechat-init
```

轮换 third-party secret：

```bash
docker compose -f docker-compose.yml -f docker-compose.vocechat.yml \
  run --rm -e VOCECHAT_ROTATE_SECRET=true vocechat-init
docker compose -f docker-compose.yml -f docker-compose.vocechat.yml restart app
```

已用 VoceChat OpenAPI `0.5.32` 验证的最小接口为：`/health`、`/api/token/create_third_party_key`、`/api/token/login`、`/api/user/{uid}/send`、`/api/user/{uid}/history` 与 `/api/user/events`。升级镜像前请重新验证这些接口、第三方登录开关和消息时间格式。

## 运行边界

- DEEIX 用户目录是唯一可信来源；只有 `active` 用户可被选择和收发消息。
- 用户第一次打开聊天或成为消息接收方时，DEEIX 后端会自动创建或恢复 VoceChat 身份，并持久化绑定关系。
- VoceChat 停止时，DEEIX 的 AI 聊天、登录与其他功能不受影响；站内消息入口会隐藏或返回暂不可用。
- 请在实际对外、超过免费限制或商业使用前确认 VoceChat 当前许可证和授权条件。
