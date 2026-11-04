# tgdigest

Telegram 技术频道的定时聚合简报：抓 `t.me/s/` 网页预览 → 跟进论坛原帖 → 规则过滤 → LLM 聚类与结论 → 私聊推送。

当前覆盖频道：`@baipiaotg`（论坛转帖号，标题+外链）、`@wzxylh`（网络技术文章分享，正文直发）。多频道合并成一份简报推送，跨频道同一事件会被聚成一条并列出各频道来源。

两类频道取正文的方式不同：
- 外链型（baipiaotg）跟进论坛原帖，只有 `linux.do` / `nodeloc` / `nodeseek` / `v2ex` 会抓；厂商落地页、云控制台、短链直接标记跳过，不浪费抓取预算。
- 正文型（wzxylh）消息自带内容，无外链时直接回落到消息正文。

## 运行节奏

GitHub Actions 每天三次（北京时间 09:26 / 13:56 / 18:26），也可在 Actions 页手动触发。

`--channel` 支持逗号分隔多个频道，抓取、正文、聚类、水位全程按频道区分。

三次运行互不重复：`pushed` 表按事件成员记录水位，只有**从未推送过的事件**才会发出。抓取窗口固定回看 36 小时，漏跑的时段会在下一次自动补齐。

## 结构

```
tgdigest/
  models.py     Message 数据类
  store.py      SQLite（messages / articles / verdicts / digests / pushed）
  source_tg.py  频道抓取与解析
  article.py    外链正文（Discourse JSON 优先，HTML 兜底，curl_cffi 过 Cloudflare）
  textutil.py   ANSI / URL / 空白清洗
  rules.py      规则分类（ad / freebie / tech / unknown）
  dedupe.py     字符 bigram + SequenceMatcher 去重
  llm.py        LLM 打分、聚类、一句话结论（OpenAI 兼容端点）
  report.py     简报渲染（Markdown / Telegram HTML）
  notifier.py   Telegram 推送与 4096 字符分片
  cli.py        命令行入口
```

## 命令

```bash
python -m tgdigest fetch   --channel baipiaotg,wzxylh --pages 5
python -m tgdigest enrich  --channel baipiaotg --limit 120
python -m tgdigest analyze --channel baipiaotg --hours 36
python -m tgdigest report  --channel baipiaotg --hours 36
python -m tgdigest push    --channel baipiaotg --dry-run
python -m tgdigest run     --channel baipiaotg --hours 36
python -m tgdigest chatid                # 从 getUpdates 取私聊 chat_id
```

`run` 的 `--reset` 忽略水位全量重推，`--refresh` 强制重新问模型，`--no-push` 只跑不推。

## 配置

需要的五个变量：

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | OpenAI 兼容端点 |
| `LLM_MODEL` | 模型名 |
| `LLM_API_KEY` | 端点密钥 |
| `TG_BOT_TOKEN` | BotFather 的 bot token |
| `TG_CHAT_ID` | 目标私聊 id |

工作流先读仓库根目录的 `config.env`，再用 Actions secrets 覆盖同名项。想收紧安全边界：把五个值搬到 Settings → Secrets and variables → Actions，然后删掉 `config.env`。

## 注意

- 只支持公开频道的 `t.me/s/` 预览，不碰 MTProto、不需要账号登录。
- 论坛抓取按域名串行 + 2s 间隔。GitHub Actions 的共享出口 IP 会被 Cloudflare 论坛（尤其 linux.do）判成 429，所以：同一域名连续两次 429 即熔断，剩余 URL 留给下一次运行；熔断后改走 `r.jina.ai` 服务端渲染兜底，每次运行最多 8 次。
- 单次运行超时 25 分钟，抓取预算优先给论坛，非论坛链接一次性标记 `non-forum` 后不再重试。
- 判为广告的内容不静默丢弃，折叠成一行保留来源。
- GitHub 的计划任务在仓库 60 天无提交时会自动停用，定期手动触发一次即可保活。
- Actions 的 cron 不保证准点，通常延迟几分钟到十几分钟。
