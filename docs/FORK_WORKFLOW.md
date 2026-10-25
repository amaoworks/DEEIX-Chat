# amaoworks Fork 同步与发布流程

`amaoworks/DEEIX-Chat` 是独立维护、自用和发布的 fork。`DEEIX-AI/DEEIX-Chat` 作为上游代码来源，定期将其更新合入本仓库，同时保留本地修改。

## 仓库与分支职责

| 名称 | 用途 |
| --- | --- |
| `upstream` | `DEEIX-AI/DEEIX-Chat`，只用于获取上游代码。 |
| `origin` | `amaoworks/DEEIX-Chat`，本地代码的推送和发布目标。 |
| `dev` | 整合上游更新和自用修改，日常工作默认在这里进行。 |
| `main` | 接收准备发布的 `dev` 代码，作为自用版本的发布分支。 |
| 自用 tag | 标记明确的发布版本，例如 `v0.4.4-1`。 |

流程：`upstream/main → origin/dev → origin/main → 自用 tag → GitHub Actions 构建与 Release`。

## 同步上游

1. 获取 `origin` 和 `upstream/main` 的最新代码。
2. 在本地 `dev` 整合远端 `dev`，并纳入 `origin/main` 中尚未合入的发布配置和修改。
3. 将 `upstream/main` 合入 `dev`，逐处解决冲突，保留自用功能与上游更新。
4. 保留 amaoworks 的发布工作流、镜像地址、品牌配置和版本约定；不要直接用上游配置覆盖这些内容。
5. 完成与改动相关的检查后，按要求提交、推送到 `origin/dev`。

仅要求同步上游时，工作停在 `dev`，不自动发布、不向上游提交 PR。

## 发布自用版本

1. 按用户指定的版本更新根目录 `VERSION`。例如上游版本为 `0.4.4`，自用版本可以是 `0.4.4-1`、`0.4.4-2`。
2. 执行 `pnpm api:generate` 同步各组件版本及 API 文档，并同步 `Cargo.lock` 中 `deeix-chat-desktop` 包自身的版本；不顺带升级其他依赖。
3. 在 `.github/release-notes/<tag>.md` 写入基于实际代码变化的发布说明。
4. 将发布提交合入本地 `main`。`dev` 已包含远端 `main` 历史时，使用快进合并。
5. 在 `main` 的发布提交上创建对应 tag，将 `dev`、`main` 和本次 tag 推送到 `origin`。不要批量推送从上游获取的其他 tag。
6. 由 GitHub Actions 编译、构建镜像并创建 GitHub Release；确认发布操作已触发即可。

推送示例（版本已同步、提交已完成，且工作区干净）：

```bash
git switch main
git merge --ff-only dev
release_tag="v$(cat VERSION)"
git tag -a "$release_tag" -m "Release $release_tag" main
git push --atomic --no-follow-tags origin dev:dev main:main "refs/tags/$release_tag:refs/tags/$release_tag"
```

用户要求“推送、合入 main、打 tag、release”时，完成这些操作，不把等待 GitHub Actions 编译完成作为推送的前置条件，也不默认在本地重复进行完整构建。除非用户明确要求等待，报告已推送的提交、tag、Release 地址及构建状态即可；构建尚未完成时，不宣称镜像或安装包已经可用。

## GitHub Actions 去重约定

目标规则：

- `dev/main` 推送只执行必要检查。
- **自用 tag 是唯一发布入口**，触发镜像、安装包构建和 GitHub Release 创建。
- 收敛 `main` 根据 `VERSION` 自动打 tag 并派发构建的另一条发布入口。
- 同步上游时继续保留本 fork 的这些触发规则。

**当前状态：触发去重尚未实施。** `image.yml` 和 `vocechat-image.yml` 仍同时监听 `dev`、`main` 和 tag 推送；`release-tag.yml` 仍监听 `main` 的 `VERSION` 变化。因此，同一提交仍可能重复构建。本文档只固化操作约定，修改工作流需要另行实施。
