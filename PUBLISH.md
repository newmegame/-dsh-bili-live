# 发布到 GitHub 和 DSH 社区

这个目录就是 Git 仓库的根目录，所有运行文件都在这里，没有构建步骤。

## 一、上传到 GitHub（浏览器操作，约 2 分钟）

1. 打开预填好的新建仓库页：

   https://github.com/new?name=dsh-bili-live&description=B%E7%AB%99%E7%9B%B4%E6%92%AD%E9%97%B4%E5%BC%B9%E5%B9%95%E8%87%AA%E5%8A%A8%E5%9B%9E%E5%A4%8D%E7%9A%84%20DSH%20%E6%8F%92%E4%BB%B6&visibility=public

   仓库名建议用 `dsh-bili-live`（和已有仓库不冲突，owner 不同即可）。**不要**勾选 “Add a README file”，因为本地已经有 README。

2. 点 **Create repository**。

3. 在新仓库页面点 **uploading an existing file**。

4. 把本文件夹 `dsh-bili-live` 里的**所有文件和文件夹**拖进浏览器上传区（Chrome/Edge 支持拖文件夹并保留目录结构）。

5. 点 **Commit changes**。

6. 在仓库右侧 About 里点齿轮，加 topic：`dsh-plugin`、`deepseek-harness`、`bilibili`、`danmaku`。

上传完成后，别人可以用下面任一方式安装：

- 下载/克隆仓库，在 DSH 里对助手说：`安装本地插件：<仓库文件夹绝对路径>`；
- 如果你的 DSH 支持从 git 安装：`安装 git 仓库：https://github.com/<你>/dsh-bili-live`。

## 二、发布到 npm（DSH 社区市场索引要求）

`dshmarketplace.dev`、`awesome-dsh-plugin.com` 这些社区索引都是按 **npm 包**收录的；只上传 GitHub 不会被它们收录。GitHub 上带 `dsh-plugin` topic 的市场（如 dsh-plugin-mall）能搜到仓库，但仍建议发 npm。

1. 注册/登录 npm：`npm login`。
2. 选一个还没被占用的包名（`dsh-bili-live` 目前 npm 上未被占用，但可能随时变化；也可以用自己的 scope，例如 `@yourname/dsh-bili-live`）。
3. 改名（包名必须同时出现在三个地方，用脚本一次改完）：

   ```bash
   node scripts/rename-package.mjs @yourname/dsh-bili-live
   ```

   脚本会改 `package.json` 的 `name`、`client.js` 里的模块 `id`、`cordis.patch.yml` 里的插件 `name`。

4. 发布：

   ```bash
   npm publish --access public
   ```

5. 发布后，社区索引会在每日重建时收录；也可以到 awesome-dsh-plugin 的仓库提 PR 加一条。

## 三、发布前检查

- `npm pack --dry-run` 看打包内容，应该包含 `index.js`、`client.js`、`lib/`、`vendor/`、`locale/`、`icon.svg`、`cordis.patch.yml`、`README.md`、`安装说明.md`。
- 在一个干净的 DSH profile 里装一次，确认左侧栏出现入口、能连房间、能扫码。
- `package.json` 里的 `name`、`client.js` 的 `id`、`cordis.patch.yml` 的 `name` 必须完全一致，否则面板不会加载。

## 四、注意

- 仓库里**不要**提交 `%DSH_HOME%/bili-live/state.json`（里面有 SESSDATA）。
- 插件是链接安装时，仓库目录移动会导致本地安装失效；npm 安装没有这个问题。
- 自动发弹幕有平台风控风险，README 里已经写明，发布时保留这段说明。
