# forum-daily-digest

四个论坛（NodeSeek / NodeLoc / LinuxDo / NHT）的公开新帖，每天自动收集一遍，交给 AI 逐条打分，只把值得看的推送到的 Telegram。**全部跑在 GitHub 的服务器上，你的电脑只需要用来上传一次代码，之后可以关掉。**

零依赖：不需要 npm install，只用 Node 自带的网络能力。

## 它是怎么工作的（白话版）

每天有两个角色轮流上班：

1. **收集工**（每小时一次）：去四个论坛的「最新帖子列表」转一圈，把没见过的帖子抄下来，丢进当天的篮子（`data/queue-日期.jsonl`）。
2. **审核员**（每天早上 9:00 一次）：把篮子里的帖子一条条交给 AI 打分，挑出 6 分以上的，通过你的 Telegram Bot 发给你，然后把篮子倒空。

为什么要分两步：NodeSeek 一天的帖子有上千条，而它的官方订阅源（RSS）一次只给最近 20 条——实测只覆盖 10 分钟。只跑一次必然漏掉绝大部分，所以收集工每小时跑一趟，攒够一天的量再统一审。

## 四个论坛各自怎么抓（全部实测过）

| 站点 | 抓取方式 | 说明 |
| --- | --- | --- |
| **NodeSeek** | `GET /rss.xml` + `GET /page-2,3...` + 详情页 | 没有公开 JSON 接口（`/api/posts` 等全部 404）。官方 RSS 给最近 20 条带时间；翻页 HTML 补更早的帖；每条再打开详情页，从 `.post-content` 取正文，失败就退回网页的 meta 描述 |
| **NodeLoc** | `GET /latest.json` | Discourse 论坛自带的机器可读接口，一次 30 条，直接返回标题/摘要/时间/浏览数 |
| **LinuxDo** | `GET /latest.json` | 同上，同一个论坛程序 |
| **NHT (n.ht)** | `GET /api/topics?page=1` | 返回 `{code:200, data:[...]}`，**正文直接含在里面**，不用二次请求 |

## Discourse 是什么

一套开源的「论坛建站程序」，很多技术社区直接拿它搭站（NodeLoc、LinuxDo 都是）。它有个对自动化特别友好的特点：**在任意页面地址后面加 `.json`，就能拿到这个页面的机器可读数据**。比如 `https://linux.do/latest.json` 就是"最新帖子列表"的结构化数据，不需要登录、不需要密钥。所以接这类论坛不用写网页爬虫，直接读 JSON 就行。

## 上线步骤

1. **建一个 GitHub 仓库**，把本目录的内容推上去。
2. **建 Telegram Bot 拿两个值**
   - 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot`，按提示起名字，它会给你一串形如 `123456:ABC-DEF...` 的 token，这是 `TELEGRAM_BOT_TOKEN`。
   - 给刚建好的 bot 发一条随便什么消息，然后浏览器打开 `https://api.telegram.org/bot<你的TOKEN>/getUpdates`，找到 `"chat":{"id":数字}`，这个数字就是 `TELEGRAM_CHAT_ID`。
3. **把两个值存进仓库**：Settings → Secrets and variables → Actions → New repository secret，分别建 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。
4. **手动试跑**：Actions 页面 → 左侧 `forum-daily-digest` → Run workflow → mode 选 `dry-run` → 运行。结束后点开日志，能看到每个站抓了多少条、AI 挑中哪些、最终会发出去的正文（**不会真的发消息**）。
5. **正式跑一次**：mode 选 `digest`，这次会真的发到你的 Telegram。
6. 完事。之后每小时自动收集、每天北京时间 09:00 自动推送。

想改推送时间：编辑 `.github/workflows/digest.yml` 里的 `cron: '0 1 * * *'`（UTC 时间，北京时间 = UTC+8，例如想改成早上 8 点就写 `0 0 * * *`）。

## 不用额外买 AI

默认走 **GitHub Models**：在 Actions 里用仓库自带的 `GITHUB_TOKEN` 调用模型，workflow 里已声明 `permissions: models: read`，不花钱、不用申请。想换别的：加对应的 Secret，然后把仓库 Variables 里的 `REVIEW_PROVIDER` 改成 `gemini` 或 `deepseek`。

