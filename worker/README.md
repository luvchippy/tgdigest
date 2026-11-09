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
