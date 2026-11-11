# 内网离线部署（dsh-market）

面向**没有公网出口**的 DeepSeek Harness 部署：插件市场只从内网 npm 源安装，**插件列表直接读这个源**，所有公网请求一律快速失败并给出原因，而不是超时。

最小配置就一行：

```yaml
- id: dsh-market
  name: dshmarket
  config:
    offline: true                            # 内网模式；源默认 http://127.0.0.1:4873
```

指向别的内网源：

```yaml
  config:
    offline: true
    npmRegistry: http://npm.intra.corp/      # 内网 npm 源（也可用 DSHM_NPM_MIRROR）
```

就这样——**不用再写 `catalog`**。市场会把源里的包读成目录：发布进去的插件立刻出现，版本、描述、作者从包自己的 `package.json` 来，不需要第二份文件跟着维护。

如果目录来源不是源本身（比如要按固定顺序、或只放行指定几个），两种写法仍然保留：

```yaml
    catalog: /opt/dsh/market/plugins.json    # 本地文件或内网 http 地址
    # 或
    plugins: [dsh-context, "@liustack/modlens"]   # 显式名单，只列这些
```

写进宿主 profile 的 `cordis.yml`（与市场其它配置同级，注意必须在 `config:` 下面）。宿主如果走补丁层——dsh 桌面端的 profile 就是这样，它的 `cordis.yml` 只有空列表——这段要写进 `cordis.patch.yml`，条目的 `id` 与包自带 patch 一致（`dsh-market`）。改完重启 dsh。

---

## 目录从哪来（默认：就是源）

