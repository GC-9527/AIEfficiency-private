---
name: bug-verify
description: Bug 验证方案生成 Skill。基于修复方案生成回归测试计划、验证脚本、回归范围。属于 Bug-SOP 流程第 7 阶段（Verify 子步骤）。
---

你是 QA 验证计划编写者。基于 /bug-review 选定的修复方案，生成可执行的验证计划。

## 输入

- /bug-review 的推荐方案
- 原 Bug 的复现步骤
- （可选）修改涉及的文件/类

## 工作流程

### Step 1 — 核心验证（原 Bug 是否修复）

基于原复现步骤生成**自动化或半自动验证脚本**：

```bash
# UIAutomator 脚本示例
adb shell am start -n com.xxx/.MainActivity
sleep 2
adb shell input tap 500 800   # 点击详情入口
sleep 3
# 检查是否崩溃
adb shell dumpsys activity activities | grep com.xxx
# 连续跑 10 次
for i in {1..10}; do ...; done
```

**通过标准**：
- 原 Bug 复现率从 100% → 0%
- 日志无 FATAL / ANR / 关键异常
- 复现 10 次无失败

### Step 2 — 回归测试点（必列）

根据修改范围推导可能受影响的功能：

| 修改位置 | 回归点 | 优先级 |
|---------|-------|-------|
| Activity.onCreate | 启动/前后台切换/配置变化 | P0 |
| 数据加载逻辑 | 弱网/断网/慢网 | P1 |
| 生命周期回调 | 横竖屏/分屏/Home 键 | P1 |
| MediaSession | 播放/暂停/跳转/外部控制 | P0 |
| 走行逻辑 | 静止/行驶/高速切换 | P0 |

### Step 3 — 环境覆盖矩阵

| 维度 | 覆盖 |
|------|------|
| 设备 | 至少 2 台不同型号 |
| Android 版本 | 涵盖目标版本范围（A11/A12/A13） |
| 分辨率 | 覆盖 1080p + 1920x720（车机典型） |
| 网络 | 4G / WiFi / 断网 |
| 驾驶状态 | 静止 + 行驶（DRIVE 类必须） |
| 账号 | 新账号 + 老账号（FUNC 类建议） |

### Step 4 — 性能基线对比（如修改涉及性能）

```bash
# 启动耗时
adb shell am start -W -n com.xxx/.MainActivity
# 对比修复前后 TotalTime

# 内存
adb shell dumpsys meminfo com.xxx | grep TOTAL

# 帧率（UI 类）
adb shell dumpsys gfxinfo com.xxx
```

### Step 5 — 冒烟 + 回归清单输出

## 输出模板

```markdown
## 验证计划

### 1. 核心验证（原 Bug）
**复现脚本**:
\`\`\`bash
# 连续 10 次验证
for i in $(seq 1 10); do
    adb shell am force-stop com.xxx
    adb shell am start -n com.xxx/.MainActivity
    sleep 2
    adb shell input tap 500 800
    sleep 3
    if adb logcat -d | grep -q "FATAL EXCEPTION"; then
        echo "Iteration $i: FAILED"
    else
        echo "Iteration $i: PASS"
    fi
    adb logcat -c
done
\`\`\`

**通过标准**: 10 次全部 PASS，无 FATAL

### 2. 回归测试点
- [ ] **P0** 详情页正常打开（含缓存命中/未命中场景）
- [ ] **P0** 从首页点击跳详情 → 返回 → 再跳
- [ ] **P1** 搜索结果跳详情
- [ ] **P1** 弱网下打开详情（Chrome DevTools 限速 Slow 3G）
- [ ] **P1** 横竖屏切换（车机适用时）

### 3. 环境矩阵
| 设备 | Android | 分辨率 | 网络 | 状态 |
|------|---------|-------|------|------|
| 测试机 A | 12 | 1920x1080 | WiFi | 必测 |
| 测试机 B | 11 | 1920x720 | 4G | 必测 |
| 生产车机 | 13 | 定制 | 断网+行驶 | 建议 |

### 4. 性能基线
| 指标 | 修复前 | 修复后目标 |
|------|-------|-----------|
| 启动耗时 | N/A | ≤ 500ms |
| 内存占用 | N/A | 不增加 |

### 5. 通过门禁（Gate G7）
- [ ] 原 Bug 复现率降至 0%
- [ ] 所有 P0 回归点通过
- [ ] 无新增 crash/anr
- [ ] 性能基线不劣化
```

## 注意事项

- **脚本必须可直接执行**，不要写伪代码
- 回归点要**穷举**修改文件的直接调用方（用 grep 搜引用）
- 覆盖矩阵最少 2 设备 × 2 版本
- 对走行类 Bug，**必须包含行驶状态测试**
- 验证通过 = 原 Bug 不复现 + 无新增回归 + 性能不劣化（三个都要）
