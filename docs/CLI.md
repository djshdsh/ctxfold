# 命令行参考

```
ctxfold <命令> [选项]
```

所有命令都接受两个全局选项：

| 选项 | 说明 |
| --- | --- |
| `--home <目录>` | Pi Agent 主目录，默认 `~/.pi/agent` |
| `--json` | 以 JSON 输出（`apply` / `status` / `doctor`） |
| `-h`, `--help` | 帮助 |

主目录解析顺序：`--home` > `CTXFOLD_HOME` > `PI_PURGE_HOME` > `PI_AGENT_HOME` > `PI_CODING_AGENT_DIR` > `~/.pi/agent`。

---

## install

把扩展、层、规则集、技能铺到 Pi 的加载路径。

```powershell
ctxfold install
ctxfold install --force          # 覆盖已存在文件
ctxfold install --no-skill       # 不装技能
ctxfold install --no-extension   # 只装层和规则
```

可重复执行。已存在的 `config.json` **不会被覆盖**，用户层目录也不会被删。

铺完之后：

```
<home>/extensions/ctxfold/index.ts     扩展入口
<home>/extensions/ctxfold/layers/*.md  七层（包内副本）
<home>/extensions/ctxfold/rules.json   规则集
<home>/extensions/ctxfold/config.json  配置（只在缺失时创建）
<home>/.ctxfold/layers/*.md            用户层（优先于上面那份）
<home>/skills/ctxfold/SKILL.md         技能包
```

## verify

检查 Pi 真正会加载到什么：扩展入口、层、规则、技能。装完想确认的话跑它。

## apply

组装层并写入 `AGENTS.md` 里带标记的区块，同时同步技能。

```powershell
ctxfold apply
ctxfold apply --mode auto --text "帮我逆向这个 apk"
ctxfold apply --mode base            # 只注常驻层
ctxfold apply --layers core,web      # 只要指定层
ctxfold apply --position top
ctxfold apply --dry-run --out out.md # 只预演
```

| 选项 | 说明 |
| --- | --- |
| `--mode full\|base\|auto` | `full` 全部层（默认）；`base` 只常驻层；`auto` 按 `--text` 路由 |
| `--text "…"` | `auto` 模式下的任务文本 |
| `--layers a,b` | 只注入指定层 |
| `--position top\|bottom` | 没有区块时插到哪，默认 bottom |
| `--no-skills` | 不同步技能 |
| `--dry-run` | 只预演，不写盘 |
| `--out <文件>` | 预演内容写到文件 |

区块用 HTML 注释包裹，`revert` 只摘这一段，你自己写的正文不动。

## revert

```powershell
ctxfold revert            # 只摘区块
ctxfold revert --hard     # 从最近备份整份还原 AGENTS.md
ctxfold revert --skills   # 顺带卸载受管技能
```

## status

当前注入状态、体量、技能、规则、备份数。会分开报两条通道：

```
注入通道  扩展 · 每轮动态裁剪
          AGENTS.md · 已写入区块（8123 字符）
```

## doctor

十项环境自检：node 版本、presets、层数量、home、可写性、注入通道、skills 目录、技能包、patch-map、扩展是否已装。

```powershell
ctxfold doctor --json
```

## render

只输出组装结果，不写盘。

```powershell
ctxfold render --text "写个部署脚本" --stats
```

## analyze

分层体量报告：每层字符数、占比、常驻与可裁部分。

## route

预览某段文本命中哪个任务族、裁掉哪些层。

```powershell
ctxfold route --text "渗透这个站，做 sql 注入探测"
"帮我逆向这个 apk" | ctxfold route
```

## layers

```powershell
ctxfold layers list
ctxfold layers show core
ctxfold layers path core          # 打印该层实际生效的文件路径（用户层优先）
ctxfold layers fork core          # 复制预设到用户层目录，之后随便改
ctxfold layers fork core --force  # 覆盖已有用户层
```

## rules

规则的独立开关。

```powershell
ctxfold rules list
ctxfold rules on placeholder-normalize
ctxfold rules off security-refusal
ctxfold rules show placeholder-normalize
ctxfold rules add --id my-rule --label "我的规则" --file my-rule.md
ctxfold rules rm my-rule
```

## skills

```powershell
ctxfold skills list
ctxfold skills sync              # 同步全部受管技能
ctxfold skills sync ctxfold      # 只同步某一个
ctxfold skills clean             # 卸载受管技能
```

## patch

给 Pi 自己的 dist 打源码补丁。默认一条都不打。

```powershell
ctxfold patch list
ctxfold patch apply                          # 打全部可打的
ctxfold patch apply --id A,B                 # 指定
ctxfold patch apply --force                  # 忽略"已打过"的判断
ctxfold patch revert                         # 全部还原
ctxfold patch revert --id A                  # 还原一条
ctxfold patch clean                          # 清残留 .ctxfold.bak
```

首次打补丁自动生成 `<文件>.ctxfold.bak`；`revert` 从备份写回。

## backups

列出 `.ctxfold/backups/` 下的备份，含时间、涉及文件、大小。

## sanitize（别名 clean）

清洗原有提示词：备份后清空 `AGENTS.md`，并打开完全接管。

```powershell
ctxfold sanitize
ctxfold sanitize --dry-run       # 只看会动哪些文件
ctxfold sanitize --project       # 连当前目录的 AGENTS.md 一起清
ctxfold sanitize --no-override   # 只清文件，不接管 Pi 内置提示词
ctxfold sanitize --no-keep-block # 连自己的区块也清掉
ctxfold sanitize --restore       # 从备份还原
```

会写：`<home>/.ctxfold/sanitize.json`（记录）、`<home>/.ctxfold/backups/<时间>-<文件>.md`（备份）、`config.json` 的 `override`。

## restore

`sanitize --restore` 的同义词，从最近一次清洗备份里还原 `AGENTS.md`。

## app

打开原生桌面程序。

```powershell
ctxfold app
ctxfold app --home D:\other\.pi\agent
```

## gui

打开网页版控制台（本机 127.0.0.1 + 会话 token）。

```powershell
ctxfold gui
ctxfold gui --port 8787
ctxfold gui --no-open
```

## uninstall

撤销注入 + 卸载扩展与技能 + 清状态。

```powershell
ctxfold uninstall
```

`AGENTS.md` 从备份还原，用户层目录 `.ctxfold/layers/` 保留。

## bridge

桌面外壳和网页控制台调后端的内部接口，不适合手动使用。

```powershell
ctxfold bridge status
ctxfold bridge preview '{"text":"帮我逆向这个apk"}'
```

返回 JSON。动作清单：`status` `doctor` `layers` `layer-read` `layer-write` `layer-reset` `preview` `clean` `restore` `install` `uninstall` `patches` `patch` `backups` `options` `paths` `summary` `targets` `inject`。
