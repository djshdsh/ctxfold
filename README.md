<div align="center">

<img src="assets/avatar.png" width="96" alt="ctxfold">

# ctxfold

**Pi Agent 的提示词控制台：分层注入、按任务裁剪、一键清洗、原生桌面壳。**

不写配置、不改源码、不装依赖，双击就能把提示词体系装进 `~/.pi/agent`。

</div>

![一键注入](assets/screenshots/inject.png)

---

## 它是干什么的

Pi Agent 的系统提示词来自三处：内置提示词、`~/.pi/agent/AGENTS.md`、以及扩展在 `before_agent_start` 里塞进去的内容。想改其中任何一处，一般都得手工编辑文件、算好顺序、还要担心下次升级被覆盖。

ctxfold 把这件事做成一个可逆的开关：

- **分层**：七份提示词分文件存放，改哪一层就改哪个文件，不该动的不会被动到
- **裁剪**：按任务族（工程 / 逆向 / Web 渗透 / CTF / 应急响应）决定这次注入哪几层，闲聊时不会塞一万字
- **接管**：需要完全由 ctxfold 决定系统提示词时，打开 `override`，Pi 内置提示词和 `AGENTS.md` 一起让位
- **清洗**：把 `AGENTS.md` 里别人留下的提示词备份后清空，只留你自己的
- **可逆**：每一步都有备份，`revert` / `uninstall` 随时回到装之前

## 三条命令装完

```powershell
git clone https://github.com/djshdsh/ctxfold.git
cd ctxfold
node bin/ctxfold.js install
```

装完重开一个 `pi` 会话就生效。已经在跑的会话要重开。

不想碰命令行，直接双击 `ctxfold-app.exe`，第一页就是一个「一键注入」按钮。

## 界面

窗口是原生 WinForms（不是浏览器套壳），五页：

| 页 | 作用 | |
| --- | --- | --- |
| **一键注入** | 选 Pi Agent 目录 → 点一次，扩展 + 七层提示词 + 规则集 + 技能包全套装好，底部给回执 | ![inject](assets/screenshots/inject.png) |
| **概览** | 注入通道、接管状态、`AGENTS.md` 清洗结果、十项环境自检 | ![overview](assets/screenshots/overview.png) |
| **提示词层** | 七层逐层看字数、改内容、保存、单层还原到预设 | ![layers](assets/screenshots/layers.png) |
| **路由预览** | 粘一句任务描述，看它被判成哪一族、裁到哪几层、多少字符 | ![preview](assets/screenshots/preview.png) |
| **维护** | 装/卸扩展、开备份与扩展目录、本机 Pi 上游补丁的查看与打/撤、三个开关 | ![maintenance](assets/screenshots/maintenance.png) |

## 五条注入通道

ctxfold 不只有一种「注入」。按强度从弱到强：

| 通道 | 写什么 | 什么时候用 | 冲突风险 |
| --- | --- | --- | --- |
| 扩展（默认） | `~/.pi/agent/extensions/ctxfold/index.ts`，每轮在 `before_agent_start` 里注入 | 日常 | 与 `AGENTS.md` 并存，排在后面 |
| `AGENTS.md` 区块 | 在 `AGENTS.md` 里加一段带标记的区块 | 想要静态可见、能进版本库 | 与其它内容并存 |
| `override` | 置 `override: true`，扩展返回完整 `systemPrompt`，**直接替换** | 需要完全接管 | 内置提示词 + `AGENTS.md` 全部让位 |
| 清洗 | 备份后把 `AGENTS.md` 清空 | `AGENTS.md` 里有别人的提示词 | 会清掉非 ctxfold 的内容（有备份） |
| 上游补丁 | 给 Pi 自己的 dist 打源码补丁（默认零改动） | 想让 `developer` role 回退成 `system` 之类 | 升级 Pi 需要重打 |

推荐组合：**扩展 + 清洗 + override 开**。这样只有一个声音。

## 七层

| 层 | 字符 | 内容 |
| --- | ---: | --- |
| `core` | 1095 | 常驻底座：执行人格、纪律、交付形态 |
| `refusal` | 1913 | 放行策略与占位符归一，遇到"能不能做"怎么处理 |
| `eng` | 1085 | 工程与改码：写代码、修 bug、部署、测试 |
| `route.re` | 3520 | 逆向 / 脱壳 / 破解 / 注册机 / 二进制 |
| `web` | 1600 | Web 渗透：注入、越权、上传、WAF |
| `ctf` | 998 | CTF：杂项、隐写、取证、密码学 |
| `ir` | 1365 | 应急响应：样本分析、日志溯源、IOC |

