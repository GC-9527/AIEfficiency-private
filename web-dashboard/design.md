# AIEfficiency Workbench Design System

## 方向

这套界面借鉴现代 AI 工作台的克制、留白和任务聚焦方式，但不复刻任何产品。AIEfficiency 保留自己的工程属性：设备上下文始终可见，日志和设备编号使用等宽字体，颜色只表达操作优先级和运行状态。

- 风格：modern-minimal，温灰纸面、白色工作画布、低饱和蓝色操作色。
- 宏观结构：可折叠工具侧栏 + 单一任务工作区 + 局部悬浮工具坞。
- 品牌特征：`AE` 文字标记、设备上下文条、工程化状态反馈。
- 禁止：装饰性渐变、无意义大标题、过量圆角卡片、以颜色作为唯一状态信号。

## 设计令牌

运行时唯一事实源为 [`tokens.css`](./tokens.css)。亮色为默认主题；任何容器设置 `data-theme="dark"` 即可复用暗色令牌。页面和组件只引用语义令牌，不直接绑定品牌色值。

核心角色：

| 角色 | 用途 |
| --- | --- |
| `paper / canvas` | 应用底色与工作画布 |
| `ink / neutral / muted` | 主文本、次文本、弱提示 |
| `rule / rule-2` | 分隔与表单边界 |
| `accent / accent-ink / focus` | 关键操作、填充文字、键盘焦点 |
| `status-*` | 成功、警告、错误，不单独承担语义 |
| `z-*` | sticky、dock、dropdown、modal、toast 的固定层级 |

## 组件规范

- 侧栏：手机固定 56px；640px 以上允许在 56px 与 180px 间切换。收起后保留图标和可访问名称。
- 标签栏：单行、可横向滚动；方向键切换，激活项同时使用底色、边框与文字权重。
- 按钮和输入：基础高度 44px；边框宽度在所有状态保持 1px；键盘焦点使用 2px 外轮廓。
- 卡片：仅用于把一组任务与下一组任务分开；表格在卡片内部横向滚动，页面根节点不产生横向滚动。
- 状态：成功使用 `role=status`，错误使用 `role=alert`；日志使用等宽字体并允许长字符串断行。
- 工具坞：桌面显示，可收起、隐藏；固定使用 `--z-dock`，不得遮住手机主操作。

## 响应式与动效

- 基础样式面向 320px；离散布局断点为 40rem、60rem。
- 必验宽度：320、375、414、768、1440 CSS px。
- `html` 与 `body` 使用 `overflow-x: clip`；不使用 `100vw`。
- hover 仅在精细指针设备启用；粗指针目标不小于 48px。
- 动画仅改变颜色、透明度或 transform；系统要求减少动效时近似关闭全部动画。

## Exports

### 1. CSS source of truth

```css
@import "../tokens.css";
/* 完整值见 tokens.css；这是实际运行时入口。 */
```

### 2. Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(97.8% 0.006 85);
  --color-canvas: oklch(99.5% 0.003 85);
  --color-ink: oklch(20% 0.014 264);
  --color-muted: oklch(49% 0.012 264);
  --color-rule: oklch(89% 0.009 264);
  --color-accent: oklch(49% 0.17 255);
  --color-focus: oklch(17% 0.05 255);
  --font-display: "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif;
  --font-body: "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif;
  --font-outlier: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  --spacing-3xs: 0.25rem;
  --spacing-2xs: 0.5rem;
  --spacing-xs: 0.75rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  --spacing-lg: 2rem;
  --radius-card: 0.875rem;
  --radius-pill: 999px;
  --radius-input: 0.625rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### 3. DTCG `tokens.json`

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(97.8% 0.006 85)", "$type": "color" },
    "canvas": { "$value": "oklch(99.5% 0.003 85)", "$type": "color" },
    "ink": { "$value": "oklch(20% 0.014 264)", "$type": "color" },
    "muted": { "$value": "oklch(49% 0.012 264)", "$type": "color" },
    "rule": { "$value": "oklch(89% 0.009 264)", "$type": "color" },
    "accent": { "$value": "oklch(49% 0.17 255)", "$type": "color" },
    "focus": { "$value": "oklch(17% 0.05 255)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Microsoft YaHei UI, PingFang SC, Noto Sans SC, sans-serif", "$type": "fontFamily" },
    "body": { "$value": "Microsoft YaHei UI, PingFang SC, Noto Sans SC, sans-serif", "$type": "fontFamily" },
    "outlier": { "$value": "Cascadia Code, JetBrains Mono, Consolas, monospace", "$type": "fontFamily" }
  },
  "space": {
    "3xs": { "$value": "0.25rem", "$type": "dimension" },
    "2xs": { "$value": "0.5rem", "$type": "dimension" },
    "xs": { "$value": "0.75rem", "$type": "dimension" },
    "sm": { "$value": "1rem", "$type": "dimension" },
    "md": { "$value": "1.5rem", "$type": "dimension" },
    "lg": { "$value": "2rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "120ms", "$type": "duration" },
    "short": { "$value": "220ms", "$type": "duration" },
    "long": { "$value": "420ms", "$type": "duration" }
  }
}
```

### 4. shadcn/ui variables

```css
:root {
  --background: 97.8% 0.006 85;
  --foreground: 20% 0.014 264;
  --card: 99.5% 0.003 85;
  --card-foreground: 20% 0.014 264;
  --popover: 99.5% 0.003 85;
  --popover-foreground: 20% 0.014 264;
  --primary: 49% 0.17 255;
  --primary-foreground: 99% 0.002 255;
  --secondary: 95.8% 0.008 85;
  --secondary-foreground: 31% 0.014 264;
  --muted: 89% 0.009 264;
  --muted-foreground: 49% 0.012 264;
  --accent: 49% 0.17 255;
  --accent-foreground: 99% 0.002 255;
  --destructive: 48% 0.18 25;
  --destructive-foreground: 99% 0.002 255;
  --border: 89% 0.009 264;
  --input: 77% 0.012 264;
  --ring: 17% 0.05 255;
  --radius: 0.875rem;
}
```