| 你配了什么 | 市场列什么 |
|---|---|
| 只配 `offline: true` | 源里带 `dsh` 字段的包 —— 也就是插件；依赖包（pnpm、@babel/* 等）不会出现 |
| `npmRegistry: <内网源>` | 同上，读你配的那个源 |
| `plugins: [...]` | 只列这些包，且**不再过滤**：名单是你说的，市场照办 |
| `catalog: <文件或 URL>` | 你给的目录文档，不再读源 |

判定"是不是插件"用的是 `package.json` 里的 `dsh` 字段——每个 DSH 插件都有，普通库都没有（内网包里 13 个插件全有，它们的依赖全没有）。`keywords` 不作判据：有几个插件 `keywords` 是空的，按关键字过滤会把它们藏起来。

读源需要"这个源有哪些包"。市场按顺序试三个标准端点：`/-/v1/search`、`/-/all`、`/-/ping`（最后这个是我们离线包里快照服务器的约定，返回 `selection.plugins`）。**你的源至少要答一个**：Verdaccio、Nexus、cnpm 都答前两个；随离线包附带的 `serve.mjs` 已补齐前两个。

---

## 为什么需要这个开关

市场是照着公网设计的，每一个有用的动作都是一次对外请求。把它们原样搬到内网，结果是**卡**而不是**错**：

| 请求 | 目标 | 内网表现 |
|---|---|---|
| 目录 `plugins.json` | `awesome-dsh-plugin.com` | 15 秒超时 × 2 次 × 每个源 |
| 插件包 | `registry.npmjs.org`（默认） | pnpm 拉不到，安装失败 |
| README 截图 / 图标 / 头像 | `raw.githubusercontent.com`、`avatars.githubusercontent.com` | 每张图一个破图 + 每次 6 秒 |
| 发行说明 / 兼容性清单 | `api.github.com`、`codeload.github.com` | 逐个插件超时 |
| 评论 | `giscus.app` + GitHub Discussions | 空白框 |
| Gist 备份 | `api.github.com` | 超时 |

`offline: true` 做两件事：

1. **在出口处拦截**（`src/offline.ts` + `src/net.ts`）：已知公网主机（GitHub 全家、两个公共 npm 源、目录站、jsDelivr、giscus、公共加速站）发请求时**立刻抛错**，不进 socket，错误信息里写明主机名。运维指定的 `npmRegistry` / `catalog` 主机永远放行——所以内网 registry、内网目录服务器照常工作。
2. **在界面上收口**：评论入口、截图/头像加载、GitHub 链接、"GitHub 加速"和"下载区域"设置项都不再出现；标题栏显示「内网离线」徽标。

它**不会**禁用安装——内网部署每天都在装插件，装的是自己源上的包。它只拒绝**只能从 GitHub 装**的插件（`github:` 源码、GitHub Release tarball），因为那在这个网络里没有任何配置能成功，与其让 pnpm 卡 15 分钟，不如 1 秒内说清楚该怎么改。

---

## 一次性准备：在能上网的机器上打包

```sh
# 先构建本仓库自己的市场包（不是 npm 上那个）
npm pack                      # → dshmarket-<版本>.tgz

# 只带指定的插件（推荐：可控、体积小），并用本地构建替换上游 dshmarket
node scripts/offline-bundle.mjs \
  --out ./offline-bundle \
  --plugins dshmarket,@your-scope/plugin-a,@your-scope/plugin-b \
  --replace dshmarket=./dshmarket-<版本>.tgz \
  --target http://npm.intra.corp/

# 或者：把目录里所有能走 npm 的插件全部带上
node scripts/offline-bundle.mjs --out ./offline-bundle --target http://npm.intra.corp/
```

产物：

```
offline-bundle/
  plugins.json               # 只含真正打包成功的条目（GitHub-only 条目被剔除）
  tarballs/*.tgz             # 每个包一个，版本锁定
  tarballs/publish.sh|.cmd   # 在内网执行：npm publish <tgz> --registry <target>
  README.txt                 # 内网侧步骤 + 可直接抄的 config 片段
```

脚本固定会带上两个**基础设施包**：

- `dshmarket`——市场自己，这样内网里连市场自身的更新也能走同一个源（本仓库是分叉版本，用 `--replace` 换成自己 `npm pack` 出来的包，别用 npm 上那个）；
- `dsh-plugin-updates`——发行说明数据包，`/changelog` 读它。缺了它，内网里"更新内容"永远是空的。

`--registry` 是**下载**源（默认 npm 官源，可换 `https://registry.npmmirror.com`），`--target` 是**发布**目标（内网源）。两者是两台机器，别混。

---

## 内网侧步骤

```sh
# 1. 把 tarball 推进内网源
cd offline-bundle/tarballs && sh publish.sh        # Windows: publish.cmd

# 2. （只有手工目录才需要）放目录文件
install -D -m 0644 ../plugins.json /opt/dsh/market/plugins.json

# 3. 配置（见文首），然后重启 dsh
```

如果源是随离线包附带的那个只读快照服务器（`serve.mjs`），它没有 `npm publish` 接口——往里面加插件的办法是把 `.tgz` 或 `.zip` 拖到同目录的 `Add-plugin.cmd` 上（zip 会被重新打包成 tarball）。它会写 `registry.json` 和 `tarballs/`，并重算 `SHA256SUMS.txt`；`serve.mjs` 每次请求发现 `registry.json` 变了就重新读，所以**不用重启源窗口**，刷新市场页面即可。

验证：

```sh
curl -s localhost:<dsh端口>/dsh-market/status | jq '{offline,catalog,region,pnpm}'
# offline: true, catalog: ["http://127.0.0.1:4873 (as a plugin listing)"], region: "global", pnpm: true
```

`region` 停在 `global` 是正常的：内网模式下不再做区域探测（两个区域指向同一个内网源，探测没有意义），而且 `global` 是不套公共 GitHub 加速的那张路由表。

---

## 手工维护目录（可选）

默认的"源即目录"不需要任何维护：`npm publish` 进源就是上架。以下只在你要**控制顺序、屏蔽某些包、或完全脱离源**时才用。

`catalog` 接受三种写法：

| 写法 | 用途 |
|---|---|
| `/opt/dsh/market/plugins.json` | 本地文件；每次打开市场都重新读，运维替换文件即生效，不用重启 |
| `http://dsh.intra.corp/market/plugins.json` | 内网静态服务器；运维更新一处，所有机器生效 |
| `file:///opt/dsh/market/plugins.json` | 同上第一条，只是写成 URL 样式 |

手工目录的条目要能被内网安装，必须满足其一：

- 有条目 `npm` 字段（包名）→ 从 `npmRegistry` 装，这是正规做法；
- `install`/`tarball` 指向内网可达的地址 → 也能装。

只写 `github:owner/repo` 的条目会被**拒绝安装**并提示去内网源发布。这是设计，不是缺陷。

从源读出来的条目天然满足第一条（`npm` 就是包名），所以内网里不会遇到这个问题。

---

## 功能对照

| 功能 | 内网模式 |
|---|---|
| 浏览 / 搜索 / 分类 / 排序 | 正常（数据来自你的目录） |
| 安装 / 卸载 / 热禁用 / 分组 / 备注 / 收藏 | 正常 |
| 主题 | 正常（主题包从内网源装） |
| 更新检测 | 正常（只查内网源的版本） |
| 备份 / 恢复（本地 JSON 文件） | 正常 |
| 发行说明（更新内容） | 有 `dsh-plugin-updates` 包就正常，否则显示"无说明" |
| 评论 | 关闭（依赖 giscus / GitHub Discussions） |
| 截图、作者头像、README 图 | 关闭，头像退化为字母色块 |
| Gist 备份 | 不可用（`api.github.com`） |
| WebDAV 备份 | 仍受限于"仅 https + 拒绝内网地址"，内网部署请用本地文件备份 |
| GitHub 加速 / 下载区域设置 | 隐藏（选了也不会改变任何路由） |
| 区域自动探测 | 不做 |

---

## 常见问题

**装插件时 pnpm 报找不到包**——先确认 `npmRegistry` 写法：必须是 `http://host[:port]/path` 形式的基础地址，不能带账号密码、query 或 hash，否则该值会被忽略并在日志里写 `ignored npmRegistry ...`。

**日志里出现 `offline mode: xxx is not reachable`**——这是拦截器在工作，说明有代码路径还想去公网。多数情况是目录里某个条目缺 `npm` 字段；把该插件发布到内网源并在目录里补上 `npm` 即可。

**pnpm 本身没装**——内网装不了 pnpm。请预先在镜像里装好（`npm i -g pnpm` 或离线安装包），市场检测到 pnpm 缺失时的"一键安装"在内网走不通。

**市场自身如何升级**——把新版 `dshmarket` tarball 推进内网源，市场会在"插件 → 已安装"里看到自己的更新；或者重启后由宿主按依赖重新安装。频道（stable/beta/dev）仍可用，但只有你推上去的版本存在。

**目录更新后页面没变化**——刷新页面即可（文件源每次请求都重读，没有缓存兜底，这是刻意的：过期目录会让今早刚发布的插件显示成"不存在"）。

**我把插件发布到源里了，市场里看不到**——按顺序查三件事：① 源的 `/-/v1/search`、`/-/all`、`/-/ping` 是否至少答了一个（`curl http://127.0.0.1:4873/-/v1/search?text=`）；② 该包 `package.json` 里有没有 `dsh` 字段（`npm view <包名> dsh`）；③ 状态里的源地址是不是你以为的那个（`curl -s localhost:<dsh端口>/dsh-market/status | jq .catalog`）。三条都正常还是看不到，就在配置里加 `plugins: [<包名>]` —— 显式名单会跳过过滤，直接按名字读。若源是那个只读快照服务器，先 `node add-plugin.mjs --list` 确认包真的写进了 `registry.json`（写入和当前市场读的是同一个目录）。

**内网源就在本机，但安装/目录请求报连不上**——如果这台机器设了 `HTTP_PROXY`，检查代理是否会拦截 `127.0.0.1`。市场对 loopback 地址直接连（不走代理），pnpm 子进程也会把该地址写进 `npm_config_noproxy`；代理若是透明拦截型（返回 502 之类），需要把它对本机的转发关掉。

---

## 相关代码

| 位置 | 职责 |
|---|---|
| `src/offline.ts` | 模式开关、公网主机名单、拦截规则 |
| `src/net.ts` | 所有出站请求的唯一出口，拦截点在这里；loopback 直连 |
| `src/regions.ts` | `npmRegistry` / `catalog` / `plugins` 解析，内网默认源，路由表收缩 |
| `src/catalog-registry.ts` | 把源读成目录：枚举、`dsh` 过滤、条目合成 |
| `src/registry.ts` | 目录读取（`url` / `npm` / `file` / `registry` 四种来源） |
| `src/routes.ts` | 配置装载、状态上报（`offline` / `catalog`）、安装来源拒绝 |
| `src/dsh-cli.ts` | pnpm 子进程的 registry 与 noproxy 注入 |
| `scripts/offline-bundle.mjs` | 联网侧打包 |
| `tests/offline.spec.ts`、`tests/catalog-registry.spec.ts` | 上述行为的回归测试 |
