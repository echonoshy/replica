import type { Space } from "@replica/shared";
import { spaceKeyOf } from "./api";
import type { DemoPromptPreset, ScenariosResponse } from "./api";

export interface SpaceTestCase extends DemoPromptPreset {
  tone?: "tone-blue" | "tone-violet" | "tone-mint" | "tone-rose";
}

export interface ShowcaseSpaceMeta {
  key: string;
  shortLabel: string;
  badge: string;
  badgeTone: "deep" | "classic" | "blank";
  subtitle: string;
  testCases: SpaceTestCase[];
}

export const SHOWCASE_SPACES: ShowcaseSpaceMeta[] = [
  {
    key: "engineering:atlas_platform",
    shortLabel: "Atlas 研发",
    badge: "深度压测样例",
    badgeTone: "deep",
    subtitle: "研发架构与排障 · 16 场长对话 / 50% 噪声压测",
    testCases: [
      {
        id: "atlas_dual",
        badge: "双轨召回",
        tone: "tone-mint",
        title: "Redis 连接池调优 + 周五 DDL 禁令",
        description: "联查「待入梦」里的 maxIdle/minIdle 参数与 Wiki 生产红线",
        query: "Redis 连接池参数之前怎么调的？周五下午能做表结构变更吗？",
      },
      {
        id: "atlas_vector",
        badge: "架构演进",
        tone: "tone-blue",
        title: "向量库三次选型裁决与灰度方式",
        description: "验证 Qdrant → pgvector → Milvus 2.5 独立集群的最终结论",
        query: "Atlas 目前采用哪套向量库，版本和部署方式是什么？",
      },
      {
        id: "atlas_p99",
        badge: "旧口径清理",
        tone: "tone-rose",
        title: "核心检索接口现行 P99 验收上限",
        description: "确认 350ms 旧口径彻底作废，现行标准为 ≤ 180ms",
        query: "Atlas 核心检索接口现行的 P99 验收上限是多少？",
      },
      {
        id: "atlas_oncall",
        badge: "值班交接",
        tone: "tone-violet",
        title: "核心线上首呼与赵峰新架构分工",
        description: "验证陈思远接任国内首呼，赵峰转负责国际版出海架构",
        query: "核心线上值班现在首呼谁？赵峰现在负责哪方面的架构？",
      },
      {
        id: "atlas_payment",
        badge: "生产规范",
        tone: "tone-blue",
        title: "第三方支付回调幂等键与超时上限",
        description: "核对必带请求头 X-Idempotency-Key 与 8 秒超时限制",
        query: "调用第三方支付回调必须携带什么幂等键？现行超时上限是多少？",
      },
      {
        id: "atlas_ddl",
        badge: "变更红线",
        tone: "tone-rose",
        title: "周五生产 DDL 禁令与大表演练工具",
        description: "核对周五 16:00 禁令与 staging pt-online-schema-change 要求",
        query: "Atlas 周五下午生产环境做 DDL 的具体禁令是什么？大表变更要在哪里用什么工具提前演练？",
      },
    ],
  },
  {
    key: "sales:enterprise_q4",
    shortLabel: "Q4 大客户",
    badge: "深度压测样例",
    badgeTone: "deep",
    subtitle: "大客户商务推进 · 16 场长对话 / 50% 噪声压测",
    testCases: [
      {
        id: "sales_dual",
        badge: "双轨召回",
        tone: "tone-mint",
        title: "星海违约金红线 + 锦程演示注意事项",
        description: "联查 Wiki 终稿与两场「待入梦」里的违约金审批、PPT 全中文、HDMI 接口",
        query: "星海制造最终报价和违约金条款是什么？锦程医药 12 月 3 日演示有什么注意事项？",
      },
      {
        id: "sales_xinghai",
        badge: "多轮改价",
        tone: "tone-rose",
        title: "星海制造最终含税报价与分期条款",
        description: "验证 180万 → 155万含驻场 → 148万含税 + 远程支持 + 4-4-2 分期",
        query: "星海制造最终含税报价、服务方式、驻场安排、分期比例和签约截止日分别是什么？",
      },
      {
        id: "sales_jincheng",
        badge: "合规红线",
        tone: "tone-violet",
        title: "锦程医药采购对接人与合规硬限制",
        description: "核对周慧、等保三级、全本地私有化、严禁数据出境、禁公有云 API",
        query: "锦程医药目前采购对接人是谁？等保、部署地点、数据出境和公有云模型调用分别有什么硬限制？",
      },
      {
        id: "sales_yuanjing",
        badge: "延期与封顶",
        tone: "tone-blue",
        title: "远景能源 POC 验收日期、延期与预算上限",
        description: "核对刘伟确认、11-28 延至 12-09、老 SAP 连接器联调、95 万硬上限",
        query: "远景能源找谁确认，POC 的当前验收日期、延期原因与预算上限是什么？",
      },
    ],
  },
  {
    key: "personal:zhou_ran",
    shortLabel: "周然生活",
    badge: "深度压测样例",
    badgeTone: "deep",
    subtitle: "家庭照护与独立产品 · 16 场长对话 / 50% 噪声压测",
    testCases: [
      {
        id: "zhouran_dual",
        badge: "双轨+红线",
        tone: "tone-mint",
        title: "海鲜花生酱拦阻 + 收费变更 + 莫干山预算",
        description: "验证过敏/痛风双重提醒 + 68 元/年订阅 +「待入梦」每晚 1500 元上限",
        query: "周末带小宇去吃海鲜大餐配花生酱可以吗？拾光记现在怎么收费？莫干山住宿预算多少？",
      },
      {
        id: "zhouran_allergy",
        badge: "安全急诊",
        tone: "tone-rose",
        title: "小宇花生过敏应急医院与点心规则",
        description: "验证误食立刻送儿研所急诊与班级核查配料表共存不被覆盖",
        query: "小宇花生过敏后如果误食应该立刻去哪家医院？班级发点心要注意什么？",
      },
      {
        id: "zhouran_gout",
        badge: "医嘱习惯",
        tone: "tone-violet",
        title: "周五可喝饮品与痛风忌口清单",
        description: "验证戒精酿啤酒与高嘌呤生蚝，改为温白开或柠檬苏打水",
        query: "周然现在周五能喝什么？医生要求戒掉的酒和海鲜具体是什么？",
      },
      {
        id: "zhouran_app",
        badge: "产品路线",
        tone: "tone-blue",
        title: "拾光记现行收费、老用户权益与年底同步",
        description: "核对 18 元买断 → 68 元/年订阅、老用户保留原权益、iCloud 同步",
        query: "拾光记对新用户的现行收费方式是什么？已买断的老用户有什么权益？年底前计划上线什么同步功能？",
      },
    ],
  },
  {
    key: "personal:lin_yuan",
    shortLabel: "林远样例",
    badge: "经典样例",
    badgeTone: "classic",
    subtitle: "产品负责人个人长期记忆 · 预置演示场景",
    testCases: [],
  },
  {
    key: "personal:my_space",
    shortLabel: "我的空间",
    badge: "自己从零聊",
    badgeTone: "blank",
    subtitle: "空白个人空间 · 从零开始聊并做梦整理",
    testCases: [],
  },
];

const SHOWCASE_BY_KEY = new Map(SHOWCASE_SPACES.map((item) => [item.key, item]));

export function getShowcaseMeta(space: Space | null): ShowcaseSpaceMeta | undefined {
  return space ? SHOWCASE_BY_KEY.get(spaceKeyOf(space)) : undefined;
}

export function getSpaceTestCases(space: Space | null, scenarios: ScenariosResponse | null): SpaceTestCase[] {
  if (!space) return [];
  const key = spaceKeyOf(space);
  if (key === "personal:lin_yuan") {
    const toneById: Record<string, SpaceTestCase["tone"]> = {
      comprehensive: "tone-violet",
      travel_multihop: "tone-blue",
      dual_track: "tone-mint",
      conflict_audit: "tone-rose",
    };
    return (scenarios?.prompts ?? []).map((prompt) => ({
      ...prompt,
      tone: toneById[prompt.id] ?? "tone-blue",
    }));
  }
  return SHOWCASE_BY_KEY.get(key)?.testCases ?? [];
}
