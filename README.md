# forum-daily-digest

四个论坛（NodeSeek / NodeLoc / LinuxDo / NHT）的公开新帖，自动抓取 → AI 筛选 → 只把高质量的推送到的 Telegram。

**全部跑在 GitHub 的服务器上**，你的电脑只需要用来上传一次代码，之后可以关掉。

---

## 架构：两个 workflow，各干一件事

```
forum-collect（长驻抓取）          forum-review（增量审核）
  每 30 分钟被 Worker 拉起             每 15 分钟 + 抓取结束触发
  24 轮 × 10 分钟，403 就早退          读队列，只审"还没结论"的帖
         ↓                                    ↓
  写 queue-{date}.jsonl  ────────→  写 reviewed-{date}.jsonl
                                    达标 ≥ 20 条才推送
                                          ↓
                                    写 sent-{date}.jsonl
```

**为什么拆开**：最早是单个 workflow 里抓完就审。实测 216 条送审要跑 36 分钟，
这段时间整个 job 卡住不抓帖，等于白白丢掉 3 轮采集；而且审核一旦超时，
抓取节奏也跟着乱。拆开之后两边互不阻塞，审核还能独立重试。

---

## 数据文件

四个 jsonl 各自只追加、互不覆盖，配合 `merge=union`，两个 workflow 并行也不会 git 撞车：

| 文件 | 谁写 | 作用 |
| --- | --- | --- |
| `data/queue-{date}.jsonl` | collect | 抓到的帖子，一天一个文件 |
| `data/reviewed-{date}.jsonl` | review | 每条帖子的 AI 结论（keep / score / why） |
| `data/sent-{date}.jsonl` | review | 已经推送过的 key，防止重复发 |
| `data/review-failures-{date}.jsonl` | review | 审核失败的帖子 + 具体原因，供下次重试和排查 |

**一条帖子只要没拿到审核结论，就会在下一次 review 里被重新送审**——
这是"一条不落"的保证。失败最多重试 `MAX_REVIEW_ATTEMPTS` 次，之后标记放弃并留日志。

---

## 抓取端（forum-collect）

- 一次 job 内跑 24 轮，每轮间隔 10 分钟；Worker 每 30 分钟 dispatch 一次，前后自然接续。
- 第 1 轮翻 8 页、详情额度 900：把上一个 run 因限流中断、以及换 IP 空窗期漏掉的帖子补回来。
- 后续轮翻 4 页，只抓这个 job 内还没抓过详情的帖（`/tmp` 记录 id），请求量降到 1/3。
- 连续 2 轮 NodeSeek 全站 403 → 判定 IP 被限流，**立刻收工**，交给下一次换新 IP。
- 被限流的轮次不会把 RSS 裸标题灌进队列，避免污染正文覆盖率。

## 审核端（forum-review）

- 每次运行：读队列 → 跳过已有结论的 → 只把剩下的送 AI → 结论落盘。
- 批次 10 条、**3 路并发**，实测 100 条约 3 分钟审完。
- 达标（`keep=true` 且 `score >= MIN_SCORE`）攒够 `PUSH_THRESHOLD` 条才推送，不足就留着。
- 审核失败的**不写结论**，只写失败日志，下次自动重试。

---

## 四个论坛各自怎么抓（全部实测过）

| 站点 | 抓取方式 | 说明 |
| --- | --- | --- |
| **NodeSeek** | `curl_cffi` 模拟 Chrome 指纹 | 列表翻页 + 详情页取正文。官方 RSS 一次只给最近 20 条（约 10 分钟），只能当兜底 |
| **NodeLoc** | `GET /latest.json` | Discourse 自带的机器可读接口，一次 30 条 |
| **LinuxDo** | `GET /latest.json` | 同上，同一个论坛程序 |
| **NHT (n.ht)** | `GET /api/topics?page=1` | 返回 `{code:200, data:[...]}`，正文直接含在里面 |

---

## 上线步骤

