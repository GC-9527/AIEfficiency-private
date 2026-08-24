---
name: efficient-ui-operation
description: 本工程进行网页、桌面、Android/iOS、模拟器操作，或准备截图、视觉定位、坐标点击时触发。读取工程策略和操作地图，优先结构化入口，所有视觉工具经过门禁，超预算或无进展时人工接管。纯代码编辑不触发。
---

# 本工程高效 UI 操作

1. 读取 `.ai/visual-operation-guard/policy.json` 和 `.ai/operation-map.json`。
2. 明确目标状态、成功标准、核心 UI 交互和任务模式。
3. 按 MCP/API → CLI/ADB/配置 → 路由/Deep Link → DOM/Accessibility → 视觉的顺序选择。
4. 第一次截图前完成 structured preflight。
5. screenshot、坐标点击和视觉输入必须取得 Guard authorizationId。
6. 每次执行后回报 progress、fingerprint、checkpoint 和 usage（若有）。
7. 预算、无进展或安全场景触发时生成 NEEDS_USER_ACTION；无人值守则 BLOCKED_NEEDS_HUMAN 并释放锁。
8. 测试采用 Arrange/Act/Assert，不能绕过本次真正需要验收的核心 UI 行为。
9. 新验证成功入口回写 operation-map；不要记录账号、Token、Cookie、证书或私钥。