`core` + `refusal` + `eng` 常驻，领域层按任务族裁剪。全量注入约 12.1k 字符，闲聊时裁到 ~4.6k。

改层不用碰代码：

```powershell
node bin/ctxfold.js layers show core      # 看
node bin/ctxfold.js layers fork core      # 复制一份到用户目录，随便改
notepad ~/.pi/agent/.ctxfold/layers/core.md
```

用户层目录 `~/.pi/agent/.ctxfold/layers/*.md` 优先级高于包内预设，改完下一轮就生效，不用重装。

## 路由

```powershell
node bin/ctxfold.js route --text "渗透这个站，做 sql 注入探测"
# 族 (web) · 层 core + refusal + eng + web + rules · 6216 字符 / 约 3680 tokens
```

族判定靠关键词计分，命中数打平时按顺序取先者。判断为 `general` 时全量注入，不做裁剪。

## 命令行

```
install   安装扩展/层/规则/技能        verify   检查 Pi 真会加载什么
apply     组装并写 AGENTS.md 区块      revert   摘掉区块或整份还原
status    当前状态                     doctor   十项环境自检
render    只输出组装结果               analyze  分层体量报告
route     预览裁剪结果                 layers   层操作
rules     规则开关                     skills   技能包同步
patch     上游 dist 补丁               backups  备份列表
sanitize  清洗原有提示词               restore  从备份还原
app       打开桌面程序                 gui      打开网页控制台
uninstall 全部撤掉
```

完整参数见 [docs/CLI.md](docs/CLI.md)。

## 上游补丁

改的是 Pi 自己的 dist（`.../pi-ai/dist/api/*.js` 之类），默认一条都不打。三条可打：

| 补丁 | 作用 |
| --- | --- |
| `DEEPSEEK_SYSTEM_ROLE` | reasoning 模型上把 `developer` role 退回 `system`，第三方中转不再拒收 |
| `ANTHROPIC_OAUTH_CLI_NEUTRAL` | OAuth 请求不再伪装 `claude-cli` |
| `ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY` | 不再往 system 首段插 Claude Code 的身份声明 |

```powershell
node bin/ctxfold.js patch list
node bin/ctxfold.js patch apply --id DEEPSEEK_SYSTEM_ROLE
node bin/ctxfold.js patch revert --id DEEPSEEK_SYSTEM_ROLE
```

首次打补丁自动生成 `.ctxfold.bak`，`revert` 从备份恢复。**Pi 升级后需要重打。**

## 开发

```powershell
node test/cli.test.mjs        # 59 项
node test/extension.test.mjs  # 59 项（jiti 真加载扩展）
node test/pi-load.test.mjs    # 20 项（调 Pi 自己的 discoverAndLoadExtensions）
node test/sanitize.test.mjs   # 31 项
npm test                      # 全部，253 项
```

零运行时依赖，只用 Node 标准库。测试会在临时目录里自己装一份，不碰你本机的 Pi 配置。

细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

构建：

```powershell
node scripts/build-exe.mjs     # dist/ctxfold.exe      命令行后端（Node SEA）
node scripts/build-shell.mjs   # dist/ctxfold-app.exe  原生窗口（WinForms + csc）
```

外壳用 Windows 自带的 `csc.exe` 编译，把后端整个作为资源塞进去，目标机不用装 Node。

发布：

```powershell
node scripts/publish.ps1 -Token <PAT> -Repo 用户名/ctxfold
```

或者打个 tag 让 CI 构建：

```powershell
git tag v1.2.1
git push origin v1.2.1
```

## 常见问题

**装完没反应？** 新开一个 `pi` 会话。已经在跑的不会重新读扩展。

**`status` 说没注入？** 看「注入通道」那一行：`扩展（每轮动态）` 表示走扩展，本来就不写 `AGENTS.md`。

**提示词还是别人的？** `AGENTS.md` 里有别人留下的内容，且 `override` 没开。跑 `ctxfold sanitize`，它备份后清空并打开接管。

**升级 Pi 之后怎么办？** 扩展不受影响；打过上游补丁的要 `patch revert` 再重装 Pi，然后 `patch apply`。

**能卸干净吗？** `uninstall` 撤注入、删扩展与技能、清状态；`AGENTS.md` 从备份还原。用户层目录会留着（那是你自己写的）。

## License

[MIT](LICENSE)