1. **建仓库**，把本目录内容推上去。
2. **建 Telegram Bot**：找 [@BotFather](https://t.me/BotFather) 发 `/newbot` 拿 token，
   给 bot 发条消息后打开 `https://api.telegram.org/bot<TOKEN>/getUpdates` 找 `chat.id`。
3. **存 Secret**：Settings → Secrets and variables → Actions → New repository secret
   - `TG_BOT_TOKEN`：Bot token
   - `LLM_API_KEY`：AI 审核的 API key
   - `PROXY_TOKEN`：Cloudflare 反代 Worker 的 token（可选）
4. **配 Variables**：同页面的 Variables 标签
   - `TG_CHAT_ID`：你的 chat id
   - `REVIEW_BASE_URL`：审核服务地址，例如 `https://note3-prev-api.askdiandian.com/v1`
   - `REVIEW_MODEL`：模型名，例如 `dots3-note-prev`
5. **手动试跑**：Actions → `forum-review` → Run workflow → mode 选 `dry-run`，只打印不发送。
6. **部署调度 Worker**（见 `worker/README.md`），否则只能靠 GitHub 那个 3.5% 投递率的原生 cron。

---

## 参数（Settings → Variables）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MIN_SCORE` | 6 | 多少分才算出达标，低于这个数不推 |
| `PUSH_THRESHOLD` | 20 | 攒够多少条达标帖才发一次 |
| `MAX_PER_SOURCE` | 0（不限） | 单次推送里单个站点最多几条 |
| `MAX_REVIEW_ATTEMPTS` | 3 | 同一条最多重试几次，超了就放弃 |
| `REVIEW_BATCH_SIZE` | 10 | 每次送 AI 几条 |
| `REVIEW_CONCURRENCY` | 3 | 并发几个批次 |
| `REVIEW_MAX_TOKENS` | 8000 | 单次回复 token 上限（带思维链的模型必须给足） |
| `NODESEEK_PAGES` | 4 | NodeSeek 列表翻页数，约 30 条/页 |
| `NODESEEK_DETAIL` | 200 | 每轮抓多少条详情正文 |
| `MAX_CANDIDATES` | 20000 | 单次运行最多送审多少条 |
| `INTEREST_PROFILE` | 内置 | 一句话告诉 AI 你想看什么 |
| `PROXY_PREFIX` | 空 | Cloudflare 反代地址，抓 NodeSeek 用 |

---

## NodeSeek 怎么抓（踩坑记录，别再重复试）

NodeSeek 只在 **TLS 指纹正确**时才放行。下面每条都是实测结果：

| 方式 | 列表页 | 帖子正文 | 结论 |
| --- | --- | --- | --- |
| Actions 直连（Node fetch） | 403 Just a moment | 403 | TLS 指纹是 undici，被判机器人 |
| 直连 + 全套浏览器请求头 | 403 | 403 | 判的是 TLS 不是头 |
| Cloudflare Worker 转发 | 「ipv6已关闭」提示页 | 同 | Worker 出口是 IPv6，被源站按协议版本拒 |
| Playwright 真浏览器 | ✅ 6.8 秒过挑战 | ❌ 等 45 秒仍「请稍候…」 | 详情页有独立更强的防护 |
| RSS | ✅ 20 条标题 | 无正文 | 能用但覆盖窄 |
| **curl_cffi（impersonate=chrome）** | ✅ 翻页正常 | ✅ **拿得到 .post-content** | 当前生产方案 |

关键点：
- 必须 `impersonate="chrome"`，`chrome131` 反而 403（指纹太新不在白名单），`safari` 也能用。
- **单 IP 连续跑约 8 轮、2 小时后会整站 403**，换 run = 换 IP 就恢复。这是当前架构每 2 小时换一次的原因。
- 详情页 404 是帖子已被删，不是抓取失败，直接剔除不计入覆盖率。

---

## 目录

```
.github/workflows/digest.yml  forum-collect：长驻抓取入队（文件名历史遗留，内容是抓取）
.github/workflows/review.yml  forum-review：增量审核 + 达标推送
scripts/loop.mjs             抓取循环：24 轮、403 早退、按轮调整翻页深度
scripts/fetch-nodeseek.py    NodeSeek 抓取器（curl_cffi）
src/collect.mjs              抓取 -> 去重 -> 追加进当天队列
src/reviewer.mjs             增量审核 + 攒够阈值推送
src/review.mjs               AI 调用：多供应商、批处理、并发、三次重试、脏 JSON 容错
src/notify.mjs               Telegram 分片发送与 429 退避
src/state.mjs                已抓帖子的指纹（jsonl，防重复入队）
src/sources/                 各站点抓取实现
config/sources.json          站点开关、页数、接口地址
prompts/review.md            审核提示词（广告/抽奖/水贴过滤规则都在这）
worker/nodeseek-proxy.js     Cloudflare 反代
worker/github-cron.js        外部调度器：每 30 分钟拉一次抓取
```

---

## 常见问题

**推送太频繁 / 太少**：调 `PUSH_THRESHOLD`（默认 20）。调大 → 更少更精，调小 → 更快更碎。

**想看审核为什么失败**：翻 `data/review-failures-{date}.jsonl`，每条都带 `reason` 和尝试次数。

**NodeSeek 整站 403**：这是 IP 被限流，等下一个 run 换 IP 就好。持续不恢复就检查 `PROXY_PREFIX` 那个 Worker 还在不在。

**论坛改版**：`npm run probe` 会打印每个站真实拿到的第一条帖，接口变了最快能看出来，改 `config/sources.json` 里对应地址即可。
