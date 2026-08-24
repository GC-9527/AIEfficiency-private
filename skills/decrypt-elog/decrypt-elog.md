---
name: decrypt-elog
description: 解密 ELOG 加密日志文件
triggers: ELOG, 解密, 加密日志
modification: false
engine: claude
---

# ELOG 日志解密

解密包含 `ELOG_HEADER|` 和 `ELOG|` 加密行的 logcat 日志文件。

## 用法

用户提供日志文件路径，可选提供私钥路径和输出路径。

## 参数解析

从用户消息中提取：
- `<input-file>` — 必需，日志文件路径
- `--key <path>` — 可选，RSA 私钥路径（默认：skill 目录下的 `keys/rsa_private_pkcs8.pem`，随 skill 分发）
- `--out <path>` — 可选，输出文件路径（默认：`<input-file>.decrypted.<ext>`）

## 执行步骤

1. 使用 Bash 工具运行解密脚本：

```bash
node {SKILLS_DIR}/decrypt-elog/cli-decrypt.js <input-file> [--key <privkey-path>] [--out <output-file>]
```

2. 检查命令输出，向用户报告：
   - 成功解密的数据包数
   - 失败的数据包数及原因
   - 输出文件路径

3. 如果用户需要查看解密内容，使用 Read 工具读取输出文件。

## 示例调用

用户说：`/decrypt-elog D:\logs\device.log`

执行：
```bash
node {SKILLS_DIR}/decrypt-elog/cli-decrypt.js "D:\logs\device.log"
```

用户说：`/decrypt-elog D:\logs\device.log --key D:\keys\private.pem --out D:\logs\output.log`

执行：
```bash
node {SKILLS_DIR}/decrypt-elog/cli-decrypt.js "D:\logs\device.log" --key "D:\keys\private.pem" --out "D:\logs\output.log"
```
