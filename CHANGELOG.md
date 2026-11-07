# 更新记录

版本号跟着功能走，不跟日期走。

## 1.3.3

**界面入口**

- 桌面壳底部常驻页脚：QQ 群 `1109964876`（点一下复制）、中转破甲 `https://www.hunmeng.icu/`（点一下打开），右侧配「复制群号 / 打开中转」两个按钮
- 网页版首页顶部与页脚同步显示群号与中转地址
- 「关于」对话框补上群号与中转地址
- README 首屏截图更新

## 1.3.2

**修复**

- 首页断言不再绑死品牌前缀，改标题不会再让 CI 挂掉

## 1.3.1

**品牌与入口**

- 项目名为「AI 破甲 · ctxfold」，桌面壳窗口标题与网页标题同步
- README 顶部常驻入口：QQ 群 `1109964876`、中转破甲地址 <https://www.hunmeng.icu/>

## 1.3.0

**精简仓库**

- 删掉 `presets/patch-map.json`、`docs/PATCH-MAP.md` 和生成它们的两支脚本：那是一张内部编号表，对使用者没有价值，还让构建多出一个依赖本机路径的步骤
- `doctor` 的 `patch-map` 项换成 `patches`，报告可选补丁条数，仍然是十项
- 统一文档口径与代号称谓，只讲 ctxfold 自己怎么工作


## 1.2.2

**修 CI**

- `test/extension.test.mjs` 改成自己在临时目录里 `install` 一份再测，不再读本机 `~/.pi/agent`
- jiti 优先用 Pi 自带的那份，没有就退回仓库的 `devDependency`
- `test/pi-load.test.mjs` 在没有 Pi 的环境里明确跳过（退出码 0），不再算失败
- `devDependencies` 加 `jiti`，让 CI 能跑扩展测试
- 测试不再依赖「本机装过 Pi」这个前提，`npm test` 在干净机器上可跑

## 1.2.1

**桌面外壳**

- 5 个页签全部重做：一键注入 / 概览 / 提示词层 / 路由预览 / 维护
- 维护页的复选框换成胶囊开关，补丁列表改成卡片内列表、行高统一
- 修 `RoundedPanel` 圆角外残留旧像素导致的重影（容器改实色，自绘控件先刷满背景）
- 修 `RefreshAll` 组装结果漏 `ok` 导致误报「后端调用失败」
- 程序图标内嵌到外壳，编译时自动带入

**文档**

- 重写 `README.md`，从「介绍」改成「照着做」
- 新增 `docs/CLI.md`（全部子命令）、`docs/ARCHITECTURE.md`（数据流）、`docs/LAYERS.md`（七层写法）
- 新增 `CONTRIBUTING.md`、`CHANGELOG.md`、`README.en.md`、issue 模板

**仓库**

- 图标与截图从 `build/`（被 gitignore）挪到 `assets/`，修 CI 里 `csc` 找不到资源的问题
- `build-shell.mjs` 改从 `assets/` 取图标
- `package.json` 补 `repository` / `homepage` / `bugs` / `exports`，`install` 脚本改名 `setup`（避免 npm 生命周期冲突）

## 1.2.0

**首次发布**

- 分层提示词注入：7 层、任务族路由、按任务裁剪
- 完全接管：`override` 打开后用组装结果整份替换系统提示词
- 清洗：备份后清空 `AGENTS.md`，可一键还原
- 桌面外壳：原生 WinForms 窗口，内嵌后端单文件，双击即用
- 网页控制台：`ctxfold gui`，本机 127.0.0.1 + 会话 token
- 技能包：装到 `<home>/skills/ctxfold/`
- 规则集：`rules.json`，每条独立开关
- 上游补丁：3 条可选，`ctxfold patch` 管理，自动 `.ctxfold.bak` 备份
- `doctor` 十项自检，含扩展是否已铺到 Pi 的真实加载路径

## 1.1.0

- 新增 `sanitize` / `restore`：清洗原有提示词并接管
- 修 `AGENTS.md` 带 BOM 时区块定位失败、`revert` 后残留空行的问题
- `doctor` 改双通道判定：扩展在跑时不再误报「未注入」

## 1.0.0

- 首个可运行版本：`install` / `apply` / `revert` / `status` / `render` / `route` / `layers` / `rules` / `skills` / `doctor`
- Pi 扩展入口，注册 4 个事件 + 1 个命令 + 1 个工具
- 5 个测试文件，覆盖 CLI、扩展、真实加载、dist 补丁、网页控制台

