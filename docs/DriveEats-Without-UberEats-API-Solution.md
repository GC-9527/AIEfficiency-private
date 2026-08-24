# DriveEats：WebView + AI 驱动的无 API 点单方案（详细实现）

> **版本**：v2.1（云端 AI 专属版）
> **更新日期**：2026-04-21
> **核心思路**：车机内嵌 WebView 加载 UberEats PWA，用户授权登录后通过云端 AI 动态分析页面并注入 JS 完成点单
> **AI 策略**：**本地不部署 LLM**，统一使用云端 Claude（主）+ GPT-4o（备）
> **关联文档**：[DriveEats-Voice-Ordering-Solution.md](./DriveEats-Voice-Ordering-Solution.md)

---

## 目录

- [一、方案总览](#一方案总览)
- [二、完整系统架构](#二完整系统架构)
- [三、模块 1：会话管理（登录与持久化）](#三模块-1会话管理登录与持久化)
- [四、模块 2：隐藏 WebView 容器](#四模块-2隐藏-webview-容器)
- [五、模块 3：页面状态采集器](#五模块-3页面状态采集器)
- [六、模块 4：AI 决策引擎（纯云端）](#六模块-4ai-决策引擎)
  - [6.5 云端 LLM Gateway](#65-云端-llm-gateway-backend-代理层)
  - [6.6 LLM 模型选型](#66-llm-模型选型)
  - [6.7 成本估算](#67-成本估算)
- [七、模块 5：JS 注入执行器](#七模块-5js-注入执行器)
- [八、模块 6：订单状态机](#八模块-6订单状态机)
- [九、模块 7：双向 JSBridge](#九模块-7双向-jsbridge)
- [十、模块 8：安全守卫](#十模块-8安全守卫)
- [十一、模块 9：反检测与拟人化](#十一模块-9反检测与拟人化)
- [十二、模块 10：变化检测与重分析](#十二模块-10变化检测与重分析)
- [十三、完整下单时序](#十三完整下单时序)
- [十四、错误恢复与降级](#十四错误恢复与降级)
- [十五、性能优化](#十五性能优化)
- [十六、测试策略](#十六测试策略)
- [十七、开发路线图](#十七开发路线图)

---

## 一、方案总览

### 1.1 核心思路

```
用户语音 → 小艺识别 → LLM 提取订单意图
         ↓
隐藏 WebView 加载 UberEats PWA (已登录)
         ↓
循环: [采集页面] → [AI 分析] → [生成 JS] → [注入执行] → [验证结果]
         ↓
支付前必须：语音确认 + 生物识别
         ↓
下单成功 → 导航自动添加取餐点
```

### 1.2 设计原则

| 原则 | 实现 |
|---|---|
| 用户主导 | 账户为用户自己的，车机仅代操作 |
| 显式确认 | 支付前强制语音 + 生物识别双确认 |
| 可恢复 | 每步可回溯；中断可续跑 |
| 自适应 | AI 应对 UI 改版；模板库+视觉兜底 |
| 合规 | 模拟真实节奏；不绕过反爬 |

### 1.3 合规红线

- ✅ 用户主动 OAuth 登录自己的账户
- ✅ 凭据使用 AndroidKeyStore 加密，车机本地存储
- ✅ 每次支付必须有用户显式确认
- ✅ 模拟真实用户操作节奏（随机延迟 300-1200ms）
- ❌ 不绕过 SSL Pinning、不逆向签名算法
- ❌ 不未经告知自动重复下单
- ❌ 不共享账户或跨设备迁移凭据

---

## 二、完整系统架构

### 2.1 分层架构

```
┌────────────────────────────────────────────────────────────────┐
│  L0 输入层                                                       │
│   华为小艺 Skill (voice) / 车机触屏 / 预设快捷指令                 │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│  L1 意图层                                                       │
│   IntentExtractor: 小艺 NLU + LLM Function Calling               │
│   输出: OrderTask(restaurant, items[], delivery, destination)    │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│  L2 编排层                                                       │
│   OrderOrchestrator (核心协调器)                                  │
│    - 订单状态机 OrderStateMachine                                 │
│    - 错误恢复 RecoveryManager                                     │
│    - 安全守卫 SafetyGuard                                         │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│  L3 决策层 (全部云端)                                             │
│   AIDecisionEngine                                              │
│    - 模板库 TemplateMatcher (命中率 80%+ 的常见页面，零 LLM 调用)  │
│    - 云端 LLM Planner (Claude Sonnet 主 + GPT-4o 备)             │
│    - 云端 VLM 视觉分析器 (Claude Sonnet 多模态)                    │
│    - LLM Gateway: 统一鉴权/限流/降级/Prompt 缓存                   │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│  L4 执行层                                                       │
│   WebViewExecutor                                               │
│    - SessionManager: Cookie/Token 管理                           │
│    - Snapshotter: DOM+截图+URL 采集                               │
│    - JSInjector: 注入 + 结果验证                                  │
│    - Humanizer: 拟人化操作节奏                                    │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│  L5 容器层                                                       │
│   Android WebView (Chromium) — 渲染 UberEats PWA                │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 时序图

```
User      Voice    Agent     AI       WebView   UberEats
 │         │         │        │          │         │
 │─"点KFC"→│         │        │          │         │
 │         │──意图──→│        │          │         │
 │         │         │─prompt→│          │         │
 │         │         │←task───│          │          │
 │         │         │──────load──────→ │──GET────→│
 │         │         │                   │←HTML────│
 │         │         │←─onPageFinished─ │         │
 │         │         │─snapshot────────→│         │
 │         │         │←DOM+截图─────────│         │
 │         │         │─analyze─→│       │         │
 │         │         │←JS代码───│       │         │
 │         │         │─inject JS───────→│         │
 │         │         │                   │─搜索──→│
 │         │         │←页面变化通知──────│←结果───│
 │         │         │ (循环多轮 AI 决策)          │
 │         │         │─到达结算页─(通知 NativeBridge)
 │         │←确认──  │                             │
 │←"32元确认？"      │                             │
 │─"确认"→│         │                             │
 │         │──生物识别──→│                         │
 │         │         │─inject click submit────→│─下单→│
 │         │         │←订单ID─────────────────────│
 │         │─TTS成功→│                             │
 │←"下单成功"         │                             │
```

---

## 三、模块 1：会话管理（登录与持久化）

### 3.1 职责

- 首次引导用户登录 UberEats
- 安全存储 Cookie / LocalStorage / Token
- 登录态过期检测与自动引导重登
- 多账户切换（预留）

### 3.2 实现

```kotlin
class UberEatsSessionManager(
    private val context: Context,
    private val cryptoBox: AndroidKeyStoreCrypto
) {
    companion object {
        private const val DOMAIN = "https://www.ubereats.com"
        private const val KEY_COOKIES = "ubereats_cookies_v1"
        private const val KEY_LOCAL_STORAGE = "ubereats_localstorage_v1"
        private const val KEY_EXPIRE_AT = "ubereats_expire_at"
    }

    private val prefs = context.getSharedPreferences("driveeats_secure", MODE_PRIVATE)

    // ========== 1. 引导登录 ==========
    fun launchLoginFlow(onSuccess: () -> Unit, onCancel: () -> Unit) {
        val intent = Intent(context, UberEatsLoginActivity::class.java).apply {
            putExtra("callback_class", callbackClass)
        }
        context.startActivity(intent)
    }

    // ========== 2. 保存登录态 ==========
    suspend fun saveSession(webView: WebView) {
        // Cookie
        val cookies = CookieManager.getInstance().getCookie(DOMAIN) ?: ""
        prefs.edit().putString(KEY_COOKIES, cryptoBox.encrypt(cookies)).apply()

        // LocalStorage
        val ls = webView.evaluateJsSuspending("""
            (function() {
                var data = {};
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    data[k] = localStorage.getItem(k);
                }
                return JSON.stringify(data);
            })();
        """)
        prefs.edit().putString(KEY_LOCAL_STORAGE, cryptoBox.encrypt(ls)).apply()

        // Token 过期时间（解析 JWT 或默认 7 天）
        val expireAt = parseTokenExpiry(ls) ?: (System.currentTimeMillis() + 7 * 24 * 3600_000)
        prefs.edit().putLong(KEY_EXPIRE_AT, expireAt).apply()
    }

    // ========== 3. 恢复登录态 ==========
    suspend fun restoreSession(webView: WebView): Boolean {
        if (!isSessionValid()) return false

        val cookieEnc = prefs.getString(KEY_COOKIES, null) ?: return false
        val cookies = cryptoBox.decrypt(cookieEnc)
        cookies.split("; ").forEach { cookie ->
            CookieManager.getInstance().setCookie(DOMAIN, cookie)
        }
        CookieManager.getInstance().flush()

        // LocalStorage 需在页面加载后注入
        return true
    }

    suspend fun injectLocalStorage(webView: WebView) {
        val lsEnc = prefs.getString(KEY_LOCAL_STORAGE, null) ?: return
        val ls = cryptoBox.decrypt(lsEnc)
        val js = """
            (function() {
                var data = $ls;
                Object.keys(data).forEach(function(k) {
                    localStorage.setItem(k, data[k]);
                });
            })();
        """
        webView.evaluateJsSuspending(js)
    }

    // ========== 4. 校验登录态 ==========
    fun isSessionValid(): Boolean {
        val expireAt = prefs.getLong(KEY_EXPIRE_AT, 0)
        return System.currentTimeMillis() < expireAt - 3600_000  // 提前 1 小时视为过期
    }

    suspend fun validateWithServer(webView: WebView): Boolean {
        val result = webView.evaluateJsSuspending("""
            (function() {
                return fetch('$DOMAIN/api/getEaterMe', {
                    credentials: 'include'
                }).then(r => r.status === 200).catch(e => false);
            })();
        """)
        return result == "true"
    }

    // ========== 5. 清除登录态（用户退出 / 风控）==========
    fun clearSession() {
        prefs.edit().clear().apply()
        CookieManager.getInstance().removeAllCookies(null)
    }
}
```

### 3.3 登录 Activity

```kotlin
class UberEatsLoginActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var sessionManager: UberEatsSessionManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)

        webView = findViewById(R.id.login_webview)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            userAgentString = generateRealisticUA()
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                checkLoginSuccess(url)
            }
        }

        webView.loadUrl("https://www.ubereats.com/login")
    }

    private fun checkLoginSuccess(url: String) {
        webView.evaluateJavascript("""
            (function() {
                // UberEats 登录成功后通常跳转到首页或 /restaurant
                if (location.pathname === '/' || location.pathname.startsWith('/feed')) {
                    // 验证有用户信息
                    return document.cookie.includes('sid=') ||
                           localStorage.getItem('uev2.access_token') !== null;
                }
                return false;
            })();
        """) { result ->
            if (result == "true") {
                lifecycleScope.launch {
                    sessionManager.saveSession(webView)
                    setResult(RESULT_OK)
                    finish()
                }
            }
        }
    }
}
```

---

## 四、模块 2：隐藏 WebView 容器

### 4.1 设计目标

- WebView 不对用户可见（尺寸 1080x1920 但 alpha=0 或离屏）
- 保持完整渲染能力（触发 JS 执行、Layout 计算）
- 支持长期运行不被 GC
- 内存受控（单实例复用）

### 4.2 实现

```kotlin
class HeadlessWebViewContainer(
    private val context: Context,
    private val sessionManager: UberEatsSessionManager
) {
    private var webView: WebView? = null
    private val mutex = Mutex()
    private var lastUsedAt = 0L
    private val KEEP_ALIVE_MS = 15 * 60_000L  // 15 分钟无操作后销毁

    suspend fun acquire(): WebView = mutex.withLock {
        if (webView == null || !isHealthy()) {
            webView?.destroy()
            webView = createWebView()
        }
        lastUsedAt = System.currentTimeMillis()
        webView!!
    }

    private fun createWebView(): WebView {
        return WebView(context).apply {
            // 尺寸保证布局正确但不可见
            layoutParams = ViewGroup.LayoutParams(1080, 1920)

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                userAgentString = generateRealisticUA()
                // 模拟真实移动浏览器
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
            }

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            // 附加到不可见的 WindowManager
            attachToOffscreenWindow(this)

            // 加载 JSBridge
            addJavascriptInterface(JSBridgeImpl(), "DriveEats")

            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView, progress: Int) {
                    progressFlow.value = progress
                }
            }
        }
    }

    private fun attachToOffscreenWindow(webView: WebView) {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val params = WindowManager.LayoutParams().apply {
            width = 1080
            height = 1920
            type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
            format = PixelFormat.TRANSLUCENT
            // 放到屏幕外
            x = -2000
            y = -2000
            alpha = 0f
        }
        try {
            wm.addView(webView, params)
        } catch (e: Exception) {
            // 车机可能不允许 overlay，退回 Activity 容器
            logger.warn("Overlay not allowed, fallback to Activity", e)
        }
    }

    private fun isHealthy(): Boolean {
        val wv = webView ?: return false
        return try {
            wv.url != null && !wv.isDestroyed
        } catch (e: Exception) { false }
    }

    // 空闲自动回收
    private val cleanupJob = CoroutineScope(Dispatchers.Main).launch {
        while (isActive) {
            delay(60_000)
            if (System.currentTimeMillis() - lastUsedAt > KEEP_ALIVE_MS) {
                mutex.withLock {
                    webView?.destroy()
                    webView = null
                }
            }
        }
    }

    fun release() {
        cleanupJob.cancel()
        webView?.destroy()
        webView = null
    }
}
```

---

## 五、模块 3：页面状态采集器

### 5.1 职责

采集足够 AI 判断的页面上下文，同时控制数据量（LLM token 成本）。

### 5.2 采集内容

| 数据 | 用途 | 数据量 |
|---|---|---|
| URL + Title | 快速判断页面类型 | <200 字符 |
| 简化 DOM | 主要分析依据 | 目标 ≤ 8KB |
| 可见文本+按钮 | 备用（DOM 太大时） | ≤ 2KB |
| 截图（压缩） | VLM 兜底分析 | ≤ 100KB |
| 网络请求状态 | 检测 AJAX 完成 | 计数 |

### 5.3 DOM 简化器（核心 JS）

```javascript
// dom_extractor.js
(function() {
    const MAX_DEPTH = 8;
    const MAX_TEXT_LEN = 60;
    const MAX_CHILDREN = 30;

    function isInteresting(el) {
        if (!el.tagName) return false;
        const tag = el.tagName.toLowerCase();
        // 只保留可能可交互或承载信息的元素
        const goodTags = ['button', 'a', 'input', 'select', 'textarea',
                          'form', 'nav', 'header', 'main', 'section',
                          'article', 'div', 'span', 'li', 'img', 'h1',
                          'h2', 'h3', 'p', 'label'];
        return goodTags.includes(tag);
    }

    function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        return true;
    }

    function extractAttrs(el) {
        const attrs = {};
        const interesting = ['id', 'name', 'type', 'role', 'aria-label',
                             'placeholder', 'data-testid', 'data-cy',
                             'data-component', 'href', 'value'];
        interesting.forEach(a => {
            const v = el.getAttribute(a);
            if (v) attrs[a] = v;
        });
        // class 单独处理（仅保留有语义的）
        if (el.className && typeof el.className === 'string') {
            const semantic = el.className.split(' ')
                .filter(c => /^[a-z][\w-]{2,}$/i.test(c) && !c.match(/^(css-|sc-|_)/))
                .slice(0, 3);
            if (semantic.length) attrs.class = semantic.join(' ');
        }
        return attrs;
    }

    function simplify(el, depth) {
        if (depth > MAX_DEPTH) return null;
        if (!isInteresting(el)) {
            // 跳过但继续下探
            const kids = [];
            for (let i = 0; i < Math.min(el.children.length, MAX_CHILDREN); i++) {
                const s = simplify(el.children[i], depth);
                if (s) kids.push(s);
            }
            return kids.length === 1 ? kids[0] : (kids.length > 0 ? { _skip: true, children: kids } : null);
        }
        if (!isVisible(el)) return null;

        const node = {
            tag: el.tagName.toLowerCase(),
            attrs: extractAttrs(el)
        };

        const text = (el.innerText || '').trim().substring(0, MAX_TEXT_LEN);
        if (text && !el.children.length) node.text = text;

        const rect = el.getBoundingClientRect();
        node.rect = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
        };

        const clickable = el.onclick != null ||
                          ['button', 'a'].includes(node.tag) ||
                          el.getAttribute('role') === 'button' ||
                          getComputedStyle(el).cursor === 'pointer';
        if (clickable) node.clickable = true;

        const children = [];
        for (let i = 0; i < Math.min(el.children.length, MAX_CHILDREN); i++) {
            const c = simplify(el.children[i], depth + 1);
            if (c) {
                if (c._skip) children.push(...c.children);
                else children.push(c);
            }
        }
        if (children.length) node.children = children;

        return node;
    }

    function generateStableSelector(el) {
        // 生成稳定的选择器（优先级：data-testid > id > aria-label > 相对路径）
        const testid = el.getAttribute('data-testid');
        if (testid) return `[data-testid="${testid}"]`;

        if (el.id && !el.id.match(/^(react-|radix-|\d)/)) return `#${el.id}`;

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return `[aria-label="${ariaLabel}"]`;

        // 使用 text content 定位（适合按钮）
        const text = (el.innerText || '').trim().substring(0, 30);
        if (text && el.tagName.match(/^(BUTTON|A|LI)$/)) {
            return `${el.tagName.toLowerCase()}:contains("${text}")`;
        }

        return null;
    }

    const body = simplify(document.body, 0);
    return JSON.stringify({
        url: location.href,
        title: document.title,
        pathname: location.pathname,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        body: body,
        timestamp: Date.now()
    });
})();
```

### 5.4 采集器 Kotlin 封装

```kotlin
class PageSnapshotter(
    private val webView: WebView,
    private val domExtractorJs: String  // 从 assets 加载
) {
    data class Snapshot(
        val url: String,
        val title: String,
        val pathname: String,
        val dom: JsonObject,           // 结构化 DOM
        val screenshot: Bitmap?,        // 可选，VLM 兜底用
        val timestamp: Long,
        val ajaxIdle: Boolean           // 是否所有 AJAX 已完成
    )

    suspend fun capture(includeScreenshot: Boolean = false): Snapshot {
        // 1. 等待页面稳定
        awaitDomStable(maxWaitMs = 3000)

        // 2. 执行 DOM 采集 JS
        val jsonStr = webView.evaluateJsSuspending(domExtractorJs)
        val domData = Json.parseToJsonElement(jsonStr.unescape()).jsonObject

        // 3. 检查 AJAX 状态
        val ajaxIdle = webView.evaluateJsSuspending("""
            (function() {
                return (window.__pendingAjax || 0) === 0;
            })();
        """) == "true"

        // 4. 截图（仅必要时）
        val screenshot = if (includeScreenshot) captureBitmap() else null

        return Snapshot(
            url = domData["url"]?.jsonPrimitive?.content ?: "",
            title = domData["title"]?.jsonPrimitive?.content ?: "",
            pathname = domData["pathname"]?.jsonPrimitive?.content ?: "",
            dom = domData["body"]?.jsonObject ?: JsonObject(emptyMap()),
            screenshot = screenshot,
            timestamp = System.currentTimeMillis(),
            ajaxIdle = ajaxIdle
        )
    }

    private suspend fun captureBitmap(): Bitmap {
        return withContext(Dispatchers.Main) {
            val bitmap = Bitmap.createBitmap(
                webView.width, webView.height, Bitmap.Config.ARGB_8888
            )
            val canvas = Canvas(bitmap)
            webView.draw(canvas)
            // 压缩: 720x1280, quality=60
            Bitmap.createScaledBitmap(bitmap, 720, 1280, true)
        }
    }

    private suspend fun awaitDomStable(maxWaitMs: Long) {
        val start = System.currentTimeMillis()
        var lastDomSize = 0
        while (System.currentTimeMillis() - start < maxWaitMs) {
            val size = webView.evaluateJsSuspending(
                "document.body.innerHTML.length"
            ).toIntOrNull() ?: 0
            if (size == lastDomSize && size > 0) {
                delay(200)  // 额外稳定窗口
                return
            }
            lastDomSize = size
            delay(300)
        }
    }
}
```

### 5.5 网络请求监控注入

```javascript
// 页面加载完成后注入，监控 fetch / XHR 活跃状态
(function() {
    window.__pendingAjax = 0;

    const origFetch = window.fetch;
    window.fetch = function(...args) {
        window.__pendingAjax++;
        return origFetch.apply(this, args).finally(() => {
            window.__pendingAjax--;
        });
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(...args) {
        this.__tracked = true;
        return origOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        if (this.__tracked) {
            window.__pendingAjax++;
            this.addEventListener('loadend', () => { window.__pendingAjax--; });
        }
        return origSend.apply(this, args);
    };
})();
```

---

## 六、模块 4：AI 决策引擎

### 6.1 两级决策架构（全云端）

```
                    ┌──────────────┐
   Snapshot ──────▶│  Template     │── 命中 ──▶ 快路径 (0 LLM 调用)
                    │   Matcher    │     │
                    └──────┬───────┘     │
                           │ 未命中       │
                           ▼              │
                    ┌──────────────┐      │
                    │  LLM Gateway │      │
                    │  (云端)      │      │
                    └──────┬───────┘      │
                           │              │
              ┌────────────┼────────────┐ │
              ▼            ▼            ▼ │
       ┌──────────┐  ┌──────────┐  ┌─────────┐
       │ Claude   │  │  GPT-4o  │  │ Prompt  │
       │ Sonnet   │  │  (备选)  │  │ Caching │
       │ (主)     │  └──────────┘  └─────────┘
       └─────┬────┘
             ▼
          Action
```

**设计要点**：
- **无本地 LLM**：车机端零模型部署，零 NPU 依赖，固件体积最小化
- **模板库做"本地快路径"**：80% 常见页面通过硬编码规则直接生成 Action，不触发云端调用
- **云端只处理 20% 未知情况**：新页面、改版、复杂规格选择等
- **多云备份**：Claude 不可用时自动切换 GPT-4o，避免单供应商故障

### 6.2 模板库（命中常见页面）

```kotlin
data class PageTemplate(
    val name: String,
    val matcher: (Snapshot) -> Boolean,
    val planner: (Snapshot, OrderTask, ExecutionContext) -> Action?
)

class TemplateMatcher(private val templates: List<PageTemplate>) {
    fun match(snapshot: Snapshot, task: OrderTask, ctx: ExecutionContext): Action? {
        return templates
            .firstOrNull { it.matcher(snapshot) }
            ?.planner?.invoke(snapshot, task, ctx)
    }
}

// 示例模板：UberEats 首页（搜索入口）
val HOME_PAGE_TEMPLATE = PageTemplate(
    name = "ubereats_home",
    matcher = { s ->
        s.pathname == "/" || s.pathname.startsWith("/feed")
    },
    planner = { snapshot, task, ctx ->
        Action.ExecuteJS(
            stage = OrderStage.SEARCHING,
            description = "在首页搜索框输入品牌名",
            jsCode = """
                (function() {
                    // 多重选择器策略
                    const selectors = [
                        '[data-testid="search-input"]',
                        'input[name="q"]',
                        'input[placeholder*="Search" i]',
                        'input[type="search"]'
                    ];
                    let input = null;
                    for (const sel of selectors) {
                        input = document.querySelector(sel);
                        if (input) break;
                    }
                    if (!input) {
                        DriveEats.reportError('search_input_not_found');
                        return 'not_found';
                    }
                    // 拟人化输入
                    input.focus();
                    DriveEats.typeAs('${task.restaurantQuery}', input);
                    return 'ok';
                })();
            """.trimIndent(),
            verifyAfter = true,
            expectedNextStage = OrderStage.SEARCH_RESULTS
        )
    }
)

// 示例模板：搜索结果页
val SEARCH_RESULTS_TEMPLATE = PageTemplate(
    name = "ubereats_search_results",
    matcher = { s ->
        s.pathname.contains("/search") ||
        s.pathname.contains("/feed") && s.url.contains("q=")
    },
    planner = { snapshot, task, ctx ->
        // 基于 DOM 结构匹配第一个餐厅卡片
        Action.ExecuteJS(
            stage = OrderStage.PRODUCT_LIST,
            description = "点击第一个匹配的餐厅",
            jsCode = """
                (function() {
                    const cards = document.querySelectorAll(
                        '[data-testid="store-card"], a[href*="/store/"]'
                    );
                    if (cards.length === 0) return 'no_results';
                    DriveEats.clickAs(cards[0]);
                    return 'clicked';
                })();
            """.trimIndent(),
            verifyAfter = true,
            expectedNextStage = OrderStage.MENU_BROWSING
        )
    }
)

// ... 更多模板: 菜单页、商品详情、购物车、结算页、支付确认页、订单成功页
```

### 6.3 云端 LLM 规划器（仅云端）

```kotlin
class CloudLLMPlanner(
    private val primaryClient: ClaudeClient,      // Claude Sonnet (主)
    private val fallbackClient: OpenAIClient,     // GPT-4o (备)
    private val metrics: LLMMetrics,
    private val cache: ResponseCache
) {

    suspend fun plan(
        snapshot: Snapshot,
        task: OrderTask,
        ctx: ExecutionContext
    ): Action {
        // 1. 命中响应缓存（相似页面直接复用）
        val cacheKey = buildCacheKey(snapshot, task, ctx.currentStage)
        cache.get(cacheKey)?.let {
            metrics.recordCacheHit()
            return it
        }

        // 2. 两阶段调用：先文本判断，不确定时补截图
        val quickAction = tryTextOnly(snapshot, task, ctx)
        if (quickAction != null && quickAction.confidence >= 0.85) {
            cache.put(cacheKey, quickAction, ttlSec = 3600)
            return quickAction
        }

        // 3. 升级为多模态（带截图）
        val fullSnapshot = ensureScreenshot(snapshot)
        val action = tryMultimodal(fullSnapshot, task, ctx)
        cache.put(cacheKey, action, ttlSec = 1800)
        return action
    }

    // ========== 文本路径（成本低，延迟低）==========
    private suspend fun tryTextOnly(
        snapshot: Snapshot, task: OrderTask, ctx: ExecutionContext
    ): Action? {
        return callWithFallback(
            primaryFn = {
                primaryClient.chat(
                    model = "claude-sonnet-4-6",
                    systemPrompt = PLANNER_SYSTEM_PROMPT,
                    userPrompt = buildPrompt(snapshot, task, ctx, includeImage = false),
                    tools = listOf(EXECUTE_ACTION_TOOL),
                    enablePromptCaching = true,
                    timeoutMs = 4000
                ).parseAction()
            },
            fallbackFn = {
                fallbackClient.chat(
                    model = "gpt-4o",
                    systemPrompt = PLANNER_SYSTEM_PROMPT,
                    userPrompt = buildPrompt(snapshot, task, ctx, includeImage = false),
                    tools = listOf(EXECUTE_ACTION_TOOL),
                    timeoutMs = 4000
                ).parseAction()
            }
        )
    }

    // ========== 多模态路径（带截图兜底）==========
    private suspend fun tryMultimodal(
        snapshot: Snapshot, task: OrderTask, ctx: ExecutionContext
    ): Action {
        return callWithFallback(
            primaryFn = {
                primaryClient.chat(
                    model = "claude-sonnet-4-6",
                    systemPrompt = PLANNER_SYSTEM_PROMPT,
                    userPrompt = buildPrompt(snapshot, task, ctx, includeImage = true),
                    image = snapshot.screenshot,
                    tools = listOf(EXECUTE_ACTION_TOOL),
                    enablePromptCaching = true,
                    timeoutMs = 6000
                ).parseAction()
            },
            fallbackFn = {
                fallbackClient.chat(
                    model = "gpt-4o",
                    systemPrompt = PLANNER_SYSTEM_PROMPT,
                    userPrompt = buildPrompt(snapshot, task, ctx, includeImage = true),
                    image = snapshot.screenshot,
                    tools = listOf(EXECUTE_ACTION_TOOL),
                    timeoutMs = 6000
                ).parseAction()
            }
        ) ?: throw LLMException("All providers failed")
    }

    // ========== 主备切换 ==========
    private suspend fun <T> callWithFallback(
        primaryFn: suspend () -> T,
        fallbackFn: suspend () -> T
    ): T? {
        return try {
            withTimeout(primaryTimeoutMs) { primaryFn() }
                .also { metrics.recordSuccess("primary") }
        } catch (e: Exception) {
            metrics.recordFailure("primary", e)
            logger.warn("Primary LLM failed, try fallback", e)
            try {
                fallbackFn().also { metrics.recordSuccess("fallback") }
            } catch (e2: Exception) {
                metrics.recordFailure("fallback", e2)
                null
            }
        }
    }

    companion object {
        val PLANNER_SYSTEM_PROMPT = """
你是 UberEats PWA 页面自动化助手。根据当前页面状态和订单任务，生成下一步要注入的 JavaScript 代码。

# 规则
1. 每次只生成一个关键动作（点击 / 输入 / 滚动）
2. JS 必须使用多重选择器策略（data-testid 优先），防止单一选择器失效
3. 涉及金额/支付按钮，返回 stage=AWAITING_USER_CONFIRM 不要直接点击
4. 检测到弹窗/登录提示，优先处理它
5. 输出的 JS 必须通过 DriveEats.clickAs() 和 DriveEats.typeAs() 来实现拟人化操作

# 可能的页面状态
- SEARCHING: 搜索中
- SEARCH_RESULTS: 搜索结果
- MENU_BROWSING: 餐厅菜单
- ITEM_CUSTOMIZING: 规格/加料
- CART_REVIEW: 购物车
- CHECKOUT: 结算页
- AWAITING_USER_CONFIRM: 需要用户语音确认（支付前）
- ORDER_PLACED: 下单成功
- UNKNOWN_POPUP: 弹窗
- ERROR: 异常

# 置信度
- 0.9+: 明确识别页面和动作
- 0.7-0.9: 较有把握但可能需验证
- <0.7: 不确定，标记 needsVerification=true
""".trimIndent()

        val EXECUTE_ACTION_TOOL = Tool(
            name = "execute_page_action",
            description = "生成下一步的页面自动化动作",
            parameters = schema {
                required("stage", "jsCode", "confidence", "description")
                property("stage", "string", "当前页面阶段")
                property("jsCode", "string", "要执行的 JS 代码")
                property("confidence", "number", "0-1 置信度")
                property("description", "string", "动作描述（用于日志和用户可见）")
                property("expectedNextStage", "string", "执行后预期到达的阶段")
                property("needsVerification", "boolean", "是否需执行后二次验证")
                property("reasoning", "string", "决策依据")
            }
        )
    }
}
```

### 6.4 Prompt 构建

```kotlin
fun buildPrompt(
    snapshot: Snapshot,
    task: OrderTask,
    ctx: ExecutionContext,
    includeImage: Boolean
): String {
    val domCompact = compactDom(snapshot.dom, maxBytes = 6000)
    val historySummary = ctx.history.takeLast(5).joinToString("\n") {
        "- [${it.stage}] ${it.description}"
    }

    return """
## 订单任务
餐厅: ${task.restaurantQuery ?: "自动选择"}
商品: ${task.items.joinToString { "${it.name} x${it.quantity} ${it.size ?: ""}" }}
配送方式: ${task.deliveryMode}
目的地: ${task.destination ?: "当前位置"}

## 当前页面
- URL: ${snapshot.url}
- 标题: ${snapshot.title}
- AJAX 空闲: ${snapshot.ajaxIdle}

## 页面结构（简化 DOM）
```json
$domCompact
```

## 执行历史（最近 5 步）
${historySummary.ifEmpty { "(无)" }}

## 当前状态
阶段: ${ctx.currentStage}
连续失败次数: ${ctx.failureCount}

## 请决策
判断当前阶段，生成下一步动作。${if (includeImage) "参考随附截图辅助判断。" else ""}
""".trimIndent()
}

fun compactDom(dom: JsonObject, maxBytes: Int): String {
    val str = dom.toString()
    if (str.length <= maxBytes) return str
    // 逐层裁剪：限制 children 深度和数量
    return trimJsonObject(dom, maxBytes)
}
```

### 6.5 云端 LLM Gateway（Backend 代理层）

> **关键设计**：车机永远不直接调用 Claude/OpenAI 公网 API。所有云端 LLM 调用由自建 Backend Gateway 代理。

#### 6.5.1 为什么必须走 Gateway

| 理由 | 说明 |
|---|---|
| **API Key 安全** | 第三方 Key 只存在 Backend，车机端永不持有 |
| **统一鉴权** | Gateway 验证车机 JWT，绑定用户身份 |
| **限流熔断** | 单用户、单车机的调用频率控制 |
| **成本可控** | 集中监控 token 消耗，异常立即限流 |
| **Prompt Caching** | 系统 Prompt 在 Gateway 侧缓存复用 |
| **主备切换** | Gateway 决策使用 Claude 或 GPT-4o，车机无感 |
| **合规审计** | 所有 AI 调用留痕（脱敏后） |
| **就近部署** | Gateway 部署在用户最近的 Region，降低 RTT |

#### 6.5.2 Gateway 架构

```
车机 (JWT auth)
   │ HTTPS + 车机签名
   ▼
[边缘 CDN/Load Balancer]
   │
   ▼
[DriveEats Backend Gateway]
   ├─ AuthMiddleware (车机 JWT 校验)
   ├─ RateLimiter (Redis 令牌桶)
   ├─ RequestSanitizer (脱敏 PII、删除 Cookie)
   ├─ ResponseCache (Redis, 相似请求复用)
   ├─ PromptCachingOrchestrator
   ├─ ProviderRouter
   │     ├─ Primary: Claude API (Anthropic)
   │     └─ Fallback: GPT-4o (OpenAI)
   ├─ ResponseValidator (JSON schema 校验)
   ├─ AuditLogger (脱敏后存 S3)
   └─ MetricsEmitter (Prometheus)
```

#### 6.5.3 Gateway API 协议

```
POST /v1/ai/plan
Headers:
  Authorization: Bearer <车机 JWT>
  X-Device-Id: <车机唯一 ID>
  X-Request-Id: <idempotency key>
Body:
{
  "task": { "restaurant": "KFC", "items": [...], "delivery": "..." },
  "snapshot": {
    "url": "...",
    "dom": {...},
    "screenshot_b64": "...",       // 可选，仅兜底时上传
    "stage": "SEARCH_RESULTS",
    "history": [...]
  },
  "config": {
    "prefer_model": "claude-sonnet-4-6",
    "max_latency_ms": 4000,
    "include_reasoning": false
  }
}

Response:
{
  "action": {
    "stage": "PRODUCT_LIST",
    "js_code": "(function() { ... })();",
    "confidence": 0.92,
    "description": "点击第一个沿途 KFC 餐厅",
    "next_expected_stage": "MENU_BROWSING"
  },
  "metadata": {
    "provider": "claude",
    "model": "claude-sonnet-4-6",
    "cached": false,
    "tokens": { "input": 3421, "output": 287, "cache_read": 2100 },
    "latency_ms": 1243,
    "cost_usd": 0.0041
  }
}
```

#### 6.5.4 车机侧客户端

```kotlin
class LLMGatewayClient(
    private val baseUrl: String,
    private val httpClient: OkHttpClient,
    private val tokenProvider: JwtTokenProvider
) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun plan(request: PlanRequest): PlanResponse = withContext(Dispatchers.IO) {
        val requestId = UUID.randomUUID().toString()
        val body = json.encodeToString(request).toRequestBody("application/json".toMediaType())

        val req = Request.Builder()
            .url("$baseUrl/v1/ai/plan")
            .header("Authorization", "Bearer ${tokenProvider.currentToken()}")
            .header("X-Device-Id", deviceId)
            .header("X-Request-Id", requestId)
            .post(body)
            .build()

        httpClient.newCall(req).await().use { resp ->
            when (resp.code) {
                200 -> json.decodeFromString(resp.body!!.string())
                401 -> { tokenProvider.refresh(); throw RetryException() }
                429 -> throw RateLimitException(resp.header("Retry-After")?.toLong())
                503 -> throw ServiceUnavailableException()
                else -> throw LLMException("Gateway error: ${resp.code}")
            }
        }
    }
}
```

#### 6.5.5 Gateway 侧 Prompt Caching 策略

利用 Claude 原生 Prompt Caching，将以下内容标记为可缓存：

```python
# Backend Gateway (Python, 伪代码)
def build_claude_request(req: PlanRequest):
    return {
        "model": "claude-sonnet-4-6",
        "system": [
            {
                "type": "text",
                "text": PLANNER_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"}  # 缓存 5 min
            }
        ],
        "messages": [
            {
                "role": "user",
                "content": [
                    # 静态页面模板描述 (可缓存)
                    {
                        "type": "text",
                        "text": TEMPLATE_CONTEXT,
                        "cache_control": {"type": "ephemeral"}
                    },
                    # 动态上下文 (不缓存)
                    {
                        "type": "text",
                        "text": f"Task: {req.task}\n\nSnapshot:\n{req.snapshot}"
                    }
                ]
            }
        ],
        "tools": EXECUTE_ACTION_TOOL
    }
```

**效果**：
- 系统 Prompt (~2k tokens) 缓存后，输入成本降低 90%
- 首次调用 $0.012 → 命中缓存后 $0.002

#### 6.5.6 限流与熔断策略

```yaml
rate_limits:
  per_device:
    requests_per_minute: 30     # 单车机每分钟最多 30 次
    requests_per_hour: 200      # 单车机每小时 200 次
    orders_per_day: 20          # 单车机每天 20 单
  per_user:
    requests_per_minute: 60
    spend_per_day_usd: 2.0      # 单用户每天 LLM 成本上限
  global:
    claude_rps: 50              # 全局 Claude QPS
    gpt4o_rps: 30

circuit_breaker:
  error_rate_threshold: 0.3     # 错误率 > 30% 触发熔断
  min_requests: 20              # 熔断前最少样本
  cooldown_seconds: 60          # 熔断持续时间
  half_open_requests: 5         # 半开探测请求数
```

### 6.6 LLM 模型选型

| 模型 | 用途 | 输入成本 | 输出成本 | 延迟 |
|---|---|---|---|---|
| **Claude Sonnet (主)** | 所有规划任务；多模态分析 | $3/M | $15/M | 1-3s |
| **GPT-4o (备)** | Claude 不可用时自动切换 | $2.5/M | $10/M | 1-2s |
| ~~Claude Haiku~~ | ~~简单任务~~ | 不采用 | - | - |

**仅使用 Sonnet 级别以上模型**，确保复杂页面分析准确性。成本控制靠模板库和缓存，而非降级到更小模型。

### 6.7 成本估算

假设：单车每天 3 单，每单平均 3 次 LLM 调用，80% 命中模板库，20% 走云端：

| 项 | 数值 |
|---|---|
| 单车日 LLM 调用 | 3 单 × 3 步 × 20% = 1.8 次 |
| 单次调用输入 token | ~3000（命中 Prompt Cache 后实付 ~300） |
| 单次调用输出 token | ~200 |
| 单次成本（缓存命中） | ~$0.004 |
| **单车日 LLM 成本** | **~$0.007 (~¥0.05)** |
| 1 万辆车月度云端成本 | ~$2,100 (~¥15,000) |
| 10 万辆车月度云端成本 | ~$21,000 (~¥150,000) |

**结论**：在模板库命中率 ≥80% 且启用 Prompt Caching 的前提下，云端 LLM 成本可控制在单车每月 ¥1.5 以内。

---

## 七、模块 5：JS 注入执行器

### 7.1 JSInjector 封装

```kotlin
class JSInjector(private val webView: WebView) {

    data class ExecutionResult(
        val success: Boolean,
        val returnValue: String?,
        val error: String?,
        val elapsedMs: Long
    )

    suspend fun execute(jsCode: String, timeoutMs: Long = 5000): ExecutionResult {
        val start = System.currentTimeMillis()
        val wrapped = wrapInTryCatch(jsCode)

        return try {
            withTimeout(timeoutMs) {
                val result = webView.evaluateJsSuspending(wrapped)
                val parsed = parseWrappedResult(result)
                ExecutionResult(
                    success = parsed.error == null,
                    returnValue = parsed.value,
                    error = parsed.error,
                    elapsedMs = System.currentTimeMillis() - start
                )
            }
        } catch (e: TimeoutCancellationException) {
            ExecutionResult(false, null, "timeout", timeoutMs)
        } catch (e: Exception) {
            ExecutionResult(false, null, e.message, System.currentTimeMillis() - start)
        }
    }

    private fun wrapInTryCatch(js: String): String {
        return """
            (function() {
                try {
                    var __result = (function() {
                        $js
                    })();
                    return JSON.stringify({ ok: true, value: __result });
                } catch (e) {
                    return JSON.stringify({ ok: false, error: e.message, stack: e.stack });
                }
            })();
        """.trimIndent()
    }

    // 拟人化操作扩展（挂在 JSBridge 上由 JS 调用）
    suspend fun clickAsHuman(selector: String) {
        val js = """
            (async function() {
                const el = document.querySelector('$selector');
                if (!el) return 'not_found';
                const rect = el.getBoundingClientRect();
                const cx = rect.x + rect.width / 2;
                const cy = rect.y + rect.height / 2;

                // 1. 滚动到可见区域（若需要）
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

                // 2. 模拟鼠标悬停
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
                await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

                // 3. 模拟按下和抬起
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));

                return 'ok';
            })();
        """
        webView.evaluateJsSuspending(js)
    }

    suspend fun typeAsHuman(selector: String, text: String) {
        val js = """
            (async function() {
                const el = document.querySelector('$selector');
                if (!el) return 'not_found';
                el.focus();
                await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

                // 清空
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));

                // 逐字符输入（拟人化）
                const chars = ${'"'}${text.replace("\"", "\\\"")}${'"'};
                for (const ch of chars) {
                    el.value += ch;
                    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
                    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
                    await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
                }
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'ok';
            })();
        """
        webView.evaluateJsSuspending(js)
    }
}
```

---

## 八、模块 6：订单状态机

```kotlin
enum class OrderStage {
    IDLE,                      // 初始
    LOADING_HOME,              // 加载首页
    SEARCHING,                 // 搜索中
    SEARCH_RESULTS,            // 搜索结果
    MENU_BROWSING,             // 浏览菜单
    ITEM_CUSTOMIZING,          // 规格选择
    CART_REVIEW,               // 购物车检查
    CHECKOUT,                  // 结算页
    AWAITING_USER_CONFIRM,     // 等待用户语音确认
    BIOMETRIC_AUTH,            // 生物识别
    SUBMITTING,                // 提交中
    ORDER_PLACED,              // 下单成功
    FAILED,                    // 失败
    USER_CANCELLED,            // 用户取消
    UNKNOWN_POPUP              // 遇到弹窗
}

class OrderStateMachine {
    private val _state = MutableStateFlow<OrderState>(OrderState.Idle)
    val state: StateFlow<OrderState> = _state

    private val transitions = mapOf(
        OrderStage.IDLE to setOf(OrderStage.LOADING_HOME),
        OrderStage.LOADING_HOME to setOf(OrderStage.SEARCHING, OrderStage.FAILED),
        OrderStage.SEARCHING to setOf(OrderStage.SEARCH_RESULTS, OrderStage.FAILED),
        OrderStage.SEARCH_RESULTS to setOf(OrderStage.MENU_BROWSING, OrderStage.FAILED),
        OrderStage.MENU_BROWSING to setOf(
            OrderStage.ITEM_CUSTOMIZING, OrderStage.CART_REVIEW, OrderStage.FAILED
        ),
        OrderStage.ITEM_CUSTOMIZING to setOf(OrderStage.CART_REVIEW, OrderStage.FAILED),
        OrderStage.CART_REVIEW to setOf(OrderStage.CHECKOUT, OrderStage.FAILED),
        OrderStage.CHECKOUT to setOf(OrderStage.AWAITING_USER_CONFIRM, OrderStage.FAILED),
        OrderStage.AWAITING_USER_CONFIRM to setOf(
            OrderStage.BIOMETRIC_AUTH, OrderStage.USER_CANCELLED
        ),
        OrderStage.BIOMETRIC_AUTH to setOf(
            OrderStage.SUBMITTING, OrderStage.USER_CANCELLED
        ),
        OrderStage.SUBMITTING to setOf(OrderStage.ORDER_PLACED, OrderStage.FAILED),
        // 任何阶段都可能被弹窗打断
    )

    fun transition(to: OrderStage): Boolean {
        val current = _state.value.stage
        val allowed = transitions[current].orEmpty() + setOf(OrderStage.UNKNOWN_POPUP)
        if (to !in allowed) {
            logger.warn("Invalid transition: $current -> $to")
            return false
        }
        _state.value = _state.value.copy(stage = to, updatedAt = System.currentTimeMillis())
        return true
    }
}

data class OrderState(
    val stage: OrderStage = OrderStage.IDLE,
    val task: OrderTask? = null,
    val orderId: String? = null,
    val totalAmount: Double? = null,
    val restaurantInfo: RestaurantInfo? = null,
    val errorMessage: String? = null,
    val failureCount: Int = 0,
    val updatedAt: Long = System.currentTimeMillis()
) {
    companion object { val Idle = OrderState() }
}
```

---

## 九、模块 7：双向 JSBridge

```kotlin
class JSBridgeImpl(
    private val onEvent: (BridgeEvent) -> Unit
) {

    // ======= JS → Native =======

    @JavascriptInterface
    fun notifyPageChanged(payload: String) {
        onEvent(BridgeEvent.PageChanged(JSONObject(payload)))
    }

    @JavascriptInterface
    fun requestUserConfirmation(payload: String) {
        val data = JSONObject(payload)
        onEvent(BridgeEvent.NeedConfirmation(
            summary = data.getString("summary"),
            amount = data.getDouble("amount"),
            method = data.getString("method")
        ))
    }

    @JavascriptInterface
    fun reportError(errorCode: String) {
        onEvent(BridgeEvent.Error(errorCode))
    }

    @JavascriptInterface
    fun reportOrderSuccess(orderId: String, address: String) {
        onEvent(BridgeEvent.OrderPlaced(orderId, address))
    }

    // ======= Native → JS (通过 evaluateJavascript) =======
    // 由 WebViewExecutor 主动调用，此处定义工具函数
}

sealed class BridgeEvent {
    data class PageChanged(val data: JSONObject) : BridgeEvent()
    data class NeedConfirmation(
        val summary: String, val amount: Double, val method: String
    ) : BridgeEvent()
    data class Error(val code: String) : BridgeEvent()
    data class OrderPlaced(val orderId: String, val address: String) : BridgeEvent()
}
```

### 9.1 持久化页面监控脚本

```javascript
// 在每次页面加载完成后注入，监控关键事件
(function() {
    if (window.__driveEatsMonitor) return;
    window.__driveEatsMonitor = true;

    // 1. MutationObserver 检测 DOM 重大变化
    let lastNotify = 0;
    new MutationObserver(function(mutations) {
        const now = Date.now();
        if (now - lastNotify < 800) return;

        let significant = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const cls = (node.className || '').toString().toLowerCase();
                // 检测弹窗/覆盖层
                if (cls.match(/modal|dialog|popup|overlay|drawer|toast/)) {
                    DriveEats.notifyPageChanged(JSON.stringify({
                        type: 'popup_appeared',
                        tag: node.tagName,
                        text: (node.innerText || '').substring(0, 200)
                    }));
                    significant = true;
                }
                // 检测主内容变化（列表加载等）
                if (node.querySelectorAll && node.querySelectorAll('*').length > 8) {
                    significant = true;
                }
            }
        }
        if (significant) {
            lastNotify = now;
            DriveEats.notifyPageChanged(JSON.stringify({
                type: 'dom_changed',
                url: location.href
            }));
        }
    }).observe(document.body, { childList: true, subtree: true });

    // 2. URL 变化监听（SPA 路由）
    let lastUrl = location.href;
    setInterval(function() {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            DriveEats.notifyPageChanged(JSON.stringify({
                type: 'url_change',
                url: lastUrl
            }));
        }
    }, 400);

    // 3. 网络错误检测
    window.addEventListener('error', function(e) {
        if (e.target.tagName === 'SCRIPT' || e.target.tagName === 'LINK') {
            DriveEats.reportError('resource_load_failed');
        }
    }, true);
})();
```

---

## 十、模块 8：安全守卫

```kotlin
class SafetyGuard(
    private val userPrefs: UserPreferences,
    private val vehicleState: VehicleStateMonitor
) {

    sealed class GuardResult {
        object Allow : GuardResult()
        data class Block(val reason: String) : GuardResult()
        data class RequireConfirm(val reason: String) : GuardResult()
    }

    fun check(action: Action, task: OrderTask, ctx: ExecutionContext): GuardResult {
        // 1. 支付相关操作必须要求用户确认
        if (isPaymentAction(action)) {
            return GuardResult.RequireConfirm("涉及支付，需要语音 + 生物识别")
        }

        // 2. 金额超限
        val detectedAmount = extractAmount(action)
        if (detectedAmount != null) {
            val maxSingle = userPrefs.maxSingleOrder
            if (detectedAmount > maxSingle) {
                return GuardResult.Block(
                    "订单金额 $detectedAmount 超过限额 $maxSingle"
                )
            }
        }

        // 3. 敏感 JS 代码检测
        if (containsSensitiveCode(action.jsCode)) {
            return GuardResult.Block("JS 含敏感操作: ${detectSensitive(action.jsCode)}")
        }

        // 4. 速率限制
        if (!rateLimiter.allow()) {
            return GuardResult.Block("操作频率过高")
        }

        // 5. 高速驾驶时禁止复杂操作
        val speed = vehicleState.currentSpeedKph
        if (speed > 80 && action.requiresAttention) {
            return GuardResult.Block("高速驾驶中暂停复杂操作")
        }

        // 6. 连续失败熔断
        if (ctx.failureCount >= 5) {
            return GuardResult.Block("连续失败 ${ctx.failureCount} 次，熔断")
        }

        return GuardResult.Allow
    }

    private fun isPaymentAction(action: Action): Boolean {
        val patterns = listOf(
            "place.order", "submit.order", "confirm.pay",
            "pay.now", "checkout.final", "\\$\\d+",
            "place-order-button", "place_order_button"
        )
        return patterns.any { action.jsCode.contains(it.toRegex(RegexOption.IGNORE_CASE)) }
    }

    private fun containsSensitiveCode(js: String): Boolean {
        val forbidden = listOf(
            "document.cookie\\s*=",       // 篡改 Cookie
            "localStorage\\.clear",        // 清空存储
            "sessionStorage\\.clear",
            "location\\s*=\\s*['\"]javascript:",  // JS 协议
            "eval\\s*\\(",                 // 动态执行
            "Function\\s*\\(.*\\)",        // Function 构造器
            "XMLHttpRequest.*open.*POST.*payment",
            "credit.?card|cvv|password"
        )
        return forbidden.any { it.toRegex().containsMatchIn(js) }
    }

    private val rateLimiter = RateLimiter(
        maxActions = 60,       // 每分钟最多 60 次操作
        maxOrders = 5,         // 每小时最多 5 单
        windowMs = 60_000
    )
}

class UserPreferences(
    val maxSingleOrder: Double = 100.0,     // USD
    val dailyLimit: Double = 500.0,
    val requireBiometricAbove: Double = 30.0,
    val enabledBrands: Set<String> = setOf("KFC", "McDonald's", "Starbucks")
)
```

---

## 十一、模块 9：反检测与拟人化

### 11.1 设备指纹正常化

```kotlin
fun generateRealisticUA(): String {
    // 保持稳定（同一设备一致），但像真实浏览器
    val deviceId = Settings.Secure.getString(
        context.contentResolver, Settings.Secure.ANDROID_ID
    ).take(8)
    return "Mozilla/5.0 (Linux; Android 13; Pixel 7) " +
           "AppleWebKit/537.36 (KHTML, like Gecko) " +
           "Chrome/120.0.0.0 Mobile Safari/537.36"
}

// 注入修复常见自动化指纹检测
val ANTI_DETECTION_JS = """
(function() {
    // 移除 navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
    });
    // 正常化 plugins
    Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
    });
    // 正常化 languages
    Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
    });
    // Chrome 特征
    window.chrome = { runtime: {} };
})();
""".trimIndent()
```

### 11.2 拟人化节奏

```kotlin
class Humanizer {
    suspend fun pauseBetweenActions() {
        // 操作间随机停顿 300-1200ms
        delay(300L + Random.nextLong(900))
    }

    suspend fun simulateReadTime(textLength: Int) {
        // 模拟阅读：每字 30-80ms
        delay(textLength * (30L + Random.nextLong(50)))
    }

    suspend fun simulateScrolling(webView: WebView) {
        // 到新页面时，模拟用户滑动浏览
        val scrollCount = Random.nextInt(1, 3)
        repeat(scrollCount) {
            webView.evaluateJsSuspending("""
                window.scrollBy({
                    top: ${Random.nextInt(200, 500)},
                    behavior: 'smooth'
                });
            """)
            delay(500L + Random.nextLong(800))
        }
    }
}
```

---

## 十二、模块 10：变化检测与重分析

```kotlin
class PageChangeDetector(
    private val snapshotter: PageSnapshotter,
    private val onChange: (ChangeType) -> Unit
) {
    enum class ChangeType {
        POPUP_APPEARED,
        URL_CHANGED,
        DOM_MAJOR_CHANGE,
        AJAX_COMPLETED,
        TIMEOUT
    }

    private var lastSnapshot: Snapshot? = null
    private var monitorJob: Job? = null

    fun startMonitoring(scope: CoroutineScope) {
        monitorJob = scope.launch {
            while (isActive) {
                delay(500)
                val current = snapshotter.capture()
                val change = detectChange(lastSnapshot, current)
                if (change != null) {
                    onChange(change)
                    lastSnapshot = current
                }
            }
        }
    }

    private fun detectChange(prev: Snapshot?, curr: Snapshot): ChangeType? {
        if (prev == null) return null
        if (prev.url != curr.url) return ChangeType.URL_CHANGED

        // 检测弹窗（出现 modal/dialog/popup 相关节点）
        val hasPopup = containsPopup(curr.dom)
        val hadPopup = containsPopup(prev.dom)
        if (hasPopup && !hadPopup) return ChangeType.POPUP_APPEARED

        // DOM 大幅变化（节点数变化超 30%）
        val prevNodes = countNodes(prev.dom)
        val currNodes = countNodes(curr.dom)
        if (abs(currNodes - prevNodes) > prevNodes * 0.3) {
            return ChangeType.DOM_MAJOR_CHANGE
        }

        return null
    }

    fun stop() {
        monitorJob?.cancel()
    }
}
```

---

## 十三、完整下单时序

```
[T+0.0s] 用户: "小艺小艺，点一份 KFC 香辣鸡腿堡大份，回家路上取"
         ↓
[T+0.3s] 小艺 ASR: "点一份KFC香辣鸡腿堡大份回家路上取"
         ↓
[T+0.5s] 小艺 NLU → DriveEatsSkillService.onIntentReceived
         slots: { brand:"KFC", item:"Spicy Chicken Sandwich", size:"large",
                  delivery:"pickup_on_route", destination:"home" }
         ↓
[T+0.6s] OrderOrchestrator.startFlow(task)
         TTS: "好的，正在为您查找 KFC..."
         ↓
[T+0.7s] SessionManager.restoreSession()
         ↓
[T+0.8s] HeadlessWebView.acquire() → load https://www.ubereats.com
         ↓
[T+2.5s] onPageFinished → injectLocalStorage()
         注入 AntiDetection + PageMonitor 脚本
         ↓
[T+3.0s] OrderLoop Step 1:
         ├─ Snapshotter.capture() → URL="/", 首页
         ├─ TemplateMatcher.match() → 命中 HOME_PAGE_TEMPLATE
         └─ Action: 搜索 "KFC"
         JSInjector.execute(searchJS) → 触发搜索
         ↓
[T+4.5s] MutationObserver → notifyPageChanged(url_change)
         → PageChangeDetector 唤醒下一轮
         ↓
[T+4.8s] OrderLoop Step 2:
         ├─ Snapshotter.capture() → URL="/search?q=KFC", 搜索结果
         ├─ TemplateMatcher → 命中 SEARCH_RESULTS_TEMPLATE
         └─ Action: 点击第一个沿途 KFC (AI 结合路线信息打分)
         ↓
[T+6.0s] OrderLoop Step 3:
         ├─ 到达餐厅菜单页
         ├─ TemplateMatcher 未命中精确模板 → 调用 CloudLLMPlanner
         ├─ 车机 → LLMGatewayClient → Backend Gateway → Claude Sonnet
         ├─ Claude 返回 (文本路径): 点击"Spicy Chicken Sandwich" (confidence 0.92)
         │   延迟 ~1.5s，命中 Prompt Cache
         └─ JSInjector 执行点击
         ↓
[T+7.5s] OrderLoop Step 4:
         ├─ 到达商品定制页
         ├─ CloudLLMPlanner (Claude): 选大份 + Add to Cart (需要两步)
         ├─ Step 4a: 点击 "Large" (模板命中，0 LLM)
         └─ Step 4b: 点击 "Add to Cart" (模板命中，0 LLM)
         ↓
[T+9.5s] OrderLoop Step 5:
         ├─ 购物车页
         ├─ 模板匹配: 点击 "Go to Checkout"
         ↓
[T+11.0s] OrderLoop Step 6:
          ├─ 结算页 (显示总额 $13.70, 支付方式 Visa ****1234)
          ├─ SafetyGuard.check() → RequireConfirm (支付相关)
          ├─ 状态机 transition → AWAITING_USER_CONFIRM
          └─ 提取: 金额=13.70, 支付方式=Visa 1234
          ↓
[T+11.5s] TTS: "KFC 香辣鸡腿堡套餐，13.70 美元，
                使用 Visa 尾号 1234 支付，确认吗？"
          ↓
[T+13.0s] 用户: "确认"
          ↓
[T+13.5s] 金额 < $30，无需生物识别
          状态机 transition → SUBMITTING
          ↓
[T+13.8s] JSInjector 执行 click submit
          ↓
[T+15.5s] 监听到 URL 变为 /orders/xxx → OrderPlaced
          JSBridge.reportOrderSuccess(orderId="UBR123", address="XX店地址")
          ↓
[T+15.8s] NavigationIntegration.addWaypoint(address)
          TTS: "下单成功，取餐点已添加到导航"
          ↓
[T+16s]   订阅订单状态推送（MQTT 或定时轮询 /orders/xxx）
          ├─ preparing → TTS "订单制作中"
          ├─ ready → TTS "您的订单已备好"
          └─ picked_up → 结束追踪

全流程: 约 16 秒
云端 LLM 调用次数: 1-2 次（大部分由模板命中；均经 Gateway 代理）
云端成本: 约 $0.005 / 单 (~¥0.04)
```

---

## 十四、错误恢复与降级

### 14.1 错误分类与策略

| 错误类型 | 检测方式 | 恢复策略 |
|---|---|---|
| 会话过期 | JS 调用返回 401 / 跳转登录页 | 引导用户重新扫码登录，保留 task 续跑 |
| 页面加载超时 | 页面 load 超 15s | 刷新页面 1 次，再失败则转手机兜底 |
| 选择器失效 | JS 返回 not_found | 升级 VLM 视觉分析 → 坐标点击 |
| 弹窗打断 | MutationObserver 检测 modal | AI 分析弹窗 → 关闭 / 同意 |
| 商品售罄 | 页面出现 "Sold out" | TTS 询问替代品；或询问是否换店 |
| 网络错误 | JS 网络请求失败 | 指数退避重试 3 次 |
| 连续 AI 失败 | failureCount ≥ 5 | 熔断，保存进度，转手机 Handoff |
| 支付拒绝 | 结算页出现 declined | 切备用支付（华为支付/Google Pay） |

### 14.2 恢复管理器

```kotlin
class RecoveryManager(
    private val orchestrator: OrderOrchestrator,
    private val sessionManager: UberEatsSessionManager
) {
    suspend fun handle(error: OrderError, ctx: ExecutionContext): Recovery {
        return when (error) {
            is OrderError.SessionExpired -> {
                tts.speak("登录已过期，请扫码重新登录")
                if (requestRelogin()) Recovery.Resume else Recovery.Abort
            }
            is OrderError.SelectorNotFound -> {
                // 视觉兜底：云端 Claude Sonnet 多模态
                val action = cloudLLMPlanner.plan(
                    snapshot = snapshotter.capture(includeScreenshot = true),
                    task = ctx.task,
                    ctx = ctx.copy(hintForceVision = true)
                )
                if (action.confidence >= 0.7) Recovery.Retry(action)
                else Recovery.EscalateToUser("页面识别失败，请查看")
            }
            is OrderError.PopupInterrupted -> {
                val closeAction = detectPopupClose(ctx.lastSnapshot)
                if (closeAction != null) Recovery.Retry(closeAction)
                else Recovery.EscalateToUser("出现未知弹窗，请查看")
            }
            is OrderError.ItemSoldOut -> {
                Recovery.AskUser("该商品售罄，是否换个商品？")
            }
            is OrderError.TooManyFailures -> {
                Recovery.HandoffToPhone(task = ctx.task)
            }
            else -> Recovery.Retry(lastAction, backoffMs = 2000)
        }
    }
}

sealed class Recovery {
    object Resume : Recovery()
    object Abort : Recovery()
    data class Retry(val action: Action, val backoffMs: Long = 0) : Recovery()
    object EscalateToCloud : Recovery()
    data class EscalateToUser(val message: String) : Recovery()
    data class AskUser(val question: String) : Recovery()
    data class HandoffToPhone(val task: OrderTask) : Recovery()
}
```

### 14.3 手机 Handoff 兜底

```kotlin
suspend fun handoffToPhone(task: OrderTask) {
    // 1. 生成深链
    val deeplink = buildDeeplink(task)
    // 2. 推送到配对手机
    huaweiShareService.sendToPhone(
        action = "open_ubereats",
        payload = deeplink
    )
    // 3. TTS 告知
    tts.speak("已将订单同步到您的手机，请在手机上完成")
}
```

---

## 十五、性能优化

| 优化点 | 实现 | 收益 |
|---|---|---|
| WebView 单例复用 | HeadlessWebViewContainer 单例 + 超时回收 | 冷启动 -1.5s |
| **模板库优先** | **80% 常见页面不调用云端 LLM** | **单步延迟 -2s，成本 -80%** |
| **响应缓存** | 相似页面签名 → 复用历史 Action | **云端调用 -30%** |
| **两阶段调用** | 文本优先 → 不确定再补截图 | 多模态调用 -60% |
| DOM 精简 | 按 tag 白名单 + 不可见过滤 | 每次 token -60% |
| **Prompt Caching** | Claude 系统提示词 + 模板 DOM 缓存 | **云端成本 -80%** |
| **云端主备切换** | Claude → GPT-4o 自动降级 | 可用性 99.9%+ |
| 预加载会话 | 车机启动时后台 warm WebView | 首次下单 -3s |
| 资源屏蔽 | 拦截图片/字体/广告 | 页面加载 -40% |
| **边缘 Gateway** | Backend 代理云端 LLM（就近部署） | 单次调用 -200ms |

### 15.1 资源屏蔽

```kotlin
webView.webViewClient = object : WebViewClient() {
    override fun shouldInterceptRequest(
        view: WebView, request: WebResourceRequest
    ): WebResourceResponse? {
        val url = request.url.toString()
        // 屏蔽广告/跟踪/大图
        if (url.matches(".*\\.(jpg|png|gif|webp|mp4)(\\?|$).*".toRegex()) &&
            !url.contains("product") && !url.contains("menu")) {
            return WebResourceResponse("image/png", "UTF-8", ByteArrayInputStream(byteArrayOf()))
        }
        if (url.contains("analytics") || url.contains("tracking")) {
            return WebResourceResponse("application/javascript", "UTF-8",
                ByteArrayInputStream(byteArrayOf()))
        }
        return super.shouldInterceptRequest(view, request)
    }
}
```

### 15.2 WebView 预热

```kotlin
class WebViewWarmup : Application.ActivityLifecycleCallbacks {
    override fun onActivityStarted(activity: Activity) {
        // 车机启动完成后预加载
        if (activity is MainActivity) {
            CoroutineScope(Dispatchers.IO).launch {
                val wv = HeadlessWebViewContainer.instance.acquire()
                wv.loadUrl("https://www.ubereats.com")
            }
        }
    }
}
```

---

## 十六、测试策略

### 16.1 三层测试金字塔

```
┌─────────────────────────┐
│   E2E (15% 用例)        │  真实 UberEats 生产环境，小流量
├─────────────────────────┤
│   集成测试 (35%)         │  Mock UberEats HTML 快照 + 真 AI
├─────────────────────────┤
│   单元测试 (50%)         │  TemplateMatcher / SafetyGuard / NLU
└─────────────────────────┘
```

### 16.2 HTML 快照测试

```kotlin
// 捕获真实页面快照，作为回归测试 fixture
@Test
fun testSearchPageTemplateMatch() {
    val html = loadAsset("fixtures/ubereats_search_results_20260421.html")
    val snapshot = snapshotter.captureFromHtml(html)

    val action = templateMatcher.match(
        snapshot,
        task = OrderTask(restaurantQuery = "KFC", items = listOf(testItem))
    )

    assertNotNull(action)
    assertEquals(OrderStage.PRODUCT_LIST, action.stage)
    assertTrue(action.jsCode.contains("store-card"))
}
```

### 16.3 线上监控指标

| 指标 | 目标 | 告警阈值 |
|---|---|---|
| 模板命中率 | ≥ 80% | < 60% |
| 端到端成功率 | ≥ 90% | < 80% |
| 平均 LLM 调用/单 | ≤ 3 | > 5 |
| 平均下单时长 | ≤ 20s | > 30s |
| 支付失败率 | < 5% | > 10% |
| 会话过期率 | < 10% | > 20% |

### 16.4 灰度策略

```
Canary (1%)    → 内部员工车机
  ↓ 72h 监控指标
Stage 1 (5%)   → 早期用户
  ↓ 7 天
Stage 2 (25%)
  ↓
Stage 3 (100%)
```

---

## 十七、开发路线图

| 阶段 | 周期 | 交付物 | Exit Criteria |
|---|---|---|---|
| **M0 基础设施** | 3 周 | SessionManager, HeadlessWebView, JSBridge, Snapshotter | 登录持久化验证 |
| **M1 核心链路** | 4 周 | TemplateMatcher (5 个核心模板), JSInjector, StateMachine | 一个品牌一句话下单成功 |
| **M2 AI 兜底** | 3 周 | CloudLLMPlanner (Claude + GPT-4o 备份), 响应缓存, Prompt Caching | 模板未命中时云端 AI 接管 |
| **M3 安全与拟人** | 2 周 | SafetyGuard, Humanizer, AntiDetection | 通过反爬检测 |
| **M4 错误恢复** | 2 周 | RecoveryManager, 8 类错误处理 | 99% 场景有恢复路径 |
| **M5 语音与导航** | 3 周 | 小艺 Skill 集成, Petal Maps waypoint, MQTT 订单状态 | 全链路闭环 |
| **M6 性能优化** | 2 周 | WebView 预热、资源屏蔽、Prompt Caching | 下单 ≤ 20s |
| **M7 测试与灰度** | 3 周 | E2E 测试、灰度监控、应急回滚 | Canary 72h 稳定 |

**总工期**: 22 周（~5 个月）
**团队**: Android × 2, Backend × 1, LLM 工程师 × 1（Prompt/模板/Gateway，**无需本地模型部署**）, QA × 1, PM × 0.5

---

## 附录 A：关键文件清单

```
driveeats/
├── src/main/kotlin/com/driveeats/
│   ├── session/
│   │   ├── UberEatsSessionManager.kt
│   │   ├── UberEatsLoginActivity.kt
│   │   └── AndroidKeyStoreCrypto.kt
│   ├── webview/
│   │   ├── HeadlessWebViewContainer.kt
│   │   ├── PageSnapshotter.kt
│   │   ├── JSInjector.kt
│   │   └── JSBridgeImpl.kt
│   ├── ai/
│   │   ├── AIDecisionEngine.kt
│   │   ├── TemplateMatcher.kt
│   │   ├── CloudLLMPlanner.kt            # 云端 LLM 规划器
│   │   ├── LLMGatewayClient.kt           # Backend Gateway 客户端
│   │   ├── ResponseCache.kt              # 相似请求缓存
│   │   ├── LLMMetrics.kt                 # 调用指标上报
│   │   └── templates/
│   │       ├── HomePageTemplate.kt
│   │       ├── SearchResultsTemplate.kt
│   │       ├── MenuPageTemplate.kt
│   │       ├── ItemCustomizeTemplate.kt
│   │       ├── CartTemplate.kt
│   │       ├── CheckoutTemplate.kt
│   │       └── OrderSuccessTemplate.kt

backend-gateway/  (独立服务，云端部署)
├── src/main/kotlin/com/driveeats/gateway/
│   ├── api/PlanController.kt
│   ├── auth/DeviceAuthMiddleware.kt
│   ├── ratelimit/TokenBucketLimiter.kt
│   ├── cache/ResponseCacheManager.kt
│   ├── provider/
│   │   ├── ClaudeProvider.kt
│   │   ├── OpenAIProvider.kt
│   │   └── ProviderRouter.kt
│   ├── prompt/PromptBuilder.kt
│   └── audit/AuditLogger.kt
│   ├── orchestrator/
│   │   ├── OrderOrchestrator.kt
│   │   ├── OrderStateMachine.kt
│   │   ├── RecoveryManager.kt
│   │   └── SafetyGuard.kt
│   ├── voice/
│   │   ├── XiaoyiSkillService.kt
│   │   └── IntentExtractor.kt
│   ├── navigation/
│   │   └── NavigationIntegration.kt
│   └── security/
│       ├── Humanizer.kt
│       └── AntiDetectionJs.kt
└── src/main/assets/js/
    ├── dom_extractor.js
    ├── page_monitor.js
    ├── anti_detection.js
    └── ajax_tracker.js
```

---

## 附录 B：状态机状态转移总览

```
    IDLE
      │ startFlow()
      ▼
  LOADING_HOME ─── timeout ──▶ FAILED
      │
      ▼
  SEARCHING ─── 无结果 ──▶ FAILED ─── handoff ──▶ PHONE
      │
      ▼
  SEARCH_RESULTS
      │
      ▼
  MENU_BROWSING ──┬── 需选规格 ──▶ ITEM_CUSTOMIZING ──▶ CART_REVIEW
                  └── 直接加购 ──────────────────────▶ CART_REVIEW
      │
      ▼
  CART_REVIEW
      │
      ▼
  CHECKOUT
      │ SafetyGuard.requireConfirm
      ▼
  AWAITING_USER_CONFIRM ─── 取消 ──▶ USER_CANCELLED
      │ 确认
      ▼
  BIOMETRIC_AUTH (若金额 > $30) ─── 失败 ──▶ USER_CANCELLED
      │
      ▼
  SUBMITTING
      │
      ▼
  ORDER_PLACED ──▶ 导航添加途经点 + 订阅状态
```

---

## 附录 C：云端 AI 专属策略分析

### C.1 选择仅使用云端 AI 的理由

| 维度 | 云端 AI 优势 |
|---|---|
| **模型能力** | 始终使用最新最强模型（Claude Sonnet / GPT-4o），无需等待本地模型蒸馏 |
| **车机资源** | 车机 SoC 不承担 LLM 推理负载，无 NPU 要求，兼容中低端平台 |
| **迭代速度** | 模型升级在 Backend 一次性完成，不依赖车机 OTA |
| **成本控制** | 按调用付费；模板命中 80%+，实际云端调用量可控 |
| **维护简化** | 无需管理本地模型文件、量化版本、NPU 驱动适配 |
| **多模态统一** | Claude Sonnet 原生多模态，文本 + 视觉同一模型处理 |
| **合规审计** | 所有 AI 决策经 Gateway 留痕，便于追溯与监管 |

### C.2 放弃本地模型的代价与缓解

| 代价 | 缓解措施 |
|---|---|
| **断网不可用** | 模板库覆盖 80% 常见页面，断网时仍可完成主流程；完全断网转手机 Handoff |
| **云端调用延迟** | Gateway 就近部署（边缘节点）；文本路径控制在 1.5s 内；模板库规避大部分调用 |
| **隐私数据出境** | Gateway 侧脱敏（去 Cookie、去 PII、去敏感金额）；审计日志加密 |
| **云服务成本** | Prompt Caching + 响应缓存；全年单车 LLM 成本 ¥20 以内 |
| **供应商单点** | Claude + GPT-4o 双供应商；Gateway 自动故障切换 |
| **高并发限流** | 按设备/用户/全局三级限流；排队降级 |

### C.3 使用边界

| 场景 | 策略 |
|---|---|
| 车机在线（4G/5G/WiFi） | 正常走 Gateway |
| 车机弱网（<100kbps） | 仅模板库路径；无模板时降级为"请重试"TTS |
| 车机完全断网 | 禁用点单功能；TTS 提示"网络未连接" |
| Gateway 不可达 | 车机重试 3 次，仍失败则 Handoff 到手机 |
| LLM 调用超时 | 单次 4s 超时，Gateway 立即切备用 Provider |
| 用户禁用云 AI | 系统设置开关；关闭后仅能使用模板匹配功能 |

### C.4 隐私承诺

- ✅ 车机发往 Gateway 的请求**不含** Cookie、Access Token、支付卡号、CVV、密码
- ✅ 页面截图上传前经过 PII 模糊（邮箱/手机号/地址打码）
- ✅ LLM 审计日志仅保留 7 天，自动脱敏后归档
- ✅ 用户随时可在设置中关闭"云端 AI 辅助"，退回纯模板模式
- ✅ 与 LLM 供应商的数据处理协议（DPA）明确禁止训练使用

---

## 附录 D：合规要点自查清单

- [ ] 用户主动 OAuth 登录自己的 UberEats 账户
- [ ] 首次使用明确告知"AI 代表您操作您的账户"
- [ ] 凭据使用 AndroidKeyStore 加密存储，不上云
- [ ] 每次支付必须语音或生物识别确认
- [ ] 模拟真实操作节奏（300-1200ms 随机延迟）
- [ ] 速率限制：每设备每小时 ≤ 5 单
- [ ] 不绕过 SSL Pinning / 反爬机制
- [ ] 不逆向请求签名算法
- [ ] 异地登录时提示用户
- [ ] 上线前完成 UberEats ToS 律师审查
- [ ] 提供便捷"退出登录"与"清除所有数据"
- [ ] 遵守 GDPR / 个保法的用户数据删除权

---

**文档维护**：随项目进展持续更新
**反馈渠道**：DriveEats 项目组
