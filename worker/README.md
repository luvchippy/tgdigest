# Cloudflare Worker 部署（解决 NodeSeek 403）

## 为什么要它

GitHub Actions 的机器在 Azure 机房，访问 nodeseek.com 会被 Cloudflare 判定成机器人，返回 `403 Just a moment...`。
只有 `/rss.xml` 被放行，所以翻页列表和帖子正文都拿不到，一小时只能看到最新 20 条标题。

Worker 跑在 Cloudflare 自己的网络上，访问同样托管在 Cloudflare 的 nodeseek 一般不触发挑战，等于给你一条干净通道。

## 部署步骤

1. 打开 https://dash.cloudflare.com ，注册或登录（免费版足够，不需要绑卡）。
2. 左侧菜单 **Compute (Workers)** → **Workers & Pages** → 右边 **Create** → 选 **Start with Hello World!** → **Deploy**。
3. 起个名字，比如 `nodeseek-proxy`，部署后会得到一个域名：`https://nodeseek-proxy.你的子域.workers.dev`。
4. 点 **Edit code**，把仓库里 `worker/nodeseek-proxy.js` 的内容**整段替换**进去，右上角 **Deploy**。
5. 回到 Worker 的 **Settings** → **Variables and Secrets** → **Add**：
   - Type 选 **Secret**，Name 填 `TOKEN`，Value 随便设一串别人猜不到的字符（例如 `ns_7f3a91c2`）。
   - 保存。这一步是防止别人拿你的 Worker 当免费代理刷。
6. 自测（把两个占位换成你自己的）：
   ```
   https://nodeseek-proxy.你的子域.workers.dev/?url=https%3A%2F%2Fwww.nodeseek.com%2Fpage-2&token=你的TOKEN
   ```
   能返回一堆 HTML 就成功了；返回 `bad token` 说明 token 不对，返回 `host not allowed` 说明 url 参数没编码对。
7. 回到 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **Variables** 标签 → **New repository variable**：
   - Name: `PROXY_PREFIX`
   - Value: `https://nodeseek-proxy.你的子域.workers.dev/?url=`
8. 再建一个 Secret：Name `PROXY_TOKEN`，Value 填第 5 步的 TOKEN。

## 代码怎么用它

抓取脚本遇到 NodeSeek 的地址时，会先走 Worker：

```
GET https://<worker>/?url=<URL编码后的nodeseek地址>
```

Worker 校验域名白名单和 token 后转发，把原始 HTML 原样吐回来。列表翻页、帖子正文都走这条路。
Worker 只放行 `nodeseek.com` / `www.nodeseek.com` 两个域名，不会变成通用代理。

---

## 另一个 Worker：外部调度器（`worker/github-cron.js`）

这个和上面的反代 Worker 是**两个独立的东西**，别混。

反代 Worker（`nodeseek-proxy.js`）解决的是「抓不到 NodeSeek」，
调度 Worker（`github-cron.js`）解决的是「GitHub Actions 定时器不跑」。

### 为什么要它

实测本仓库的原生 `schedule` 投递率只有 **3.5%**：24 小时里 40 多个 cron 槽位，
真正触发 5 次；连只跑 `echo` 的 `heartbeat`（`*/5 * * * *`，理论 288 次/天）一天也只跑了 2 次。
靠它根本撑不起「连续采集」，所以改由 Cloudflare 主动调 GitHub API。

### 部署步骤

1. 复用你已经有的 Cloudflare 账号，**新建一个** Worker（不要覆盖反代那个），名字例如 `forum-digest-cron`。
2. 把 `worker/github-cron.js` 整段贴进去，Deploy。
3. Settings → Variables and Secrets 添加三个变量：
   - `GH_TOKEN`（Secret）：Fine-grained PAT，仓库选 `luvchippy/tgdigest`，权限只勾 **Actions: Read and write**（不要给 Contents，用不上）。
   - `GH_REPO`（Text）：`luvchippy/tgdigest`
   - `GH_WORKFLOW`（Text）：`digest.yml`
4. Settings → **Triggers** → Cron Triggers → Add：填 `7 */6 * * *`（每 6 小时第 7 分钟）。
5. 自测：浏览器打开 `https://forum-digest-cron.你的子域.workers.dev/?run=1`，
   返回 `dispatch -> HTTP 204` 就成功了（204 是 GitHub dispatch 接口的正常返回）。
   然后去 Actions 页面应该能看到一次新的 `forum-digest` 运行。

### 时序

```
一次 job：24 轮 × 10 分钟 ≈ 4.75 小时
Worker  ：每 6 小时拉起一次
→ 前后两段重叠约 45 分钟，由 concurrency 保证不叠跑，形成 24/7 连续覆盖
```

靠 Actions 自己的 `cron: '7 */6 * * *'` 也行，但按 3.5% 的投递率，别指望它准点。