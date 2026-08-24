---
name: pptx-skill
description: 生成/编辑「真正可在 PowerPoint 中打开和编辑」的 .pptx 演示文稿（OOXML），底层用 PptxGenJS 引擎 + html2pptx + 渲染校验。支持从零创建、基于模板、读取、编辑四种工作流，能把 HTML 幻灯片转成像素级保真的可编辑 PPTX。触发词：PPTX、PowerPoint、可编辑 PPT、导出 pptx、HTML 转 PPTX、html2pptx、PptxGenJS、客户要 PPT 源文件、Keynote/Google Slides 可导入。底层调用 Claude Code 全局技能 pptx（Anthropic 官方）。
---

你是 PPTX（PowerPoint）生成与编辑专家。当用户需要的不是网页/PDF、而是**能在 PowerPoint / Keynote / Google Slides 里打开并继续编辑**的 `.pptx` 源文件时，使用本技能。底层直接调用 Claude CLI 全局技能 **`pptx`**（Anthropic 官方 Document Skill，内置 **PptxGenJS** 引擎与 `html2pptx`、渲染/校验工具）。

## 触发场景

- "给我一份可编辑的 PPTX / PowerPoint 源文件"（领导/客户要能自己改）
- "把这份 HTML 幻灯片 / 网页 PPT 转成 .pptx"（html2pptx）
- "基于这个 PPTX 模板填充内容 / 修改某几页"
- "读取这个 .pptx 的内容 / 提取文字结构"
- devbench 场景：把对外汇报的演示交付成**可编辑 PPTX**，而非只给 HTML/PDF。

## 怎么做

本工具运行的 Claude CLI 已内置全局 **`pptx`** 技能，**直接使用它**，不要手写 OOXML：

1. 判断工作流（技能 SKILL.md 四选一）：
   - **从零创建** → 读 `pptxgenjs.md`，用 PptxGenJS 写脚本生成（需要 `npm install -g pptxgenjs`，本机已全局安装 `pptxgenjs@4.0.1`）。
   - **HTML → PPTX** → 用技能的 `html2pptx` 能力，把 [[frontend-slides-skill]] / [[html-ppt-skill]] 产出的 HTML deck 转成可编辑 pptx（保留圆角盒、渐变、字体）。
   - **基于模板** → 在已有 .pptx 模板上填充/替换。
   - **读取/编辑** → 解析或局部修改已有 .pptx（见 `editing.md`）。
2. 生成后用技能自带的**渲染/校验**步骤检查版式（自动捕捉布局溢出等问题），不合格再调整。
3. 产出 `.pptx` 交付到用户指定位置或工程 `docs/` 下，告知用 PowerPoint/Keynote/Google Slides 打开。

## 与其他技能的关系（交付链路）

```
frontend-slides / html-ppt  →  设计 HTML 幻灯片
            ↓
        pptx 技能（html2pptx + PptxGenJS）
            ↓
        可编辑 .pptx（PowerPoint 源文件）
```

- 只要「好看的演示 + PDF/存档」→ 用 [[frontend-slides-skill]] 或 [[html-ppt-skill]]。
- 终点必须是 **PowerPoint 可编辑源文件** → 走本技能。LLM 生成 HTML 的质量明显高于直接生成 PPTX，所以推荐 **先 HTML、再 html2pptx 转 PPTX**。

## 约束

- 设计/排版尽量在 HTML 阶段定稿，本技能负责**忠实转换 + 可编辑性**，不在 pptx 层重做设计。
- 字体/配色以源 HTML 为准；转换后核对版式不跑版。
- 临时产物放工程 `docs/tempFiles/`；最终 `.pptx` 交付到用户指定位置或工程 `docs/` 下。
