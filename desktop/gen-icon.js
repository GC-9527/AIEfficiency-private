/**
 * 生成 AI 图标：深蓝渐变圆角背景 + 白色 "AI" 字样 + 电路纹理点缀
 */
const sharp = require("sharp");
const toIco = require("to-ico");
const fs = require("fs");
const path = require("path");

const SIZE = 512;
const ICON_DIR = path.join(__dirname, "icons");

// SVG 图标设计
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <!-- 主渐变：深蓝到紫蓝 -->
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1e3a5f"/>
      <stop offset="50%" style="stop-color:#2563eb"/>
      <stop offset="100%" style="stop-color:#7c3aed"/>
    </linearGradient>
    <!-- 光泽叠加 -->
    <radialGradient id="shine" cx="35%" cy="30%" r="60%">
      <stop offset="0%" style="stop-color:rgba(255,255,255,0.15)"/>
      <stop offset="100%" style="stop-color:rgba(255,255,255,0)"/>
    </radialGradient>
    <!-- 文字光效 -->
    <filter id="glow">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- 圆角背景 -->
  <rect width="${SIZE}" height="${SIZE}" rx="96" ry="96" fill="url(#bg)"/>
  <rect width="${SIZE}" height="${SIZE}" rx="96" ry="96" fill="url(#shine)"/>

  <!-- 电路装饰线 -->
  <g stroke="rgba(255,255,255,0.08)" stroke-width="2" fill="none">
    <path d="M80,140 L80,80 L140,80"/>
    <path d="M432,140 L432,80 L372,80"/>
    <path d="M80,372 L80,432 L140,432"/>
    <path d="M432,372 L432,432 L372,432"/>
    <circle cx="80" cy="140" r="4" fill="rgba(255,255,255,0.12)"/>
    <circle cx="432" cy="140" r="4" fill="rgba(255,255,255,0.12)"/>
    <circle cx="80" cy="372" r="4" fill="rgba(255,255,255,0.12)"/>
    <circle cx="432" cy="372" r="4" fill="rgba(255,255,255,0.12)"/>
    <!-- 中间装饰 -->
    <path d="M160,420 L256,420 L256,460"/>
    <circle cx="256" cy="466" r="4" fill="rgba(255,255,255,0.1)"/>
    <path d="M352,420 L256,420"/>
  </g>

  <!-- AI 文字 - 粗体白色 -->
  <text x="256" y="310" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="240" fill="white" filter="url(#glow)" letter-spacing="-8">
    AI
  </text>

  <!-- 底部小标识点 -->
  <circle cx="256" cy="56" r="6" fill="rgba(96,165,250,0.6)"/>
  <circle cx="236" cy="56" r="3" fill="rgba(96,165,250,0.3)"/>
  <circle cx="276" cy="56" r="3" fill="rgba(96,165,250,0.3)"/>
</svg>
`;

async function generate() {
  if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

  // 生成多尺寸 PNG
  const sizes = [512, 256, 128, 64, 48, 32, 16];
  const pngPaths = [];

  for (const size of sizes) {
    const outPath = path.join(ICON_DIR, `icon-${size}.png`);
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
    pngPaths.push(outPath);
    console.log(`  PNG ${size}x${size} -> ${outPath}`);
  }

  // 主 icon.png（256）
  fs.copyFileSync(path.join(ICON_DIR, "icon-256.png"), path.join(ICON_DIR, "icon.png"));

  // 生成 ICO（含多尺寸）
  const icoSizes = [256, 128, 64, 48, 32, 16];
  const icoBuffers = icoSizes.map(s => fs.readFileSync(path.join(ICON_DIR, `icon-${s}.png`)));
  const ico = await toIco(icoBuffers);
  fs.writeFileSync(path.join(ICON_DIR, "icon.ico"), ico);
  console.log("  ICO -> icons/icon.ico");

  console.log("图标生成完成!");
}

generate().catch(console.error);
