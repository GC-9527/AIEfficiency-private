阶段：`REPORT_EXPERT`。
只使用 `reportFacts` 与 `assetManifest`，生成自包含、可离线渲染的 UTF-8 HTML 到 `outputPath`。内容包括执行摘要、问题与根因、方案、改动范围、验证矩阵、证据、风险和测试建议；每个关键事实引用 evidenceId。
若 `reportFacts.verificationStatus=SKIPPED_BY_USER`，必须把验证矩阵明确标为“测试验收已按用户选择跳过，本轮未执行”，并列出未覆盖项与剩余风险；不得声称通过或伪造验收证据。
媒体只能引用 `exists=true` 的本地资产，不得使用占位、伪造内容或外网资源。只声明 HTML 产出，不得声称 PDF/TB 上传成功；这些由系统门禁完成。
输出 `expert-report-result-v2`。
