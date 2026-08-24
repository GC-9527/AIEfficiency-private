/**
 * deck-export.js —— 把 HTML 演示文稿（frontend-slides / html-ppt 等单文件或带 assets 的 deck）
 * 一键导出为 PDF 与 PPTX（满幅图片型，视觉 100% 保真）。
 *
 * 设计：
 *  - 用 puppeteer-core 驱动本机 Edge/Chrome，按 1920×1080 逐页渲染。
 *  - 逐页「激活」(.active/.visible/.is-active)，触发各自入场动画落定后截图——比 @media print 直接打印更稳，
 *    避免 reveal 动画初始态导致内容空白；对不同 deck 家族通用。
 *  - PDF：把逐页图拼成每页一张的 PDF（每页 1920×1080）。
 *  - PPTX：pptxgenjs 16:9，每页一张满幅图片（文字不可编辑，但保真）。
 *  - 中文路径在 headless 下有坑：先把 deck 复制到 ASCII 临时目录渲染，产物再落到目标(可中文)目录。
 *
 * 用法：import { exportDeck } from "./deck-export.js"; await exportDeck(htmlPath, { outDir, basename, pdf, pptx });
 */
import puppeteer from "puppeteer-core";
import pptxgen from "pptxgenjs";
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync, renameSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";

// 复制 deck 同级目录时跳过的大目录 / 产物（保留 assets 等相对资源）
const SKIP_DIRS = new Set(["slides", "_imgs", "_build", "reports", "archives", "node_modules", ".git", ".gradle", "build", "dist", ".cache"]);
const SKIP_EXTS = new Set([".pdf", ".pptx", ".mp4", ".mov", ".zip", ".7z"]);

// 定位渲染用浏览器：优先环境变量，其次 Edge / Chrome 常见安装位置
export function findBrowser() {
  const env = process.env.DECK_EXPORT_BROWSER;
  if (env && existsSync(env)) return env;
  const plat = process.platform;
  let cands = [];
  if (plat === "win32") {
    cands = [
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ];
  } else if (plat === "darwin") {
    cands = [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  } else {
    cands = ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  }
  for (const p of cands) if (existsSync(p)) return p;
  return null;
}

function cpDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src)) {
    if (SKIP_DIRS.has(ent)) continue;
    const sp = path.join(src, ent);
    let st; try { st = statSync(sp); } catch { continue; }
    if (st.isDirectory()) cpDir(sp, path.join(dst, ent));
    else copyFileSync(sp, path.join(dst, ent));
  }
}

