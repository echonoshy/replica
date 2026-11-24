const han = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const words = /[\p{L}\p{N}]+/gu;
const stop = new Set(["a", "an", "and", "are", "for", "how", "in", "is", "of", "or", "the", "to", "what", "when", "who", "with", "什么", "哪些", "如何", "是否", "的是", "需要"]);

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
