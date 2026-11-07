# 架构

```
                   ┌──────────────────────────────┐
                   │  Pi Agent 会话                │
                   │                              │
  before_agent_start ──► 扩展 ──► 选层 ──► 拼接 ──► systemPrompt
                   │      │                       │
                   │      ├─ layers/*.md（7 层）   │
                   │      ├─ rules.json           │
                   │      └─ route（任务族判定）    │
                   └──────────────────────────────┘
                              ▲
                              │ install / sanitize / patch
                   ┌──────────┴───────────┐
                   │  ctxfold（CLI + 壳）  │
                   └──────────────────────┘
```

## 目录

```
ctxfold/
├── bin/ctxfold.js          命令入口，只做 dispatch
├── lib/
│   ├── paths.js            home / 扩展目录 / 用户层目录解析
│   ├── layers.js           读层、解析层标记、用户层覆盖
│   ├── router.js           任务族判定与裁剪
│   ├── compose.js          组装成最终提示词文本
│   ├── rules.js            规则集读写与开关
│   ├── inject.js           AGENTS.md 区块的读写（标记定位）
│   ├── install.js          铺文件、备份、卸载
│   ├── sanitize.js         清洗 / 还原 / override 开关
│   ├── dist-patch.js       上游 dist 补丁的 inspect/apply/revert
│   ├── bridge.js           桌面壳与网页控制台用的 JSON 接口
│   ├── analyzer.js         体量统计
│   ├── backup.js           备份列表
│   ├── jsonio.js           带 BOM 容错的 JSON 读写
│   └── commands.js         每个子命令的实现
├── presets/layers/*.md     七层预设（装到 home 的是副本）
├── presets/rules/default.json  默认规则集
├── patches/manifest.js     3 条可选补丁的定义（改 Pi 自己的 dist）
├── extension/index.ts      Pi 扩展（零依赖，jiti 加载）
├── shell/App.cs            原生 WinForms 外壳
├── gui/                    网页控制台（server.js + index.html）
├── scripts/                构建与发布脚本
└── test/                   单元测试
```

## 数据流：一次会话

1. Pi 启动，`discoverAndLoadExtensions` 扫 `~/.pi/agent/extensions/`，用 jiti 加载 `ctxfold/index.ts`
2. 扩展读 `config.json`；`enabled: false` 就直接返回，不碰任何东西
3. 用户发消息，Pi 触发 `before_agent_start`，事件里带 `prompt` 和 `systemPromptOptions`
4. 扩展按 `prompt` 走路由：命中哪个族 → 该族层 + 常驻层 + 规则层
5. 层文本拼接（用户层优先于包内预设），超过 `maxChars` 就截断
6. `override: true` → 返回 `{ systemPrompt: 文本 }`，Pi 用它替换整份系统提示词
   `override: false` → 写进 `systemPromptOptions.sections.ctxfold`，与其它内容并存
7. 会话结束时 `session_shutdown` 把统计写回状态文件

只写 `sections` 里的一节，是为了不打掉 Pi 的提示词缓存前缀；只有明确要接管时才整份替换。

## 扩展注册了什么

```ts
pi.on("before_agent_start", …)   // 注入
pi.on("tool_call", …)            // 危险命令审批
pi.on("session_start", …)        // 统计与自检
pi.on("session_shutdown", …)     // 落状态
pi.registerCommand("ctxfold", …) // /ctxfold status|layers|route|…
pi.registerTool({ name: "ctxfold_status" })  // 让模型自己查状态
```

审批策略在 `config.json` 的 `approval`：`auto` / `confirm` / `deny`。命中破坏性命令（`rm -rf`、`mkfs`、写 `/dev/`、`git push --force`、`git reset --hard`、`drop table`、写系统目录）时按该策略处理。

## 配置

`~/.pi/agent/extensions/ctxfold/config.json`：

```json
{
  "enabled": true,
  "routing": true,
  "maxChars": 0,
  "approval": "auto",
  "override": false
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉则完全不注入 |
| `routing` | `true` | `false` = 每轮全量注入，不按任务族裁剪 |
| `maxChars` | `0` | `0` 不限；正数则截断到该字符数 |
| `approval` | `"auto"` | `auto` 放行 / `confirm` 询问 / `deny` 拦截 |
| `override` | `false` | `true` = 整份替换系统提示词 |

这个文件**不会**被 `install` 覆盖，只在缺失时创建。

## 层解析

每份层文件可以带标记：

```markdown
<!-- ctxfold:layer core -->
...内容...
<!-- /ctxfold:layer -->
```

没有标记时整份文件算一层，层名取文件名。

查找顺序：`<home>/.ctxfold/layers/<name>.md` → `<home>/extensions/ctxfold/layers/<name>.md` → `presets/layers/<name>.md`。

第一处命中即用，所以改用户层不用重装。

## 组装顺序

```
core → refusal → eng → [领域层] → rules
```

领域层按族取：`route.re` / `web` / `ctf` / `ir`；`general` 族全量注入。

层与层之间留一个空行，整体不加额外标题——避免模型把标题当成结构信号。

## AGENTS.md 区块

`apply` 写入的形态：

```markdown
<!-- ctxfold:start -->
…组装结果…
<!-- ctxfold:end -->
```

`inject.js` 只认这两个标记，`revert` 只删这一段的字节区间，区块外的内容原样保留。标记缺失时按 `--position` 插入。

## 清洗与接管

`sanitize()` 做三件事，全部在 `sanitize.json` 里记账：

1. 把 `<home>/AGENTS.md`（以及 `--project` 时的 `<cwd>/AGENTS.md`）备份到 `.ctxfold/backups/<时间>-<文件>.md`
2. 清空文件（保留 ctxfold 自己的区块，除非 `--no-keep-block`）
3. 若未指定 `--no-override`，把 `config.json` 的 `override` 置 `true`

`restore()` 按 `sanitize.json` 的记录把备份写回，并把 `override` 复位。

## 上游补丁

`patches/manifest.js` 描述每条补丁：目标文件、查找串、替换串、期望出现次数。

`dist-patch.js` 的流程：

```
inspect  → 读目标文件，判断 已打 / 可打 / 不适用（版本不匹配）
apply    → 首次复制成 .ctxfold.bak，然后替换；次数不符就整体回滚
revert   → 从 .ctxfold.bak 写回
clean    → 删掉没有对应源文件的孤儿备份
```

「不适用」是正常结果：Pi 版本不同，查找串找不到就不打，不会破坏文件。

## bridge 协议

桌面壳不直接读文件，全部通过 `ctxfold bridge <action> <base64 json>` 走一次进程调用：

```
请求  {action, args}
响应  {"ok": true, "action": "...", "data": {...}}
      {"ok": false, "error": "..."}
```

这样 CLI、桌面壳、网页控制台三端共用同一套逻辑，只有一份真相。

## 构建

```
build-exe.mjs   → dist/ctxfold.exe       Node SEA，把 lib/presets/gui/patches 塞进单文件
build-shell.mjs → dist/ctxfold-app.exe   csc 编译 shell/App.cs，把上面那个整个作为资源塞进去
```

外壳首次运行时把内嵌后端摊到 `%LOCALAPPDATA%\ctxfold\runtime\<版本>\`，旧版本目录清掉。
