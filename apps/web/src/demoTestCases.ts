import type { Space } from "@wiki-memory/shared";
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
    key: "personal:chen_mo",
    shortLabel: "陈默 · 职场与家庭",
    badge: "职场与家庭",
    badgeTone: "deep",
    subtitle: "28 场深度长对话 · 涵盖工作汇报、家庭医疗、财务红线与跨学科日常",
    testCases: [
      {
        id: "chenmo_compound",
        badge: "家庭生活",
        tone: "tone-rose",
        title: "家里的钱怎么留，苏晴的生日怎么过？",
        description: "一起看看应急金该留多少、哪些投资要避开，再挑一家两个人都吃得舒服的餐厅。",
        query: "我想趁着降息把家里应急金全拿出来加 3 倍杠杆买小盘股，顺便 11 月 28 号带苏晴去吃香菜牛杂火锅配全脂鲜奶酪庆祝生日，帮我规划下！",
      },
      {
        id: "chenmo_dual_work",
        badge: "工作安排",
        tone: "tone-mint",
        title: "给新老板汇报前，要准备什么？",
        description: "理清林总的汇报偏好、北极星 3.0 的上线时间，以及明天架构评审要带的材料。",
        query: "给现在老板汇报应该用什么形式？北极星 3.0 现在什么时候上线？明天下午 3 点架构评审要准备什么？",
      },
      {
        id: "chenmo_buried_needle",
        badge: "健康备忘",
        tone: "tone-violet",
        title: "爸爸下个月去哪复查？我有哪些用药禁忌？",
        description: "找回之前聊天时提过的复查安排和药物过敏记录。",
        query: "我爸下个月去哪家医院复查什么？另外我发烧了能自己吃阿莫西林（青霉素类）吗？",
      },
      {
        id: "chenmo_pet_dual",
        badge: "宠物照护",
        tone: "tone-mint",
        title: "给芝麻买什么吃的？下次复查是哪天？",
        description: "翻看芝麻的处方粮、零食禁忌，以及下个月的肌酐复查安排。",
        query: "周末给芝麻买点高磷鸡肝冻干行吗？它平时吃什么粮，下个月什么时候去哪家医院复查？",
      },
      {
        id: "chenmo_astronomy_general",
        badge: "天文科普",
        tone: "tone-blue",
        title: "为什么黑洞会有霍金辐射？",
        description: "从常见的虚粒子对比喻聊起，看看量子场论怎样解释黑洞辐射。",
        query: "为什么黑洞会有霍金辐射？虚粒子对的通俗解释和真实量子场论图像有什么区别？",
      },
      {
        id: "chenmo_inventory",
        badge: "年末盘点",
        tone: "tone-violet",
        title: "年底前，有哪些事一定要记住？",
        description: "把家人的日程、每周羽毛球约定、健康注意事项和财务底线放在一起看。",
        query: "帮我盘点下接下来到年底我有哪些必须记住的重要日程、个人健康红线和财务底线？",
      },
    ],
  },
  {
    key: "personal:lin_xi",
    shortLabel: "林汐 · 独立开发与育儿",
    badge: "独立开发与育儿",
    badgeTone: "deep",
    subtitle: "26 场深度长对话 · 涵盖独立产品、过敏急救、旅行改期与日常科普",
    testCases: [
      {
        id: "linxi_compound",
        badge: "家庭出游",
        tone: "tone-rose",
        title: "莫干山周末怎么吃、怎么住？",
        description: "核对一家人的饮食禁忌和住宿预算，再确认年底旅行的目的地。",
        query: "周末带乐乐去莫干山吃顿啤酒海鲜菌汤火锅配花生酱怎么样？顺便帮我核对下莫干山住宿预算，以及年底全家旅行现在到底去北海道还是云南？",
      },
      {
        id: "linxi_app_work",
        badge: "产品与外包",
        tone: "tone-mint",
        title: "拾光记何时发新版？明天的会怎么准备？",
        description: "梳理订阅价格、老用户权益和内测日期，再列出晴空咖啡碰面要带的材料。",
        query: "拾光记现在怎么收费、老用户权益怎么算、v2.0 什么时候发？另外明天上午 10:30 晴空咖啡的会我必须带什么材料、不能答应什么？",
      },
      {
        id: "linxi_medical_dual",
        badge: "家人健康",
        tone: "tone-rose",
        title: "乐乐的过敏应急安排和家人的复查是哪天？",
        description: "翻看之前记下的急诊地点、肾上腺素笔复查时间和妈妈的心内科预约。",
        query: "乐乐如果误食花生应该立刻怎么处理、去哪家医院？他下个月什么时候去复查肾上腺素笔？另外我妈下个月什么时候去哪家医院复查？",
      },
      {
        id: "linxi_schedule",
        badge: "家庭排班",
        tone: "tone-violet",
        title: "明远出差那几天，谁来接乐乐？",
        description: "对照深圳出差日期安排接娃和晚间会议，也看看家里和工作室各要留多少备用金。",
        query: "下个月初周明远出差哪几天、接乐乐和晚上排会要注意什么？家里备用金和工作室周转金各自留多少红线？",
      },
      {
        id: "linxi_general",
        badge: "生活科普",
        tone: "tone-blue",
        title: "为什么有些加湿器会留下白粉？",
        description: "聊聊冷蒸发式和超声波式加湿器的区别，以及自来水里的矿物质去了哪里。",
        query: "冷蒸发式和超声波式加湿器本质区别是什么？为什么超声波加湿器加自来水容易产生白粉？",
      },
      {
        id: "linxi_inventory",
        badge: "日程总览",
        tone: "tone-violet",
        title: "从现在到明年一月，家里和工作怎么排？",
        description: "按最新安排梳理医疗复查、产品发布和家庭旅行的日期。",
        query: "帮我完整盘点下从现在到明年 1 月初，家里和工作上所有还有效的日程节点与硬红线。",
      },
    ],
  },
  {
    key: "personal:my_space",
    shortLabel: "我的空间",
    badge: "空白空间",
    badgeTone: "blank",
    subtitle: "从零开始对话，体验记忆沉淀与知识库整理",
    testCases: [],
  },
];

const SHOWCASE_BY_KEY = new Map(SHOWCASE_SPACES.map((item) => [item.key, item]));

export function getShowcaseMeta(space: Space | null): ShowcaseSpaceMeta | undefined {
  return space ? SHOWCASE_BY_KEY.get(spaceKeyOf(space)) : undefined;
}

export function getSpaceTestCases(space: Space | null, _scenarios: ScenariosResponse | null): SpaceTestCase[] {
  if (!space) return [];
  const key = spaceKeyOf(space);
  return SHOWCASE_BY_KEY.get(key)?.testCases ?? [];
}
