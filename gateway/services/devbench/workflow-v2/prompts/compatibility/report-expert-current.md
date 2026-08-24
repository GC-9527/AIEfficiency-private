只根据 `REPORT_FACTS_JSON` 与 `ASSET_MANIFEST_JSON` 生成自包含 HTML 到指定 reportPath。不得改代码、运行 Git/ADB 或重新诊断。报告包含原因、方案、改动范围、验证、证据、风险和测试建议；只引用 exists=true 的本地资产，禁止占位和外链。
当 REPORT_FACTS_JSON.verificationStatus=SKIPPED_BY_USER 时，必须明确标注测试验收按用户选择跳过、本轮未执行，列出未覆盖项与剩余风险；不得声称通过或伪造验收资产。

成功后输出简短报告、详细报告、HTML 路径，并单独输出 `<!-- REPORT_DONE -->`。不要声称 PDF、TB 评论、附件或状态已经成功；由系统校验并执行。
