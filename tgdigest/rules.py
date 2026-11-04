import re
from dataclasses import dataclass

# --- hard ad signals: promotional intent that no technical value can redeem ---

# Referral / affiliate parameters. A "free" giveaway pushed through these is paid acquisition.
REFERRAL = re.compile(
    r"[?&](?:start|ref|aff|invite|inviter|from|share_code|code|invitation)=[A-Za-z0-9_\-]{4,}",
    re.I,
)
PROMO_PRICE = re.compile(
    r"(?:大促|促销|限时|立减|直降|折扣|优惠码|特价|白菜价|首月|秒杀|下单|包年|续费)"
    r"|(?:[$￥¥]\s?\d+(?:\.\d+)?\s*(?:/\s*月|起|off)?)"
    r"|\b\d+(?:\.\d+)?\s*(?:折|元/月)\b",
    re.I,
)
PROXY_VENDOR = re.compile(
    r"(?:住宅\s*IP|住宅代理|静态\s*IP|原生\s*IP|独享\s*IP|代理\s*IP|机场|高速节点|"
    r"B2Proxy|IPIDEA|巨量IP|芝麻代理|快代理|911s5|oxylabs|bright\s*data)",
    re.I,
)
FUNNEL = re.compile(
    r"(?:加\s*群|进群|扫码|扫一扫|私\s*聊|联系客服|咨询客服|报名参加|点击报名|"
    r"关注公众号|添加微信|vx[:：]|微信[:：]|QQ群|工单咨询)",
    re.I,
)
GIVEAWAY_HOLLOW = re.compile(
    r"(?:抽奖|抽\s*\d+\s*位|评论抽|转发抽|开奖|中奖|红包\s*雨|锦鲤|返现|返利|"
    r"送鸡腿|鸡腿\s*\d+)",
    re.I,
)
# Forum sections whose posts are commercial by definition.
PROMO_PATH = re.compile(r"/(?:c/)?(?:promo|market|trade|ads?)(?:/|$)|/推广|/交易", re.I)

# Announcement/template boilerplate that talks like a project but sells something.
AD_HARD = re.compile(
    r"(?:抽奖模板|开源推广|推广要求|申明并遵循|帖子已打上|推广位|合作请联系|商务合作)",
    re.I,
)
# Freebies and deals: worth surfacing, but not "technology".
FREEBIE = re.compile(
    r"(?:免费|白嫖|薅|领取|白送|赠送|试用|免费机|送账号|低价|折扣|优惠|羊毛|立减|"
    r"返现|福利|名额|抢购|兑换码|优惠券)",
    re.I,
)
# Hard technical substance, enough to outrank a freebie mention.
TECH_CORE = re.compile(
    r"(?:CVE-\d{4}-\d+|漏洞|补丁|内核|提权|RCE|0day|逆向|脱壳|反编译|算法|"
    r"源码|GitHub|性能优化|架构设计|自建|部署|编译|调试|数据库|"
    r"协议|并发|分布式|加密|证书|容器|虚拟化)",
    re.I,
)

# --- technical value signals, to protect against over-filtering ---
TECH = re.compile(
    r"(?:CVE-\d{4}-\d+|漏洞|补丁|内核|提权|RCE|cve|0day|"
    r"API|SDK|CLI|Docker|Kubernetes|k8s|Linux|Ubuntu|Debian|Nginx|"
    r"Python|Rust|Golang|Go\s|Java|TypeScript|Node\.?js|React|Vue|"
    r"LLM|GPT|DeepSeek|Claude|Gemini|Qwen|模型|微调|推理|embedding|RAG|Agent|"
    r"数据库|SQLite|Postgres|MySQL|Redis|缓存|"
    r"开源|GitHub|仓库|源码|自建|部署|编译|调试|性能优化|架构|"
    r"算法|正则|抓包|逆向|脱壳|反编译|爬虫|"
    r"NAS|软路由|群晖|PVE|虚拟化|ESXi|Win(?:dows)?\s*Server)",
    re.I,
)


@dataclass
class RuleVerdict:
    label: str          # ad | freebie | tech | unknown
    category: str
    score: float
    reason: str


def classify_rule(text: str, url: str | None, reply_count: int = 0) -> RuleVerdict:
    body = text or ""
    hits: list[str] = []
    ad_score = 0.0

    if AD_HARD.search(body):
        return RuleVerdict("ad", "promotion", 9.0, "推广公告/模板")

    if REFERRAL.search(url or "") or REFERRAL.search(body):
        ad_score += 4.0
        hits.append("返利/邀请码链接")
    if PROMO_PRICE.search(body):
        ad_score += 2.5
        hits.append("促销定价话术")
    if PROXY_VENDOR.search(body):
        ad_score += 3.0
        hits.append("代理/机场推销")
    if FUNNEL.search(body):
        ad_score += 2.0
        hits.append("引流话术")
    if GIVEAWAY_HOLLOW.search(body):
        ad_score += 2.0
        hits.append("抽奖/返利话术")
    if url and PROMO_PATH.search(url):
        ad_score += 2.0
        hits.append("推广版块")

    tech_hits = len(set(m.group(0).lower() for m in TECH.finditer(body)))
    core_hits = len(set(m.group(0).lower() for m in TECH_CORE.finditer(body)))
    freebie = bool(FREEBIE.search(body))

    if ad_score >= 4.0:
        return RuleVerdict("ad", "promotion", ad_score, "、".join(hits))
    if ad_score >= 2.5 and core_hits == 0:
        return RuleVerdict("ad", "promotion", ad_score, "、".join(hits))
    if freebie and core_hits == 0:
        return RuleVerdict("freebie", "deal", 2.0 + min(tech_hits, 3) * 0.2, "羊毛/优惠")
    if core_hits >= 1:
        return RuleVerdict("tech", "technical", 4.0 + min(core_hits, 4) * 0.5,
                           f"硬核技术词 x{core_hits}")
    if tech_hits >= 2:
        return RuleVerdict("tech", "technical", 1.5 + min(tech_hits, 5) * 0.4,
                           f"技术词 x{tech_hits}")
    if ad_score >= 2.0:
        return RuleVerdict("ad", "promotion", ad_score, "、".join(hits))
    return RuleVerdict("unknown", "misc", 0.5, "no strong signal")
