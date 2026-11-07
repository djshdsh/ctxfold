/**
 * Pi 上游 dist 补丁清单。
 *
 * 这 3 条（对应 ctxfold 的 5 条上游补丁）改的是模型适配器源码，
 * 扩展 API 碰不到；但 Pi 的适配器是磁盘上的 JS bundle，
 * 所以换一种手法照样能补 —— 直接改文件，跟 ctxfold 对 上游 做的一样。
 *
 * 代价必须记牢：
 *   - 锁版本。Pi 升级会覆盖 dist，补丁失效，需要 `patch apply --force` 重打。
 *   - 改的是上游代码，出问题不再是"配置问题"，排查成本更高。
 * 所以默认一条都不打，全部 opt-in。
 *
 * marker 是幂等判定的唯一依据：文件里有 marker 就算打过，
 * 不能拿 replace 前缀去比对（和 find 前缀相同，必然误判）。
 *
 * 字符串一律用单引号：要匹配的代码里有反引号和 ${}。
 */

export const DIST_PATCHES = [
  {
    id: "DEEPSEEK_SYSTEM_ROLE",
    upstreamId: 57,
    name: "developer role 仅限原生 openai / azure",
    marker: "[ctxfold:57]",
    effect:
      "Pi 在 reasoning 模型上会把指令消息发成 developer role。第三方中转（deepseek / glm / 各种代理）不认这个角色，直接 400 或静默丢指令。打上后只有 provider 是 openai / azure 才发 developer，其余回退 system。",
    risk: "原生 OpenAI / Azure 不受影响；如果你的中转其实支持 developer，行为会退化成 system，通常无害。",
    files: [
      "@earendil-works/pi-ai/dist/api/openai-completions.js",
      "@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
    ],
    targets: [
      {
        find: '    const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";',
        replace:
          '    const instructionRole = model.reasoning && compat.supportsDeveloperRole && /^(openai|azure)/.test(String(model.provider)) ? "developer" : "system"; // [ctxfold:57]',
      },
      {
        find: '    const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";',
        replace:
          '    const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false && /^(openai|azure)/.test(String(model.provider)) ? "developer" : "system"; // [ctxfold:57]',
      },
    ],
  },
  {
    id: "ANTHROPIC_OAUTH_CLI_NEUTRAL",
    upstreamId: 49,
    name: "不再伪装 claude-cli User-Agent",
    marker: "[ctxfold:49]",
    effect:
      "Anthropic OAuth 分支把 User-Agent 写成 claude-cli/<ver>。打上后改用 Pi 自己的 UA（该文件本来就 import 了 getPiUserAgent）。需要伪装时设 CTXFOLD_CLAUDE_UA=1 恢复。",
    risk: "真实 Claude Pro/Max OAuth 可能因 UA 变化被限流；用中转或 API Key 时反而是好事。",
    files: ["@earendil-works/pi-ai/dist/api/anthropic-messages.js"],
    targets: [
      {
        find: '                "user-agent": `claude-cli/${claudeCodeVersion}`,',
        replace:
          '                "user-agent": process.env.CTXFOLD_CLAUDE_UA === "1" ? `claude-cli/${claudeCodeVersion}` : getPiUserAgent(), // [ctxfold:49]',
      },
    ],
  },
  {
    id: "ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY",
    upstreamId: 47,
    name: "OAuth 不再强插 Claude Code 首段系统提示",
    marker: "[ctxfold:47]",
    effect:
      '原来 OAuth 分支会往 params.system 首项写死 "You are Claude Code, ..."，排在你自己注入的提示词前面并占掉缓存断点。打上后该分支默认不走，你的系统提示成为唯一的 system 消息。设 CTXFOLD_CLAUDE_IDENTITY=1 恢复。',
    risk: "Anthropic 官方对 OAuth 校验首段身份，去掉后真实 Pro/Max 账号可能被拒；第三方中转不受影响。",
    files: ["@earendil-works/pi-ai/dist/api/anthropic-messages.js"],
    targets: [
      {
        find: "    // For OAuth tokens, we MUST include Claude Code identity\n    if (isOAuthToken) {",
        replace:
          '    // [ctxfold:47] OAuth 不再强插 Claude Code 身份；CTXFOLD_CLAUDE_IDENTITY=1 恢复原行为\n    if (isOAuthToken && process.env.CTXFOLD_CLAUDE_IDENTITY === "1") {',
      },
    ],
  },
];

/** 5 条上游补丁里，这 2 条不做 dist 补丁，理由要能回答"为什么没补"。 */
export const NOT_PATCHED = [
  {
    upstreamId: 69,
    id: "MODEL_STREAM_RELEASE",
    reason:
      "ctxfold 这条是撤掉自己先前给 deepseek 加的独立 socket 补丁、恢复官方 in-history。Pi 的 deepseek 走 openai-completions 的通用流式路径，不存在那个被改坏的分支，没有可撤的东西。",
  },
  {
    upstreamId: 72,
    id: "MESSAGES_SYSTEM_CURRENT",
    reason:
      "意图是 system 字段始终用当前系统提示、不被降级成中途消息。Pi 里同一件事由 supportsDeveloperRole / instructionRole 决定，57 打上就同时覆盖了这条。单独再改会重复。",
  },
];
