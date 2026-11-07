# 参与开发

先说清楚这个项目是什么：**它是给 Pi Agent 用的提示词控制台，不是 Pi 的分支**。  
所有功能都必须建立在 Pi 公开的扩展点上（事件、命令、工具），不改 Pi 的源码——除了 `dist-patch` 那 4 条，它们是可选的、显式开关的。

## 环境

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| Node | ≥ 18.17 | 只用标准库，没有运行时依赖 |
| Pi Agent | 1.x | `install` / `verify` 要能找到它 |
| .NET Framework | 4.x | **只有**编译桌面外壳时需要（`csc.exe`） |

Windows 上如果 `pwsh` 不在，用系统自带的 `powershell` 也行。

## 跑起来

```powershell
git clone https://github.com/djshdsh/ctxfold.git
cd ctxfold
npm test                     # 全部测试，不需要装任何依赖
node bin/ctxfold.js doctor   # 看本机环境
```

改代码时常用的几条：

```powershell
node test/cli.test.mjs           # CLI 层
node test/extension.test.mjs     # 扩展逻辑（用 Pi 的 jiti 真加载）
node test/pi-load.test.mjs       # 走 Pi 自己的 discoverAndLoadExtensions
node test/sanitize.test.mjs      # 清洗 / 还原
npm run exe                      # 打后端单文件
npm run shell                    # 打桌面外壳（会先打后端）
```

## 代码地图

| 想改什么 | 去哪 |
| --- | --- |
| 提示词内容 | `presets/layers/*.md` |
| 任务族判定 | `lib/router.js` 的 `FAMILY_PATTERNS` |
| 注入行为 | `extension/index.ts` |
| 某个子命令 | `lib/commands.js` |
| 桌面外壳的界面 | `shell/App.cs` |
| 外壳能调到什么 | `lib/bridge.js` |
| 发布流程 | `scripts/build-exe.mjs` → `scripts/build-shell.mjs` |

## 改提示词层的规矩

1. **不要直接改 `presets/layers/`**，除非你确定要改默认值——用户层会覆盖它，改了也未必生效，容易误导
2. 只写正向指令。「不要做 X」的清单会让模型盯着 X
3. 别把具体目标写进层（IP、域名、样本名），那些是运行时的事
4. 改完跑 `node test/extension.test.mjs`，那里有哨兵检查，防止一族层漏进另一族

## 加一个子命令

```js
// lib/commands.js
export function cmdFoo(flags, home) {
  return `...`;                    // 返回字符串 → 直接打印
  // 或者 emitJson(out)           // 结构化输出
}
```

然后在同文件的 `dispatch` 里加一行 `case "foo":`，再补 `help`。

界面能用到的话，同时在 `lib/bridge.js` 的 switch 里加一个 action。

## 测试怎么写

测试不引框架，就是 `assert` + 自数通过条数，输出 `通过 / 失败` 与退出码。新增测试文件后记得加进 `package.json` 的 `test` 链。

**必须避免的假阳性**：不要用「输出里不含某个词」判断行为，好多词在无关层里也有。用**只存在于目标文件的长句**当哨兵。

## 提交

```
<范围>: <做了什么>

为什么这么做，代价是什么
```

范围用目录名或功能名，例如 `router: 修正裸「注入」打平后误判为 re`。

一个提交只说一件事。界面截图放进 PR 描述，别塞进仓库。

## 发布

```powershell
npm test
npm run exe          # dist/ctxfold.exe
npm run shell        # dist/ctxfold-app.exe
git tag v1.2.2
git push origin main --tags
```

推 tag 会触发 `.github/workflows/release.yml`：跑测试 → 打两个 exe → 出 zip → 建 Release。

外壳的 `AssemblyVersion` 在 `shell/App.cs` 顶部，改版本时一起改，否则运行时目录复用旧后端。

## 不做什么

- 不往仓库里塞 `dist/`、`build/`、`node_modules/`、`.sea-build/`
- 不引入运行时依赖。宁可多写 30 行标准库代码
- 不动 Pi 的源码，除非那条补丁在 `patches/manifest.js` 里而且默认关闭
