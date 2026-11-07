---
name: ctxfold
description: 操作 ctxfold 本体——分层提示词注入、任务族路由、规则开关、可选补丁。用于查询注入状态、改层、开关规则、排查注入为什么没生效、或决定某条行为该落在层、规则还是补丁里时。
---

# ctxfold 操作手册

ctxfold 是给 Pi Agent 用的提示词控制台。它不是一个独立程序，而是三层东西叠在一起：

1. **扩展** `<agent-dir>/extensions/ctxfold/index.ts` — 每轮按任务族组装提示词，写进 `systemPromptOptions.sections.ctxfold`
2. **层文件** `<agent-dir>/.ctxfold/layers/*.md` + 扩展目录下的 `layers/` — 真正被注入的正文
3. **技能** 就是本文件 — 教你怎么改上面两层而不搞坏它

## 先看状态，别猜

```bash
ctxfold status          # 注入了多少、装了几层、开了哪些规则
ctxfold verify          # Pi 实际会加载哪些文件（入口/层/规则/技能）
ctxfold analyze         # 每层多少字符，找出最臃肿的那层
```

在 Pi 会话里，等价的命令是 `/ctxfold status`、`/ctxfold layers`、`/ctxfold doctor`。
模型侧还有一个工具 `ctxfold_status`，可以在一次对话里直接读注入状态。

## 注入是怎么生效的

扩展订阅 `before_agent_start`，拿到当轮 user prompt，判断任务族，只注入该族需要的层：

| 任务族 | 命中信号 | 保留层 |
| --- | --- | --- |
| 逆向 / 卡密 | 逆向、脱壳、破解、keygen、frida、smali | `eng` `route.re` |
| Web 渗透 | 渗透、打点、sqli、xss、越权、上传 | `eng` `web` |
| CTF | ctf、flag、靶场、pwn | `eng` `ctf` |
| 应急响应 | 应急、排查、溯源、失陷、加固 | `ir` |
| 工程 | 实现、重构、报错、部署、优化 | `eng` |
| 通用 | 以上都不命中 | 全量注入 |

`core` 与 `refusal` 是常驻层，任何族都不裁。`rules` 层（规则集）永远进。

**这条路由是可关的。** `config.json` 里 `routing: false` 就变成全量注入——层多的时候这样最稳，只是更费 token。

## 改注入内容

改层文件，不要改 `index.ts`。扩展每轮重新读盘，改完下一轮就生效，不用重装也不用重启 Pi。

```bash
ctxfold layers list             # 已装层
ctxfold layers show eng         # 看某层全文
ctxfold layers fork eng         # 复制成用户层，包内原件不动
ctxfold layers path eng         # 该层文件的实际路径
```

`fork` 出来的副本落在 `<agent-dir>/.ctxfold/layers/`，同名层优先于扩展自带的那份。**要回滚就删掉副本**，扩展自动落回预设。

新加一个层：往用户层目录丢一个 `myname.md`，每轮就会追加进注入。文件名就是层名。

## 改规则

规则是每条可独立开关的短指令，比层更细：

```bash
ctxfold rules              # 列表，带 on/off
ctxfold rules off no-ask-back
ctxfold rules add --id x --label 标签 --body 一句话
ctxfold rules rm x
```

规则正文在扩展目录的 `rules.json`。**关掉一条规则不影响其余部分**——这就是它和层的分工：层管"这段内容要不要"，规则管"这条纪律要不要"。

## 排查：注入没生效

按这个顺序查，每一步都有对应命令：

1. `ctxfold verify` — 入口文件在不在、多少字节。字节数为 0 说明复制失败。
2. `/ctxfold status` — 看「当前注入」那一行。`本轮尚未进入` 说明扩展没被加载。
3. 检查 `<agent-dir>/extensions/ctxfold/index.ts` 的扩展有没有被 Pi 接受：Pi 加载失败会打印在启动日志里，通常是语法错误或 import 了不存在的模块。本扩展刻意零运行时依赖，正常不会出这类问题。
4. `ctxfold doctor` — 层目录缺失、空层、config 缺失都会点名。
5. `ctxfold render --text "..."` 会把某段文本的最终注入体完整打出来。**这是唯一可信的"实际注入了什么"的答案**，别靠读层文件推断。

`config.json` 的 `enabled: false` 会让扩展整个不注入。`/ctxfold enable` 改回来。

## 可选补丁

`patches/manifest.js` 里有 3 条对 Pi 自身 dist 的补丁，默认一条都不打：`ctxfold patch list` 看状态，`ctxfold patch apply --id <ID>` 打上，`ctxfold patch revert` 还原。

判据很简单：**能不能只用层和规则表达**。能就不要碰补丁——补丁改的是 Pi 的源码，Pi 升级会失效，还会让 `npm test` 之外的路径产生不可见差异。

## 放行策略

`config.json` 的 `approval` 决定扩展在 `tool_call` 边界做什么：

- `auto` — 全部放行，扩展不拦任何调用（默认）
- `confirm` — 命中破坏性模式时弹一次确认
- `block` — 命中直接拦，附原因

破坏性模式包括 `rm -rf`、`mkfs`、写 `/dev/`、`git push --force`、`drop table`、写系统目录等。**这是唯一会主动阻断工具调用的地方**，其余情况扩展只注入、不干预。

## 不要做的事

- 不要直接编辑 `<agent-dir>/extensions/ctxfold/index.ts` 来改内容——重装会覆盖。改层或规则。
- 不要在层文件里堆背景说明。层进的是每轮提示词，**每个字都在烧 token**。`ctxfold analyze` 会告诉你哪层最该瘦身。
- 不要把 `AGENTS.md` 的注入区块和扩展注入当成二选一。两者是叠加的：`AGENTS.md` 是静态底座，扩展是每轮动态裁剪。要只留一种，就 `ctxfold revert` 摘掉静态区块，或 `enabled: false` 关掉扩展。