// 把 deck（html + 同级 assets 等相对资源）复制到 ASCII 临时目录，规避中文路径 headless 问题
function copyDeckToTemp(htmlPath) {
  const srcDir = path.dirname(htmlPath);
  const base = path.basename(htmlPath);
  const tmp = path.join(os.tmpdir(), "deck-export-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36));
  mkdirSync(tmp, { recursive: true });
  for (const ent of readdirSync(srcDir)) {
    if (SKIP_DIRS.has(ent)) continue;
    const sp = path.join(srcDir, ent);
    let st; try { st = statSync(sp); } catch { continue; }
    if (st.isDirectory()) {
      cpDir(sp, path.join(tmp, ent));
    } else {
      // 跳过同级的旧产物（pdf/pptx/视频…），但保留 deck 本体
      if (ent !== base && SKIP_EXTS.has(path.extname(ent).toLowerCase())) continue;
      copyFileSync(sp, path.join(tmp, ent));
    }
  }
  return { tmp, htmlFile: path.join(tmp, base) };
}

/**
 * 导出一个 HTML deck 为 PDF / PPTX。
 * @param {string} htmlPath 绝对路径，指向 deck 的 index/主 HTML
 * @param {object} opts
 *   - outDir   产物目录（默认 deck 同级目录）
 *   - basename 产物文件名（不含扩展名，默认 deck 文件名）
 *   - pdf      是否出 PDF（默认 true）
 *   - pptx     是否出 PPTX（默认 true）
 *   - keepImages 是否把逐页图保留到 outDir/slides（默认 false）
 *   - scale/quality/frameDelay 渲染参数
 *   - onProgress(phase, cur, total) 可选进度回调
 * @returns {Promise<{ok, slides, pdf, pptx, images}>}
 */
export async function exportDeck(htmlPath, opts = {}) {
  if (!htmlPath || !existsSync(htmlPath)) throw new Error("HTML 不存在: " + htmlPath);
  const browser = findBrowser();
  if (!browser) throw new Error("未找到 Edge/Chrome，无法渲染。可设环境变量 DECK_EXPORT_BROWSER 指向 msedge.exe / chrome.exe");

  const outDir = opts.outDir || path.dirname(htmlPath);
  const basename = opts.basename || path.basename(htmlPath, path.extname(htmlPath));
  const wantPdf = opts.pdf !== false;
  const wantPptx = opts.pptx !== false;
  const progress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  mkdirSync(outDir, { recursive: true });

  const { tmp, htmlFile } = copyDeckToTemp(htmlPath);
  const imgDir = path.join(tmp, "_imgs");
  mkdirSync(imgDir, { recursive: true });
  const result = { ok: true, slides: 0, pdf: null, pptx: null, images: [] };
  const images = [];

  const br = await puppeteer.launch({
    executablePath: browser,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none", "--window-size=1920,1080"],
  });
  try {
    const page = await br.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: opts.scale || 2 });
    await page.goto("file:///" + htmlFile.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 60000 });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
    await new Promise((r) => setTimeout(r, 800)); // 字体/首屏稳定

    // 真实幻灯片数（排除 overview 缩略图克隆）
    const n = await page.evaluate(() =>
      [...document.querySelectorAll(".slide")].filter((s) => !s.closest(".overview") && !s.closest(".thumbnails") && !s.closest(".thumbs")).length
    );
    if (!n) throw new Error("未找到 .slide 幻灯片元素（该 HTML 可能不是受支持的 deck）");
    result.slides = n;

    for (let k = 0; k < n; k++) {
      progress("render", k + 1, n);
      await page.evaluate((k) => {
        const all = [...document.querySelectorAll(".slide")].filter((s) => !s.closest(".overview") && !s.closest(".thumbnails") && !s.closest(".thumbs"));
        all.forEach((s, i) => {
          const on = i === k;
          s.classList.toggle("active", on);
          s.classList.toggle("visible", on);
          s.classList.toggle("is-active", on);
          s.style.visibility = on ? "visible" : "hidden";
          s.style.opacity = on ? "1" : "0";
          if (on) s.style.transform = "none";
        });
        // 容器去缩放，保证 1:1 截图
        document.querySelectorAll(".deck-stage,.deck").forEach((d) => { d.style.transform = "none"; });
        window.scrollTo(0, 0);
      }, k);
      await new Promise((r) => setTimeout(r, opts.frameDelay || 650)); // 等入场动画落定
      const imgPath = path.join(imgDir, `slide-${String(k + 1).padStart(2, "0")}.jpg`);
      await page.screenshot({ path: imgPath, type: "jpeg", quality: opts.quality || 88, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
      images.push(imgPath);
    }
    result.images = images.slice();

    // PDF：逐页图拼成每页一张
    if (wantPdf) {
      progress("pdf", 0, 1);
      // 用 base64 data URI 内联图片：setContent 页面用 file:// 引用本地图不会加载（origin 限制），内联才可靠
      const imgsHtml = images
        .map((p) => `<img src="data:image/jpeg;base64,${readFileSync(p).toString("base64")}">`)
        .join("\n");
      const wrap = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:1920px 1080px;margin:0}*{margin:0;padding:0}img{display:block;width:1920px;height:1080px;page-break-after:always;break-after:page}img:last-child{page-break-after:auto}</style></head><body>${imgsHtml}</body></html>`;
      const p2 = await br.newPage();
      await p2.setViewport({ width: 1920, height: 1080 });
      await p2.setContent(wrap, { waitUntil: "networkidle0" });
      const pdfPath = path.join(outDir, basename + ".pdf");
      await p2.pdf({ path: pdfPath, width: "1920px", height: "1080px", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, pageRanges: `1-${n}` });
      result.pdf = pdfPath;
    }
  } finally {
    await br.close();
  }

  // PPTX：pptxgenjs 16:9，每页一张满幅图片
  if (wantPptx) {
    progress("pptx", 0, 1);
    const pptx = new pptxgen();
    pptx.defineLayout({ name: "16x9", width: 13.333, height: 7.5 });
    pptx.layout = "16x9";
    for (const img of images) {
      const s = pptx.addSlide();
      s.addImage({ path: img, x: 0, y: 0, w: 13.333, h: 7.5 });
    }
    const pptxPath = path.join(outDir, basename + ".pptx");
    try {
      await pptx.writeFile({ fileName: pptxPath });
      result.pptx = pptxPath;
    } catch (e) {
      // 中文路径写入异常兜底：先写 ASCII 临时再移动
      const tmpPptx = path.join(tmp, "out.pptx");
      await pptx.writeFile({ fileName: tmpPptx });
      renameSync(tmpPptx, pptxPath);
      result.pptx = pptxPath;
    }
  }

  // 可选保留逐页图
  if (opts.keepImages && images.length) {
    const dst = path.join(outDir, "slides");
    mkdirSync(dst, { recursive: true });
    for (const img of images) copyFileSync(img, path.join(dst, path.basename(img)));
    result.imagesDir = dst;
  }

  // 清理临时目录
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  return result;
}

// ========== 命令行直跑 ==========
// node gateway/services/deck-export.js <deck.html> [outDir] [--no-pdf] [--no-pptx] [--keep-images]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = argv.filter((a) => !a.startsWith("--"));
  if (!pos[0]) {
    console.error("用法: node gateway/services/deck-export.js <deck.html> [outDir] [--no-pdf] [--no-pptx] [--keep-images]");
    process.exit(1);
  }
  exportDeck(path.resolve(pos[0]), {
    outDir: pos[1] ? path.resolve(pos[1]) : undefined,
    pdf: !flags.has("--no-pdf"),
    pptx: !flags.has("--no-pptx"),
    keepImages: flags.has("--keep-images"),
    onProgress: (phase, cur, total) => {
      if (phase === "render") process.stdout.write(`\r渲染幻灯片 ${cur}/${total}   `);
      else if (phase === "pdf") process.stdout.write("\n合成 PDF…\n");
      else if (phase === "pptx") process.stdout.write("生成 PPTX…\n");
    },
  })
    .then((r) => {
      console.log("\n完成： 幻灯片", r.slides, "页");
      if (r.pdf) console.log("  PDF :", r.pdf);
      if (r.pptx) console.log("  PPTX:", r.pptx);
      if (r.imagesDir) console.log("  图片:", r.imagesDir);
    })
    .catch((e) => { console.error("\n导出失败:", e.message); process.exit(1); });
}
