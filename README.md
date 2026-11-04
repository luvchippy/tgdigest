# tgdigest

Telegram 技术频道的每日精简简报：抓 `t.me/s/` 网页预览 → 跟进论坛原帖 → 规则过滤 → LLM 聚类与结论 → 私聊推送。

## 结构

```
tgdigest/
  models.py     Message 数据类
  store.py      SQLite（messages / articles / verdicts / digests）
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
python -m tgdigest fetch   --channel baipiaotg --pages 5
python -m tgdigest enrich  --channel baipiaotg --limit 100
python -m tgdigest analyze --channel baipiaotg --hours 24
python -m tgdigest report  --channel baipiaotg --hours 24
python -m tgdigest push    --channel baipiaotg --dry-run
python -m tgdigest run     --channel baipiaotg --hours 24
python -m tgdigest chatid              # 读 getUpdates 拿私聊 chat_id
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | OpenAI 兼容端点，如 `https://your-endpoint/v1` |
| `LLM_API_KEY` | 该端点密钥 |
| `LLM_MODEL` | 模型名，默认 `deepseek-v4.1-flash` |
| `TG_BOT_TOKEN` | BotFather 给的 bot token |
| `TG_CHAT_ID` | 目标私聊 id；不填则从 getUpdates 自动发现 |

## GitHub Actions

`.github/workflows/daily.yml` 每天 08:30 (UTC+8) 跑一次，也可手动触发。

在仓库 Settings → Secrets and variables → Actions 里配置 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`TG_BOT_TOKEN`、`TG_CHAT_ID`。

数据库通过 actions/cache 在运行之间保留，避免重复抓取同一链接。

## 注意

- 只支持公开频道的 `t.me/s/` 预览；不碰 MTProto、不需要账号登录。
- 论坛抓取按域名串行 + 1s 间隔，这是过 Cloudflare 与避开 429 的唯一稳定姿势。
- 判为广告的内容不静默丢弃，折叠成一行保留来源。
