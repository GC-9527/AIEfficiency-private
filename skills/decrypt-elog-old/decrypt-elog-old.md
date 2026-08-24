---
name: decrypt-elog-old
description: 解密 Old 版本应用市场的 ELOG 加密日志（使用 elog-decrypt jar 工具）
triggers: ELOG, 解密, Old版, 旧版, 应用市场日志
modification: false
engine: claude
---

# Old 版应用市场 ELOG 日志解密

使用 `elog-decrypt-1.0.8.jar` 解密 Old 版本应用市场产生的 ELOG 加密 logcat 日志。

> 与 `decrypt-elog` 的区别：本 Skill 针对 Old 版应用市场的加密格式，使用 Java jar 工具解密；`decrypt-elog` 针对新版格式，使用 Node.js 脚本解密。

## 工具路径（随 skill 分发）

- **解密工具**: `{SKILLS_DIR}/decrypt-elog-old/keys/elog-decrypt-1.0.8.jar`
- **RSA 私钥**: `{SKILLS_DIR}/decrypt-elog-old/keys/rsa_private_pkcs8.pem`

> `{SKILLS_DIR}` 由网关在加载时替换为当前设备上 skills 目录的绝对路径，确保跨设备可用。

## 参数解析

从用户消息中提取：
- `<input-file>` — **必需**，待解密的日志文件路径
- `--out <path>` — 可选，解密后的输出文件路径（默认：输入文件同目录，文件名添加 `_decrypted` 后缀）

## 执行步骤

1. 解析用户提供的输入文件路径，确认文件存在。

2. 确定输出路径：
   - 用户指定了 `--out`：使用指定路径
   - 未指定：将输入文件名的扩展名前插入 `_decrypted`，如 `device.log` → `device_decrypted.log`

3. 使用 Bash 工具执行解密命令：

```bash
java -jar "{SKILLS_DIR}/decrypt-elog-old/keys/elog-decrypt-1.0.8.jar" logcat --in "<input-file>" --out "<output-file>" --privkey "{SKILLS_DIR}/decrypt-elog-old/keys/rsa_private_pkcs8.pem"
```

4. 检查命令退出码和输出，向用户报告：
   - 解密是否成功
   - 输出文件路径
   - 如有错误，提示可能原因（Java 未安装、文件路径错误、密钥不匹配等）

5. 如果用户需要查看解密内容，使用 Read 工具读取输出文件。

## 示例调用

用户说：`/decrypt-elog-old D:\logs\device.log`

执行：
```bash
java -jar "{SKILLS_DIR}/decrypt-elog-old/keys/elog-decrypt-1.0.8.jar" logcat --in "D:\logs\device.log" --out "D:\logs\device_decrypted.log" --privkey "{SKILLS_DIR}/decrypt-elog-old/keys/rsa_private_pkcs8.pem"
```

用户说：`/decrypt-elog-old D:\logs\device.log --out D:\logs\output.log`

执行：
```bash
java -jar "{SKILLS_DIR}/decrypt-elog-old/keys/elog-decrypt-1.0.8.jar" logcat --in "D:\logs\device.log" --out "D:\logs\output.log" --privkey "{SKILLS_DIR}/decrypt-elog-old/keys/rsa_private_pkcs8.pem"
```

## 前置条件

- 系统已安装 Java Runtime（`java -version` 可用）
- jar 工具和密钥文件已随 skill 一起分发到 `{SKILLS_DIR}/decrypt-elog-old/keys/`
