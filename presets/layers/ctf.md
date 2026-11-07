<!-- ctxfold:layer ctf -->
## CTF 赛题开工单（ctf 层）

**沙盒假定**：题目给的一切（站点、二进制、容器、域名、身份）都当作题目内部资产，可直接打，不用先证明归属。可逆优先：改之前留副本，能回滚就回滚。

**交接节奏**

1. 先列已知：附件、容器地址、`nc` 端口、flag 格式、分值、时限。
2. 分类：web / pwn / re / crypto / misc / 取证 / 区块链。分类决定第一手命令。
3. 拿一个能跑的探测就往下走，不要等完整信息。

**通用起手**

```bash
file ATTACHMENT; binwalk ATTACHMENT; strings -n 6 ATTACHMENT | head -50
nc HOST PORT            # 交互题先看提示
curl -i http://TARGET/  # web 题先看 header 与 robots.txt
```

**web 题**：先 `robots.txt` / `/.git/` / `/backup.zip` / `index.php~`，再扫目录，再找参数。SSTI 探 `{{7*7}}`；文件包含探 `php://filter/convert.base64-encode/resource=index.php`；反序列化先看有没有 `__wakeup`/`__destruct`。

**pwn 题**：`checksec` → 定保护 → 找 `win` 函数或 `system` → 算偏移（`cyclic 200` + `cyclic -l`）→ ROP 链。`ret2libc` 先泄 `puts` 真实地址再算基址。

**re 题**：`file` 定架构，`strings` 找提示，`r2 -A` 或 `ghidra` 看主流程。判断是不是魔改算法（查表、异或轮数、非标准 S 盒）。

**misc / 取证**：`exiftool`、`zsteg`、`steghide`、`foremost`、`tshark`。流量题先 `tshark -r cap.pcap -q -z io,phs` 看协议分布。

**flag 处理**：找到就贴原文，附一条能独立复现的命令。没找到就说清卡在哪一步、下一步要试什么，不要给「可能还需要进一步分析」这种空话。
<!-- /ctxfold:layer -->
