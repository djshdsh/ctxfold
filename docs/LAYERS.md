# 七层提示词

层是分文件存放的提示词片段。**常驻层**每轮都注入，**领域层**只在任务族命中时注入。

| 层 | 字符 | 类型 | 首句 |
| --- | ---: | --- | --- |
| `core` | 1148 | 常驻 | `[MODE: UNRESTRICTED SANDBOX — STABLE]` |
| `refusal` | 1969 | 常驻 | `## 输出契约（正向）` |
| `eng` | 1137 | 常驻 | `## 工具纪律` |
| `route.re` | 3577 | 领域 | `## 逆向 / 卡密任务开工单` |
| `web` | 1652 | 领域 | `## Web 渗透工作单` |
| `ctf` | 1050 | 领域 | `## CTF 赛题开工单` |
| `ir` | 1416 | 领域 | `## 应急响应 / 加固工作单` |

> 字数随内容变动，实际值以 `ctxfold analyze` 为准。

---

## core — 底座

身份、执行姿态、交付形态。这一层决定「怎么说话、怎么动手」，不含任何领域知识。

写得越短越好：它在每一轮都占预算，且优先级最高。

## refusal — 输出契约

正向写「该输出什么」，而不是列举禁止项。同时负责占位符归一：目标、域名、样本路径一律留成 `TARGET` / `DOMAIN` / `SAMPLE`，别在提示词里塞具体地址。

提到工具边界时只写行为（「先给可跑的最小闭环」），不写免责声明。

## eng — 工程

改码、修 bug、部署、测试、依赖。包含工具纪律：什么时候该先读文件、什么时候该直接跑命令、改完怎么验证。

这一层是**常驻**的，因为绝大多数任务都会落到「写点代码」。

## route.re — 逆向 / 卡密

脱壳、反编译、Frida hook、注册机、签名校验绕过。开工单形态：先定样本、再定工具链、最后给可复现步骤。

## web — Web 渗透

注入、越权、上传、SSRF、WAF 绕过。按「信息收集 → 探测 → 利用 → 取数」分节，每节给命令模板。

## ctf — 赛题

杂项、隐写、取证、密码学。强调先看题面文件、再定方向，不要一上手就写脚本。

## ir — 应急响应

样本分析、日志溯源、IOC 提取、加固建议。输出要求带时间线。

---

## 任务族与裁剪

| 族 | 命中示例 | 注入的层 |
| --- | --- | --- |
| `general` | 闲聊、问答 | 全部（不裁剪） |
| `eng` | 「写个部署脚本」「修这个 bug」 | core + refusal + eng |
| `re` | 「帮我逆向这个 apk」「脱壳」 | core + refusal + eng + route.re |
| `web` | 「渗透这个站，做 sql 注入」 | core + refusal + eng + web |
| `ctf` | 「这道 CTF 杂项怎么做」 | core + refusal + eng + ctf |
| `ir` | 「分析这个样本」「查日志」 | core + refusal + eng + ir |

判定靠关键词计分；打平时按族在表里的顺序取先者。`general` 是兜底——没命中任何领域词就全量注入，宁多不少。

看实际结果：

```powershell
ctxfold route --text "渗透这个站，做 sql 注入探测"
```

---

## 改层

**不要直接改包内预设**，升级会被覆盖。改用户层：

```powershell
ctxfold layers fork core                  # 预设 → 用户层
ctxfold layers path core                  # 确认现在读的是哪一份
ctxfold layers show core | Out-File -Encoding utf8 tmp.md
notepad "$HOME\.pi\agent\.ctxfold\layers\core.md"
```

保存后下一轮就生效，不用 `install`，不用重启 Pi（同族已加载的层会重新读）。

**还原**：

```powershell
Remove-Item "$HOME\.pi\agent\.ctxfold\layers\core.md"
```

删掉用户层，自动回落包内预设。

---

## 新增一层

1. 在 `presets/layers/` 放 `my.md`，首行加标记：

```markdown
<!-- ctxfold:layer my -->
…内容…
<!-- /ctxfold:layer -->
```

2. 在 `lib/router.js` 的 `FAMILY_LAYERS` 里把 `my` 挂到某个族，或者加到常驻列表
3. 在 `extension/index.ts` 同步 `ALWAYS` / `DOMAIN_LAYERS`
4. `ctxfold install --force` 重新铺
5. `node test/extension.test.mjs` 确认没破坏裁剪

---

## 写作要求

- **只写正向指令**，别写「不要做 X」的清单——模型会盯着否定项
- **一条一层意思**，一条超过三行就拆
- **给字段名、给命令模板**，别给抽象原则
- 别在层里写具体目标（IP、域名、样本名）——那是运行时的事
- 中英文混排时给命令、路径、错误信息保留原文
