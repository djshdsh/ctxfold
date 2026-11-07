/**
 * 注入体量分析 —— 移植自 ctxfold/lib/inject-analyzer.js。
 *
 * Pi 没有 上游的 systemPrompt 组装管线，看不到真实 token 计数，
 * 只能按字符构成估。给出的是量级判断（十几 token 的差别没有意义）。
 */

/**
 * 粗略 token 估算。
 * CJK 约 1 字 1 token；ASCII 约 4 字符 1 token；其它（全角标点、符号）折中。
 */
export function estimateTokens(text) {
  const s = String(text || "");
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) ascii += 1;
    else if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.round(cjk * 1 + ascii / 4 + other * 0.7);
}

/** 单段摘要。 */
export function describe(text) {
  const s = String(text || "");
  return { chars: s.length, tokens: estimateTokens(s) };
}

/**
 * 分层报告。
 * @param {Array<{name:string,text:string}>} layers 已选中的层（按注入顺序）
 * @param {object} options { withBars, width }
 */
export function report(layers, options = {}) {
  const rows = [];
  let totalChars = 0;
  let totalTokens = 0;
  for (const l of layers) {
    const d = describe(l.text);
    rows.push({ name: l.name, chars: d.chars, tokens: d.tokens });
    totalChars += d.chars;
    totalTokens += d.tokens;
  }
  const width = options.width || 28;
  for (const r of rows) {
    r.share = totalTokens ? r.tokens / totalTokens : 0;
    if (options.withBars) {
      const n = Math.max(0, Math.round(r.share * width));
      r.bar = "█".repeat(n) + "·".repeat(Math.max(0, width - n));
    }
  }
  return { rows, totalChars, totalTokens };
}

/** 一行搞定，给 status 用。 */
export function summaryLine(text) {
  const t = estimateTokens(text);
  const c = String(text || "").length;
  return `${c} 字符 / ~${t} token`;
}
