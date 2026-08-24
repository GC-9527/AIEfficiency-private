# DriveEats 车载本地生活应用技术方案

> **版本**：v2.0
> **更新日期**：2026-04-21
> **关键调整**：语音助手切换为华为小艺；支付首选 UberEats 绑定支付方式
> **接入平台**：UberEats（主），预留高德/美团/饿了么扩展

---

## 目录

- [一、产品定位与核心体验](#一产品定位与核心体验)
- [二、整体系统架构](#二整体系统架构)
- [三、核心技术栈选型](#三核心技术栈选型)
- [四、语音模块：华为小艺深度集成](#四语音模块华为小艺深度集成)
- [五、支付模块：UberEats 原生支付 + 多层备选](#五支付模块ubereats-原生支付--多层备选)
- [六、下单场景详细展开](#六下单场景详细展开)
- [七、定位与导航融合](#七定位与导航融合)
- [八、UI 层设计](#八ui-层设计)
- [九、性能优化](#九性能优化)
- [十、安全与合规](#十安全与合规)
- [十一、开发落地路线图](#十一开发落地路线图)
- [十二、关键 PoC 验证项](#十二关键-poc-验证项)

---

## 一、产品定位与核心体验

**产品名称**：DriveEats
**核心场景**：驾驶途中一句话完成"搜索 → 下单 → 支付 → 导航取餐/送达"
**设计原则**：
- **三秒原则**：任何交互不超过 3 秒等待
- **一句直达**：参数完整时 0 次二次交互
- **零视线离开**：语音为主，视觉辅助（符合 NHTSA / 车辆 Driver Distraction 规范）

---

## 二、整体系统架构

```
┌────────────────────────────────────────────────────────────────────┐
│                       车机前端层 (AAOS / HarmonyOS)                  │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ 华为小艺      │  │ Car App UI   │  │ 持久化订单卡片             │ │
│  │ (主语音入口)  │  │ (订单状态)    │  │ (HUD / Mini Card)         │ │
│  └──────┬──────┘  └──────┬───────┘  └─────────┬─────────────────┘ │
│         │                  │                    │                   │
│         ▼                  ▼                    ▼                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │              DriveEats Agent (核心协调器)                    │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────────────┐ │   │
│  │  │ Intent  │ │ 订单状态 │ │ 支付路由 │ │ 地理/导航服务     │ │   │
│  │  │  路由   │ │   机    │ │  模块    │ │                  │ │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └──────────────────┘ │   │
│  └────────────────────────────────────────────────────────────┘   │
│                               │                                    │
│       ┌───────────────────────┼───────────────────────┐            │
│       ▼                       ▼                       ▼            │
│  ┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐  │
│  │  UberEats   │     │ Petal Maps /    │     │ 车载定位 +       │  │
│  │  OpenAPI    │     │ Google Maps Auto│     │ Fused Provider   │  │
│  └──────┬──────┘     └─────────────────┘     └─────────────────┘  │
└─────────┼──────────────────────────────────────────────────────┘
          ▼
┌────────────────────────────────────────────────────────────────────┐
│                         云端 Backend (BFF)                          │
│  ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ 会话  │ │ 用户    │ │ UberEats │ │ 支付聚合 │ │ LLM 代理     │ │
│  │ Redis │ │ Profile│ │ OAuth/API│ │ 路由层   │ │ (Claude/盘古)│ │
│  └────────┘ └────────┘ └──────────┘ └──────────┘ └──────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

---

## 三、核心技术栈选型

| 层级 | 首选技术 | 备选方案 | 说明 |
|---|---|---|---|
| OS | HarmonyOS NEXT for Car / AAOS 14 | - | 双平台兼容 |
| UI 框架 | ArkUI（鸿蒙）/ Jetpack Compose for Car | `androidx.car.app` Template | 合规 distraction |
| **语音助手** | **华为小艺（主）** | 车机原生 VoiceInteractionService | 主入口，详见第四章 |
| 语音唤醒词 | 小艺官方"小艺小艺" + 自定义技能词 | Porcupine 离线 KWS | 小艺已内置 |
| NLU | 小艺语义理解 + 自定义技能 Schema | 本地 Qwen2.5-3B + 云端 LLM | 分层处理 |
| LLM（槽位增强） | 云端 Claude Sonnet / 华为盘古 | 本地 Qwen2.5-3B | 复杂语义兜底 |
| TTS | 华为小艺 TTS | 系统 TTS | 与唤醒声线统一 |
| 定位 | 华为 Location Kit + Car Sensor API | Fused Location Provider | 多源融合 |
| 导航 | Petal Maps / 高德车机 / Google Maps for Auto | - | 视区域而定 |
| 订单 API | UberEats Developer API (OAuth 2.0) | - | 官方合作 |
| **支付（主）** | **UberEats 账户绑定支付** | Google Pay / 华为支付 / 微信车机版 | 详见第五章 |
| 通信 | HTTPS REST + MQTT（状态推送） | gRPC 双向流 | 订单实时更新 |

---

## 四、语音模块：华为小艺深度集成

### 4.1 为什么选择小艺

| 优势 | 说明 |
|---|---|
| 系统级入口 | 鸿蒙/EMUI 车机原生内置，无需用户额外授权 |
| 全双工对话 | 支持连续对话、免唤醒词、打断恢复 |
| 多模态能力 | 已接入盘古大模型，支持复杂语义理解 |
| 场景技能框架 | Xiaoyi Skills SDK 支持第三方注册自定义技能 |
| 车规优化 | 小艺车机版已针对驾驶噪声、远场拾音优化 |
| 端云协同 | 离线 ASR + 云端大模型，断网基础可用 |

### 4.2 集成方式：注册小艺自定义技能（Xiaoyi Skill）

#### 4.2.1 技能声明

```json
// skill_manifest.json
{
  "skill_id": "com.driveeats.voice.ordering",
  "skill_name": "DriveEats 点餐",
  "invocation_name": "点餐助手",
  "trigger_phrases": [
    "我想吃",
    "点一份",
    "来份",
    "帮我订",
    "饿了",
    "附近的餐厅"
  ],
  "intents": [
    {
      "intent": "food_order",
      "slots": [
        { "name": "restaurant", "type": "custom.RestaurantBrand", "required": false },
        { "name": "item", "type": "custom.FoodItem", "required": true },
        { "name": "size", "type": "custom.Size", "required": false },
        { "name": "quantity", "type": "number", "required": false },
        { "name": "delivery_mode", "type": "custom.DeliveryMode", "required": false },
        { "name": "destination", "type": "location", "required": false }
      ],
      "samples": [
        "来份{restaurant}的{item}{size}",
        "帮我点{quantity}份{item}送到{destination}",
        "在回{destination}的路上买个{item}",
        "我想吃{item}，{size}的"
      ]
    },
    {
      "intent": "cancel_order",
      "samples": ["取消订单", "不要了", "算了"]
    },
    {
      "intent": "order_status",
      "samples": ["我的订单怎么样了", "还要多久", "订单到哪了"]
    }
  ],
  "permissions": [
    "location.fine",
    "payment.request",
    "navigation.modify"
  ]
}
```

#### 4.2.2 小艺 → DriveEats 回调架构

```kotlin
// 小艺技能回调入口
class DriveEatsXiaoyiSkillService : XiaoyiSkillService() {

    override fun onIntentReceived(intent: XiaoyiIntent): XiaoyiResponse {
        return when (intent.name) {
            "food_order" -> handleFoodOrder(intent.slots)
            "cancel_order" -> handleCancel()
            "order_status" -> handleStatusQuery()
            else -> XiaoyiResponse.unsupported()
        }
    }

    private fun handleFoodOrder(slots: Map<String, XiaoyiSlot>): XiaoyiResponse {
        // 1. 槽位抽取
        val task = OrderTask(
            restaurantQuery = slots["restaurant"]?.value,
            itemName = slots["item"]?.value
                ?: return XiaoyiResponse.elicit("您想吃什么呢？"),
            size = slots["size"]?.value,
            quantity = slots["quantity"]?.asInt() ?: 1,
            deliveryMode = slots["delivery_mode"]?.value ?: "pickup_on_route",
            destination = slots["destination"]?.value
        )

        // 2. 复杂语义 → 追加 LLM 增强
        val enriched = if (task.needsEnrichment()) {
            llmAgent.enrichTask(task, originalUtterance = intent.rawText)
        } else task

        // 3. 异步执行下单流程，返回即时语音反馈
        orderAgent.startOrderFlowAsync(enriched)

        return XiaoyiResponse.builder()
            .setSpeech("好的，正在为您查找${enriched.restaurantQuery ?: enriched.itemName}…")
            .setVisualCard(buildProgressCard(enriched))
            .setDialogMode(DialogMode.CONTINUE_CONVERSATION) // 保持麦克风打开
            .build()
    }
}
```

### 4.3 分层 NLU 架构

小艺原生 NLU 只能识别预注册的意图和槽位，对复杂口语化表达需 LLM 增强：

```
用户语音
   ↓
[华为小艺 ASR] → 文本
   ↓
[小艺 NLU] → 意图 + 基础槽位
   ↓
  ┌─ 置信度 > 0.85 且槽位完整 → 直接执行
  │
  └─ 置信度低 / 槽位不全 / 复杂表达
        ↓
     [LLM 增强层] (盘古 / Claude)
        ↓ Function Calling
     完整结构化 task
        ↓
     执行下单
```

### 4.4 多轮对话示例

**场景 A：一句说清**
```
用户："小艺小艺，来份 KFC 香辣鸡腿堡大份，回家路上取"
小艺：[识别意图 food_order, 槽位完整]
小艺："找到沿途 3 公里的肯德基，香辣鸡腿堡大份套餐 32 元，确认下单吗？"
用户："确认"
小艺："下单成功，已添加取餐点到导航"
```

**场景 B：需追问**
```
用户："小艺小艺，我想吃炸鸡"
小艺：[意图 food_order, 缺 restaurant 槽位]
小艺："您想要肯德基还是麦当劳？"
用户："肯德基吧"
小艺："好的，有套餐、单品，您要哪种？"
用户："香辣鸡腿堡套餐"
小艺：[槽位补全] "..."
```

**场景 C：小艺原生→LLM 兜底**
```
用户："小艺小艺，帮我订点下班路上能吃的，要辣一点的快餐，预算 50 块以内"
小艺：[意图识别，但约束描述复杂，槽位不完整]
  ↓ 路由给 LLM
LLM：[理解"辣""快餐""下班路上""预算 50"]
  ↓ 查询 UberEats API
  ↓ 过滤满足条件的商户和商品
小艺："找到 2 家选择：肯德基香辣鸡腿堡套餐 32 元，或真功夫辣子鸡饭 28 元，绕路都不超过 5 分钟"
用户："来肯德基那个"
```

### 4.5 备选语音方案（降级路径）

```
首选: 华为小艺 (鸿蒙/EMUI 车机)
  ↓ 不可用时降级
降级 1: AAOS 系统 VoiceInteractionService + 自研 LLM
  ↓ 不可用时降级
降级 2: App 内置 VAD + ASR（科大讯飞/阿里云 SDK）+ LLM
  ↓ 极端情况
降级 3: 手动触屏 + 常用品牌快捷卡片
```

---

## 五、支付模块：UberEats 原生支付 + 多层备选

### 5.1 核心原则

**优先使用用户在 UberEats App 中已绑定的支付方式**——用户体验最顺畅、无需重新绑卡、一致性最高。

### 5.2 UberEats 原生支付流程

UberEats OpenAPI 支持 **Stored Payment Method**，通过 OAuth 授权后可复用用户账户下的默认支付方式：

```
┌─────────────────────────────────────────────────────────────┐
│                 首次使用：账号关联流程                         │
│                                                              │
│  1. 用户在 DriveEats App 内扫码 / OAuth 登录 UberEats        │
│     ↓                                                        │
│  2. 获取 access_token + refresh_token                        │
│     ↓                                                        │
│  3. 调用 GET /v1/eats/payment-methods                        │
│     返回: 用户绑定的卡列表，标记 is_default=true               │
│     ↓                                                        │
│  4. Backend 加密存储 token（车机本地仅存 handle）              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  每次下单：使用绑定支付                         │
│                                                              │
│  1. 创建订单草稿 POST /v1/eats/orders                        │
│     payload: { store_id, items, payment_method_id: "default" }│
│     ↓                                                        │
│  2. UberEats 返回订单预览 + 金额 + 税费                       │
│     ↓                                                        │
│  3. 车机侧语音/生物识别确认                                    │
│     ↓                                                        │
│  4. POST /v1/eats/orders/{id}/confirm                        │
│     → UberEats 内部扣款（使用已绑定支付方式）                   │
│     ↓                                                        │
│  5. 返回 order_id + 支付状态                                  │
└─────────────────────────────────────────────────────────────┘
```

#### 关键代码

```kotlin
class UberEatsPaymentService(private val apiClient: UberEatsApiClient) {

    suspend fun getUserPaymentMethods(): List<PaymentMethod> {
        val response = apiClient.get("/v1/eats/payment-methods")
        return response.parseAs<PaymentMethodsResponse>().methods
    }

    suspend fun placeOrderWithBoundPayment(
        draft: OrderDraft,
        paymentMethodId: String = "default"
    ): OrderResult {
        // 1. 校验支付方式可用
        val methods = getUserPaymentMethods()
        val selected = if (paymentMethodId == "default") {
            methods.firstOrNull { it.isDefault }
        } else {
            methods.firstOrNull { it.id == paymentMethodId }
        } ?: throw PaymentException("支付方式不可用")

        // 2. 二次确认（语音 + 生物识别/PIN）
        val confirmed = confirmWithUser(
            amount = draft.totalAmount,
            paymentMethod = selected.displayName  // 如 "Visa **** 1234"
        )
        if (!confirmed) return OrderResult.Cancelled

        // 3. 直接由 UberEats 扣款
        return apiClient.post("/v1/eats/orders/${draft.id}/confirm") {
            body = mapOf("payment_method_id" to selected.id)
        }.parseAs<OrderResult>()
    }

    private suspend fun confirmWithUser(amount: Double, paymentMethod: String): Boolean {
        // 语音播报
        tts.speak("将使用 $paymentMethod 支付 $amount 美元，请确认")
        // 生物识别（可选，视 OEM 配置）
        val bioResult = biometricAuth.authenticate(
            title = "Confirm Payment",
            subtitle = "$amount USD via $paymentMethod"
        )
        return bioResult.success
    }
}
```

### 5.3 支付路由层：多层备选策略

```kotlin
class PaymentRouter {

    suspend fun pay(order: OrderDraft): PaymentResult {
        // ============ 层级 1: UberEats 绑定支付（首选）============
        if (uberEatsAuth.isAuthorized()) {
            val methods = uberEatsPayment.getUserPaymentMethods()
            if (methods.isNotEmpty()) {
                try {
                    return uberEatsPayment.placeOrderWithBoundPayment(order)
                } catch (e: PaymentException) {
                    logger.warn("UberEats 绑定支付失败，尝试降级", e)
                }
            }
        }

        // ============ 层级 2: 华为支付 (HMS Pay) ============
        if (huaweiPayAvailable()) {
            try {
                return huaweiPayment.pay(order)
            } catch (e: PaymentException) {
                logger.warn("华为支付失败，尝试降级", e)
            }
        }

        // ============ 层级 3: Google Pay for Auto ============
        if (googlePayAvailable()) {
            try {
                return googlePayment.pay(order)
            } catch (e: PaymentException) {
                logger.warn("Google Pay 失败", e)
            }
        }

        // ============ 层级 4: 车机预存支付（微信/银联车机版）============
        if (wechatCarPayAvailable()) {
            return wechatCarPayment.pay(order)
        }

        // ============ 兜底: 转手机 App 支付 ============
        return transferToPhone(order)  // 通过 Handoff 跳转手机完成
    }
}
```

### 5.4 支付方式对比

| 支付方式 | 优点 | 缺点 | 适用场景 |
|---|---|---|---|
| **UberEats 绑定支付** | 用户已熟悉、无需重新授权、一致性高 | 首次需 OAuth 关联 | **主方案** |
| 华为支付 (HMS Pay) | 鸿蒙车机原生，指纹/PIN 体验好 | 仅支持 HMS 生态 | 鸿蒙车机备选 |
| Google Pay for Auto | 国际市场成熟 | 国内不可用 | 海外车型 |
| 微信车机版 / 银联 | 国内主流 | 签约复杂 | 国内兜底 |
| 转手机支付 | 兼容所有 | 打断驾驶体验 | 最终兜底 |

### 5.5 支付安全加固

```kotlin
class PaymentSecurityGuard {
    // 1. 金额异常检测
    fun validateAmount(order: OrderDraft, user: UserProfile): Boolean {
        val maxSingle = user.preferences.maxSingleOrderAmount ?: 100.0  // USD
        val dailyUsage = user.todayOrderTotal
        val dailyLimit = user.preferences.dailyLimit ?: 500.0
        return order.totalAmount <= maxSingle &&
               (dailyUsage + order.totalAmount) <= dailyLimit
    }

    // 2. 免密额度（小额免二次确认）
    fun requiresBiometric(amount: Double): Boolean {
        return amount >= 30.0  // 超过 30 USD 需生物识别
    }

    // 3. 高速驾驶强制语音确认
    fun pickConfirmMode(vehicleSpeed: Int): ConfirmMode {
        return when {
            vehicleSpeed > 80 -> ConfirmMode.VOICE_ONLY  // 禁止任何触屏
            vehicleSpeed > 0 -> ConfirmMode.VOICE_OR_BIOMETRIC
            else -> ConfirmMode.ALL  // 停车时才允许输入 PIN
        }
    }

    // 4. 账户冻结检测
    fun checkAccountStatus(): AccountStatus {
        // 查询 UberEats 账户是否被冻结、支付方式是否过期等
    }
}
```

---

## 六、下单场景详细展开

### 6.1 场景一：沿途取餐（Pickup On Route）

**典型用户故事**
> 用户正在开车回家，突然饿了。"小艺小艺，我想吃 KFC，回家路上去取"

#### 详细时序

```
[T+0.0s] 用户发起
  └─ 语音: "小艺小艺，来份 KFC 香辣鸡腿堡大份，回家路上取"

[T+0.3s] 华为小艺唤醒 + ASR
  └─ 识别文本: "来份KFC香辣鸡腿堡大份回家路上取"

[T+0.6s] 小艺 NLU 解析
  └─ intent: food_order
     slots: {
       restaurant: "KFC",
       item: "香辣鸡腿堡",
       size: "大份",
       delivery_mode: "pickup_on_route",
       destination: "home"  // 用户预设地址
     }

[T+0.8s] DriveEats Agent 接收，语音反馈
  └─ TTS: "好的，正在为您查找沿途的肯德基..."
  └─ UI: 显示加载卡片

[T+1.0s] 并行执行:
  ├─ 获取当前位置 (car_gps)
  ├─ 获取回家路线 (从导航 App 读取)
  └─ 查询用户预设 "home" 地址

[T+1.5s] 调用 UberEats API 沿途搜索
  └─ POST /v1/eats/stores/search
     {
       "query": "KFC",
       "along_route": [<polyline 采样点>],
       "max_detour_minutes": 5
     }

[T+2.5s] 返回 3 家沿途 KFC
  └─ 算法排序: 绕路时间 + 制作时间 + 评分
  └─ 最优门店: "KFC 人民路店" (绕路 3min, 制作 8min)

[T+2.8s] 获取菜单 + LLM 匹配商品
  └─ "香辣鸡腿堡大份" → menu_item_id: "spicy_chicken_combo_L"

[T+3.0s] 创建订单草稿
  └─ POST /v1/eats/orders/draft
  └─ 返回: { total: $12.50, tax: $1.20, total_after_tax: $13.70 }

[T+3.3s] 查询用户绑定的支付方式
  └─ GET /v1/eats/payment-methods
  └─ 返回: default = "Visa **** 1234"

[T+3.5s] 语音确认
  └─ TTS: "找到人民路肯德基，香辣鸡腿堡大份套餐 13.70 美元，
          使用您的 Visa 尾号 1234 支付，确认下单吗？"
  └─ UI: 订单确认卡片（PaneTemplate）

[T+5.0s] 用户: "确认" / "OK"
  └─ 小艺继续对话模式，直接识别

[T+5.2s] 生物识别（金额 > 30 USD 时）
  └─ 司机指纹 / 屏幕 PIN
  └─ 此单 13.70 USD < 30 USD，免生物识别，直接提交

[T+5.5s] 提交订单
  └─ POST /v1/eats/orders/{draft_id}/confirm
     { "payment_method_id": "default" }

[T+6.5s] 下单成功
  └─ TTS: "下单成功，大约 8 分钟后到达人民路肯德基"
  └─ UI: 订单追踪卡片（NavigationTemplate）
  └─ 自动添加导航途经点

[T+7.0s] 导航更新
  └─ Petal Maps / Google Maps 添加 waypoint
  └─ HUD 显示 "取餐点: KFC 人民路店 · 3.2km"

[T+8s 起] MQTT 订阅订单状态
  ├─ preparing → TTS: "订单制作中"
  ├─ ready_for_pickup → TTS: "您的订单已备好，2 分钟后到达"
  └─ picked_up → TTS: "已取餐，继续为您导航回家"
```

**端到端时长**: 约 7 秒（用户说完话到下单成功）

### 6.2 场景二：送达指定地点（Delivery）

> "小艺小艺，订两杯瑞幸美式送到我公司"

**关键差异**：
- `delivery_mode = delivery_to_address`
- `destination = "公司"` → 用户预设地址
- 不修改导航路线
- 显示"预计送达时间"而非"取餐路径"

```
[用户] "订两杯瑞幸美式送到我公司"
  ↓ 小艺识别
  slots: { restaurant: "瑞幸", item: "美式", quantity: 2, 
           delivery_mode: "delivery_to_address", destination: "公司" }
  ↓
[Agent] 查找距离 "公司" 最近的瑞幸门店（配送范围内）
  ↓
[API] 创建配送订单: delivery_address = 用户公司地址
  ↓
[TTS] "两杯瑞幸美式共 6 美元，使用 Visa 1234 支付，
      预计 25 分钟送达您公司，确认吗？"
  ↓
[用户] "好"
  ↓ 下单成功
[TTS] "下单成功，骑手预计 25 分钟送达"
[UI] 订单追踪卡片，展示配送员位置
```

### 6.3 场景三：到店自取（Dine-In / Pickup at Destination）

> "小艺小艺，帮我在星巴克门店下单一杯拿铁，10 分钟后我到"

```
slots: { restaurant: "星巴克", item: "拿铁",
         delivery_mode: "pickup_at_destination",
         arrival_time: "10 minutes" }

[Agent] 计算当前位置与星巴克距离
  ├─ 导航 ETA = 8 min
  ├─ 制作时间 = 5 min
  └─ 建议: "10 分钟后到店，您到时咖啡刚好做好"

[TTS] "找到最近的星巴克门店 2 公里，一杯拿铁 5 美元，到店取餐，确认吗？"
```

### 6.4 场景四：多轮追问（信息不全）

> 用户："小艺小艺，我饿了"

```
[小艺] "您想吃什么？附近有肯德基、麦当劳、星巴克"
  └─ UI: 快捷推荐卡片（基于用户历史）

[用户] "肯德基吧"

[小艺] "好的，您想要套餐还是单品？"

[用户] "香辣鸡腿堡套餐"

[小艺] "大份还是中份？"

[用户] "大份"

[小艺] "回家路上取还是送到公司？"

[用户] "回家路上吧"

[小艺] "好的，最近的肯德基绕路 3 分钟，香辣鸡腿堡大份 13.70 美元，
       用 Visa 1234 支付，确认下单吗？"
```

**关键设计**：
- 每轮只追问一个缺失槽位，避免信息过载
- 提供候选项而非开放问答
- 全程保持小艺连续对话模式，无需重复唤醒

### 6.5 场景五：订单修改与取消

> "小艺小艺，刚才那个订单加杯可乐"

```
[小艺 NLU] intent: modify_order, slots: { add_item: "可乐" }

[Agent] 查询最近订单状态
  ├─ 若状态 = DRAFT / AWAITING_CONFIRM: 直接修改
  ├─ 若状态 = PLACED，商家未接单: 调用 UberEats modify API
  └─ 若商家已接单: 不可修改

[TTS] "订单已提交 30 秒，商家未接单，为您添加一杯可乐 2 美元，
      总金额 15.70 美元，确认吗？"
```

> "小艺小艺，取消订单"

```
[小艺] "正在为您取消人民路肯德基的订单..."
[API] POST /v1/eats/orders/{id}/cancel
[TTS] "已取消，费用将在 3-5 个工作日退回"
[Nav] 自动移除取餐途经点
```

### 6.6 场景六：订单状态查询

> "小艺小艺，我的订单怎么样了？"

```
[Agent] 查询当前进行中订单
[TTS] "您在肯德基的订单正在制作中，预计 5 分钟后备好，
      门店距您 2 公里，导航已为您安排"
```

### 6.7 场景七：异常处理

| 异常 | 处理方案 |
|---|---|
| UberEats 无匹配商户 | TTS: "沿途没找到肯德基，附近 2 公里有麦当劳，要换吗？" |
| 支付失败 | 自动降级到备选支付（华为支付 → 微信车机版） |
| 商品已售罄 | TTS: "香辣鸡腿堡售罄，推荐吮指原味鸡套餐，要换吗？" |
| 网络断连 | TTS: "网络异常，已保存意图，连网后将提示您是否下单" |
| 驾驶员分心过多 | 高速路段自动暂停对话，仅响应"确认/取消"简单指令 |
| 商家拒单 | TTS: "商家暂停接单，推荐附近另一家门店" + 自动切换 |
| 导航冲突 | 原目的地距离远时，提示"已添加取餐点，将延迟 3 分钟到家" |

---

## 七、定位与导航融合

### 7.1 定位多源融合

```kotlin
class CarLocationService {
    fun getCurrentLocation(): Location {
        // 优先级: 车载 CAN 总线 GPS > Fused Provider > 网络定位
        
        // 1. 车载硬件 GPS（精度最高，0.5-2m）
        val canGps = carSensorManager.getLocation(CarSensor.GPS)
        if (canGps != null && canGps.accuracy < 5) return canGps

        // 2. 华为 Location Kit（Fused，精度 3-10m）
        val fused = huaweiLocationKit.lastLocation.await()
        if (fused.accuracy < 20) return fused

        // 3. 网络定位兜底
        return networkLocation.getLastKnown()
    }

    fun getRouteContext(): RouteContext {
        return RouteContext(
            current = getCurrentLocation(),
            destination = navBridge.destination,
            polyline = navBridge.polyline,
            etaMinutes = navBridge.eta,
            speedKph = carSensorManager.get(CarSensor.SPEED),
            remainingKm = navBridge.remainingDistanceKm
        )
    }
}
```

### 7.2 沿途搜索算法

```kotlin
suspend fun searchAlongRoute(
    query: String,
    route: Polyline,
    maxDetourMinutes: Int = 5
): List<Restaurant> {
    // 1. 沿路线每 2km 取采样点
    val samples = route.sample(intervalKm = 2.0)

    // 2. 并行查询每个点周边
    val candidates = samples.parallelMap { point ->
        uberApi.searchStores(query, near = point, radiusKm = 1.5)
    }.flatten().distinctBy { it.id }

    // 3. 计算绕路时间
    val scored = candidates.parallelMap { store ->
        val detour = navService.calculateDetour(route, store.location)
        RestaurantScore(
            store = store,
            detourMinutes = detour.extraMinutes,
            prepTimeMin = store.estimatedPrepTime,
            rating = store.rating,
            distance = detour.extraKm
        )
    }

    // 4. 综合排序
    return scored
        .filter { it.detourMinutes <= maxDetourMinutes }
        .sortedByDescending { it.score() }
        .take(3)
        .map { it.store }
}

private fun RestaurantScore.score(): Double =
    (1.0 / (detourMinutes + 1)) * 0.5 +
    (rating / 5.0) * 0.3 +
    (1.0 / (prepTimeMin + 1)) * 0.2
```

### 7.3 导航 Waypoint 集成（三种方式）

#### 方式 A：Petal Maps（鸿蒙车机）

```kotlin
val intent = Intent("com.huawei.maps.ACTION_ADD_WAYPOINT").apply {
    putExtra("waypoint_name", "KFC 人民路店")
    putExtra("waypoint_latitude", 31.2304)
    putExtra("waypoint_longitude", 121.4737)
    putExtra("source_app", "DriveEats")
}
context.startService(intent)
```

#### 方式 B：Google Maps for Auto（Intent 协议）

```kotlin
val uri = Uri.parse("google.navigation:q=${Uri.encode(address)}&waypoints=via")
val intent = Intent(Intent.ACTION_VIEW, uri).apply {
    setPackage("com.google.android.apps.maps")
}
context.startActivity(intent)
```

#### 方式 C：Android for Cars Navigation API（车机原生）

```kotlin
val navManager = carContext.getCarService(NavigationManager::class.java)
navManager.updateTrip(
    Trip.Builder()
        .addDestination(
            Destination.Builder()
                .setName("KFC 人民路店")
                .setAddress(address)
                .build(),
            TravelEstimate.Builder(
                Distance.create(3.2, Distance.UNIT_KILOMETERS),
                DateTimeWithZone.create(etaMillis, timeZone)
            ).build()
        )
        .build()
)
```

---

## 八、UI 层设计

所有 UI 严格遵守车机 Template 规范，避免自定义复杂布局。

### 8.1 订单确认屏

```kotlin
class OrderConfirmScreen(carContext: CarContext) : Screen(carContext) {
    override fun onGetTemplate(): Template {
        return PaneTemplate.Builder(
            Pane.Builder()
                .addRow(Row.Builder()
                    .setTitle("KFC 香辣鸡腿堡套餐")
                    .addText("大份 · 加辣")
                    .addText("¥32.00 · 绕路 3 分钟 · 预计 8 分钟到达")
                    .setImage(CarIcon.Builder(iconBitmap).build())
                    .build())
                .addRow(Row.Builder()
                    .setTitle("支付方式")
                    .addText("Visa **** 1234 (UberEats 绑定)")
                    .build())
                .addAction(Action.Builder()
                    .setTitle("确认支付")
                    .setBackgroundColor(CarColor.PRIMARY)
                    .setOnClickListener { confirmPayment() }
                    .build())
                .addAction(Action.Builder()
                    .setTitle("取消")
                    .setOnClickListener { finish() }
                    .build())
                .build()
        )
        .setTitle("确认订单")
        .setHeaderAction(Action.BACK)
        .build()
    }
}
```

### 8.2 订单追踪屏

```kotlin
class OrderTrackingScreen(carContext: CarContext) : Screen(carContext) {
    override fun onGetTemplate(): Template {
        return NavigationTemplate.Builder()
            .setNavigationInfo(
                RoutingInfo.Builder()
                    .setCurrentStep(
                        Step.Builder("前往 KFC 人民路店取餐")
                            .setCue(CarText.create("已下单，5 分钟后备好"))
                            .build(),
                        Distance.create(3.2, Distance.UNIT_KILOMETERS)
                    )
                    .build()
            )
            .setActionStrip(
                ActionStrip.Builder()
                    .addAction(Action.Builder()
                        .setTitle("订单详情")
                        .setOnClickListener { showOrderDetail() }
                        .build())
                    .addAction(Action.Builder()
                        .setTitle("取消订单")
                        .setOnClickListener { cancelOrder() }
                        .build())
                    .build()
            )
            .build()
    }
}
```

### 8.3 HUD 小卡片（常驻）

```
┌─────────────────────────────────────┐
│ 🍔 KFC · 5 min 后备好 · 3.2 km      │
│    Visa 1234 已支付 $13.70          │
└─────────────────────────────────────┘
```

---

## 九、性能优化

| 优化点 | 实现 | 预期收益 |
|---|---|---|
| 小艺技能预热 | 车机启动后预加载 DriveEats Skill | 唤醒到响应 < 500ms |
| LLM 分层推理 | 本地 Qwen2.5-3B 优先 + 云端兜底 | 90% 请求本地 < 500ms |
| 菜单预缓存 | 用户常用 Top 10 品牌菜单预取本地 SQLite | 菜单查询 < 50ms |
| API 并行调用 | 位置/路线/商户搜索 coroutine 并发 | 端到端 -2 到 3s |
| Prompt 缓存 | LLM 系统 Prompt 启用 prompt caching | 云端成本 -80% |
| MQTT 长连接 | 订单状态推送替代轮询 | 流量 -95%，实时性↑ |
| 支付方式缓存 | UberEats 绑定支付本地缓存 24h | 每单省 200ms |
| UI 使用 Template | Car App Library 原生 Template | 零卡顿 |

---

## 十、安全与合规

| 项 | 措施 |
|---|---|
| 驾驶安全 | 高速 (>80km/h) 强制语音模式，禁止复杂触屏交互 |
| 支付合规 | PCI-DSS token 化；UberEats 支付由其合规承担；金额>30 USD 强制生物识别 |
| 数据隐私 | GDPR/个保法合规；位置数据仅用于订单；用户画像本地加密存储 |
| API Key | Backend 代理；车机端永不下发真实 Key |
| 误触防护 | 支付前强制语音/生物识别确认；金额异常阈值拦截 |
| 账户安全 | OAuth 2.0；access_token 15min 过期；refresh_token 加密存储 |
| 离线降级 | 无网时语音提示"网络异常"并保存意图 |
| Driver Distraction | 符合 NHTSA Phase 2 规范；单次交互 ≤ 12 秒 |

---

## 十一、开发落地路线图

| 阶段 | 周期 | 交付物 | 里程碑 |
|---|---|---|---|
| **Phase 0: 前期准备** | 2 周 | UberEats API 合作签约；小艺 Skill 开发者申请；华为车机开发板到位 | 授权与设备就绪 |
| **Phase 1: 核心链路 MVP** | 6 周 | 小艺技能注册；一句话下单；UberEats 绑定支付跑通 | 单场景可演示 |
| **Phase 2: 导航与定位** | 4 周 | 沿途搜索；Petal Maps Waypoint；MQTT 订单推送 | 全场景可用 |
| **Phase 3: 多轮对话与 LLM** | 4 周 | 小艺 + LLM 分层 NLU；本地 Qwen2.5 上车；预取缓存 | 体验优化完成 |
| **Phase 4: 支付备选与异常处理** | 3 周 | 华为支付/Google Pay 备选路径；全部异常场景 | 可商用稳定性 |
| **Phase 5: 合规认证** | 3 周 | NHTSA distraction 测试；车厂安全认证 | 准生产就绪 |
| **Phase 6: 上车灰度发布** | 2 周 | OTA；灰度发布；监控体系 | 正式上线 |

**总工期**：约 24 周（6 个月）
**团队规模**：Android/HarmonyOS × 3 + Backend × 2 + LLM × 1 + QA × 2 + PM × 1

---

## 十二、关键 PoC 验证项

| # | 验证项 | 优先级 | 验证方式 |
|---|---|---|---|
| 1 | UberEats Marketplace API 车机场景授权 | P0 | 商务沟通 + 技术对接 |
| 2 | UberEats Payment Method API 支持机器下单 | P0 | API 文档审阅 + Sandbox 测试 |
| 3 | 小艺 Skills SDK 对第三方 App 开放度 | P0 | 华为官方文档 + 开发者咨询 |
| 4 | 小艺自定义 Slot 类型识别率 | P0 | 200 条真实语料测试 |
| 5 | 本地 Qwen2.5-3B 在车机 SoC 推理延迟 | P1 | SA8295 / 鸿蒙车机实测 |
| 6 | 沿途搜索算法准确率 | P1 | 真实路况 100 次下单对比 |
| 7 | 华为支付降级流程可用性 | P2 | 端到端场景验证 |
| 8 | 高速驾驶语音识别率 | P2 | 80-120 km/h 车内噪声测试 |

---

## 附录 A：关键 API 清单

### UberEats OpenAPI
- `POST /v1/eats/oauth/token` — OAuth 授权
- `GET /v1/eats/payment-methods` — 查询用户绑定支付方式
- `POST /v1/eats/stores/search` — 商户搜索（支持 along_route）
- `GET /v1/eats/stores/{id}/menu` — 菜单详情
- `POST /v1/eats/orders/draft` — 创建订单草稿
- `POST /v1/eats/orders/{id}/confirm` — 确认下单（使用绑定支付）
- `POST /v1/eats/orders/{id}/cancel` — 取消订单
- `GET /v1/eats/orders/{id}` — 订单状态查询

### 华为小艺 Skills SDK
- `XiaoyiSkillService` — 技能服务基类
- `XiaoyiIntent` / `XiaoyiSlot` — 意图与槽位
- `XiaoyiResponse.builder()` — 构建响应
- `DialogMode.CONTINUE_CONVERSATION` — 保持对话模式

### 华为 Location Kit / Petal Maps
- `FusedLocationProviderClient` — 融合定位
- `com.huawei.maps.ACTION_ADD_WAYPOINT` — 添加途经点

### Android for Cars App Library
- `PaneTemplate` / `NavigationTemplate` / `ListTemplate` — UI 模板
- `NavigationManager` — 导航管理

---

## 附录 B：术语表

| 术语 | 说明 |
|---|---|
| AAOS | Android Automotive OS |
| HMS | Huawei Mobile Services |
| NLU | Natural Language Understanding 自然语言理解 |
| ASR | Automatic Speech Recognition 语音识别 |
| TTS | Text-to-Speech 语音合成 |
| VAD | Voice Activity Detection 语音活动检测 |
| BFF | Backend For Frontend |
| OAuth | Open Authorization 开放授权协议 |
| PCI-DSS | 支付卡行业数据安全标准 |
| NHTSA | 美国国家公路交通安全管理局 |
| KWS | Keyword Spotting 唤醒词检测 |
| HUD | Head-Up Display 抬头显示 |

---

**文档维护**：该文档随项目进展持续更新
**反馈渠道**：DriveEats 项目组
