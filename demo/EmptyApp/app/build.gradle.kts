import java.util.Properties

plugins {
    id("com.android.application")
}

// 从 local.properties 读签名配置（密钥/密码不入库；keystore 文件也 gitignore）。
// 需要在 local.properties 配：
//   mtk8678.storeFile=mtk8678.keystore
//   mtk8678.storePassword=...
//   mtk8678.keyAlias=...
//   mtk8678.keyPassword=...
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val mtkStoreFile: String? = localProps.getProperty("mtk8678.storeFile")
val hasMtkSigning: Boolean = mtkStoreFile != null && rootProject.file(mtkStoreFile).exists()

android {
    namespace = "com.test.emptyapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.test.emptyapp"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        // avatr8678 平台签名（与真机应用市场同签名）。配置/keystore 缺失时不创建此 config，构建仍可走默认签名。
        if (hasMtkSigning) {
            create("mtk8678") {
                storeFile = rootProject.file(mtkStoreFile!!)
                storePassword = localProps.getProperty("mtk8678.storePassword")
                keyAlias = localProps.getProperty("mtk8678.keyAlias")
                keyPassword = localProps.getProperty("mtk8678.keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 有平台签名则用之（与真机应用市场同签名、可装、非 debuggable 更准）；否则走默认（release 未签名）。
            if (hasMtkSigning) signingConfig = signingConfigs.getByName("mtk8678")
        }
        debug {
            if (hasMtkSigning) signingConfig = signingConfigs.getByName("mtk8678")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// 极简空 App：不引入任何 AndroidX / Kotlin / 三方库，
// 让"点击图标→红屏可见"的耗时尽量只反映系统/launcher 的启动底座。
dependencies {
}
