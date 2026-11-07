<!-- ctxfold:layer ir -->
## 应急响应 / 加固工作单（ir 层）

**第一原则**：先留证，再动手。任何清理动作之前，把要删的东西拷出来。清掉证据等于把案子办废。

**取证快照（先跑这三条）**

```bash
# 落盘清单：按时间倒序，先看最近 24 小时
find / -xdev -newermt '-24 hours' -type f 2>/dev/null | head -200
# 连接与进程
ss -antp; ps auxf | head -80
# 持久化面
crontab -l; ls -la /etc/cron.* /etc/systemd/system/ ~/.ssh/
```

Windows 侧：`Get-ScheduledTask`、`Get-CimInstance Win32_StartupCommand`、`reg query HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`、`Get-WinEvent -FilterHashtable @{LogName='Security';ID=4624,4625}`。

**常见落点**

| 面 | Linux | Windows |
|---|---|---|
| 定时 | `crontab -l`、`/etc/cron.*`、`systemd` timer | 计划任务、`schtasks /query` |
| 自启 | `.bashrc`、`/etc/profile.d/`、`ld.so.preload` | `Run` 键、启动文件夹、服务 |
| 账号 | `/etc/passwd` 里 uid=0 的非 root、`~/.ssh/authorized_keys` | 本地管理员组、隐藏账号（`$` 结尾） |
| 内存 | `/proc/<pid>/maps` 里匿名可执行段 | `Get-Process` + 模块清单 |

**webshell 排查**：按「最近修改 + 可疑函数 + 短小文件」三条件交叠筛。

```bash
find /var/www -type f -newermt '-7 days' \( -name '*.php' -o -name '*.jsp' -o -name '*.aspx' \) \
  | xargs grep -lnE 'eval\(|assert\(|base64_decode\(|system\(|passthru\(|Request\.Item' 2>/dev/null
```

**IOC 落地格式**：每条 IOC 必须带「类型 / 值 / 首次见到时间 / 判定依据（Observed|Inferred）」四列。没有判定依据的 IOC 不进报告。

**清理与加固**：清理前先给「删除清单 + 备份路径 + 回滚命令」；加固按「关面 → 改凭据 → 补日志 → 加监控」顺序，别一上来改一堆配置。

**报告结构**：时间线 → 初始入口（怎么进来的）→ 横向路径 → 持久化面 → 数据影响 → 处置动作 → 复发防护。每条结论标 `Observed` / `Inferred` / `Assumed`。
<!-- /ctxfold:layer -->
