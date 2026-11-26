const han = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const words = /[\p{L}\p{N}]+/gu;
const stop = new Set([
  "a", "an", "and", "are", "for", "how", "in", "is", "of", "or", "the", "to", "what", "when", "who", "with",
  "什么", "哪些", "如何", "是否", "的是", "需要", "怎么", "一下", "最近", "推荐", "帮我", "可以",
  "这个", "那个", "觉得", "时候", "之前", "现在", "应该", "还有", "如果", "因为", "所以", "但是",
  "然后", "就是", "没有", "不是", "一个", "一些", "或者", "以及", "关于", "请问", "告诉", "给我",
  "有没", "没用", "能不", "不能", "怎么", "么样", "为什", "么会", "以吗", "好不", "不好", "解释",
  "介绍", "情况", "问题", "事情", "东西", "地方", "方面", "记录", "对话", "消息", "资料", "内部",
  "一般", "通常", "比较", "非常", "特别", "其实", "可能", "大概", "好像", "突然", "顺便", "另外",
  "其他", "以后", "以前", "刚才", "刚刚", "我们", "你们", "他们", "自己", "大家", "这里", "那里",
  "这样", "那样", "还是", "虽然", "不过", "而且", "并且", "主要", "具体", "简单", "直接", "知道",
  "看看", "聊聊", "我推", "我想", "我要", "样的", "什么", "么办", "一两", "两句", "随便", "陪我",
]);

export function indexText(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(han, (run) => {
    const characters = [...run];
    const pairs = characters.slice(1).map((character, i) => characters[i] + character);
    return ` ${[...characters, ...pairs].join(" ")} `;
  });
}

export function queryTerms(text: string) {
  const segmented = text.normalize("NFKC").toLowerCase().replace(han, (run) => {
    const characters = [...run];
    if (characters.length < 2) return ` ${run} `;
    return ` ${characters.slice(1).map((character, i) => characters[i] + character).join(" ")} `;
  });
  return [...new Set(segmented.match(words) ?? [])].filter((word) => !stop.has(word)).slice(0, 64);
}