## 可调参数（Settings → Variables）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MIN_SCORE` | 6 | 多少分以上才推送。调高更精简，调低更全 |
| `MAX_PER_SOURCE` | 12 | 单个站点每天最多推几条，防刷屏 |
| `MAX_CANDIDATES` | 400 | 单轮最多送审多少条，控制 AI 用量 |
| `COLLECT_WINDOW_HOURS` | 3 | 收集工每次只看最近几小时的帖子 |
| `INTEREST_PROFILE` | 内置 | 用一句话告诉 AI 你想看什么，它按这个打分 |
| `REVIEW_MODEL` | 留空 | 指定模型，例如 `openai/gpt-4.1-mini` |

## 想调整筛选口味

改 `prompts/review.md`。里面用中文写清了什么算高分、什么算水贴，直接用大白话改就行，不用懂代码。

## NodeSeek 怎么抓（踩坑记录，别再重复试）

NodeSeek 只在 **TLS 指纹正确**时才放行。下面每条都是实测结果：

| 方式 | 列表页 | 帖子正文 | 结论 |
| --- | --- | --- | --- |
| Actions 直连（Node fetch） | 403 Just a moment | 403 | TLS 指纹是 undici，被判机器人 |
| 直连 + 全套浏览器请求头 | 403 | 403 | 判的是 TLS 不是头 |
| Cloudflare Worker 转发 | 「ipv6已关闭」提示页 | 同 | Worker 出口是 IPv6，被源站按协议版本拒 |
| Playwright 真浏览器 | ✅ 6.8 秒过挑战 | ❌ 等 45 秒仍「请稍候…」 | 详情页有独立更强的防护 |
| RSS | ✅ 20 条标题 | 无正文 | 能用但覆盖窄 |
| **curl_cffi（impersonate=chrome）** | ✅ 3 页 90 条 | ✅ **拿得到 .post-content** | 当前生产方案 |

关键点：**必须用 `impersonate="chrome"`**，`chrome131` 反而 403（指纹太新不在白名单），`safari` 也可以。

所以 NodeSeek 走 Python 抓取器 `scripts/fetch-nodeseek.py`（curl_cffi），产出 `/tmp/nodeseek-raw.json`，Node 侧 `src/sources/nodeseek.mjs` 优先读它；文件缺失或超过 20 分钟就自动回落到 RSS（只有标题），保证永远不会因为 Python 挂掉而断更。

抓取量：默认翻 3 页（约 90 条），前 45 条抓正文。想调就改仓库变量 `NODESEEK_PAGES` / `NODESEEK_DETAIL`。

## 已知风险与对策

**GitHub 机房 IP 被 Cloudflare 拦**。日志里出现 `WAF challenge` 或 `HTTP 403` 就是它。三级对策：

1. 打开仓库变量 `ENABLE_JINA_FALLBACK=1`，失败时自动改走 `r.jina.ai` 渲染代理。
2. 自建一个 Cloudflare Worker 做转发，地址填进 `PROXY_PREFIX`。
3. 整体搬到 Cloudflare Workers 定时任务，请求不经过 GitHub 机房。

**论坛改版**。`npm run probe`（或 Actions 里 mode 选 collect 看日志）会打印每个站真实拿到的第一条帖，接口变了最快能看出来，改 `config/sources.json` 里对应的地址即可。

**私有仓库的分钟数**。公共仓库 Actions 不计费；私有仓库每小时一次收集约 1 分钟，一天 24 分钟，加上推送一个月约 800 分钟，免费额度 2000 分钟够用。

## 目录

```
src/collect.mjs        收集工：抓取 -> 去重 -> 追加进当天队列
src/digest.mjs         审核员：读队列 -> AI 打分 -> 推 Telegram -> 清空队列
src/review.mjs         AI 审核，多供应商、批处理、三次重试、脏 JSON 容错
src/notify.mjs         Telegram 分片发送与 429 退避
src/state.mjs          已抓过帖子的指纹，防止重复
src/probe.mjs          接口体检
src/lib/http.mjs       超时/重试/代理/反爬挑战页识别
src/lib/parse.mjs      字段归一化、HTML 清洗
src/sources/nodeseek.mjs   RSS + 翻页 + 详情正文
src/sources/discourse.mjs  Discourse 系论坛
src/sources/nht.mjs        NHT
src/sources/generic.mjs    未知结构站点的通用兜底
config/sources.json    站点开关、抓取页数、接口地址
prompts/review.md      审核提示词
data/                  当天队列（自动生成，推送后清空）
state/seen.json        去重指纹
```
