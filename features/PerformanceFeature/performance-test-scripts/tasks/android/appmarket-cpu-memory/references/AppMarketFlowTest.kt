package com.example.appmarkettest

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.regex.Pattern

/**
 * Cross-app black-box flow for com.appmarket.automotive.
 *
 * Replace every placeholder resource id below with the actual id exposed by
 * `adb shell uiautomator dump /sdcard/window.xml` or UI Automator Viewer.
 * Prefer resource ids over display coordinates and localized text.
 */
@RunWith(AndroidJUnit4::class)
class AppMarketFlowTest {

    companion object {
        private const val APP_MARKET_PACKAGE = "com.appmarket.automotive"
        private const val WAIT_MS = 30_000L
        private const val INSTALL_WAIT_MS = 120_000L

        // Resource entry names only, without "com.appmarket.automotive:id/".
        // These are placeholders and must be replaced for the actual app.
        private const val HOME_ROOT_ID = "replace_home_root"
        private const val HOME_APP_CARD_ID = "replace_app_card"
        private const val DETAIL_ROOT_ID = "replace_detail_root"
        private const val DETAIL_SCROLL_CONTAINER_ID = "replace_detail_scroll_container"
        private const val DOWNLOAD_BUTTON_ID = "replace_download_button"
        private const val HOME_TAB_ID = "replace_home_tab"
        private const val MY_TAB_ID = "replace_my_tab"
        private const val MY_ROOT_ID = "replace_my_root"

        // Use a fixed, small test package when possible. Leaving this blank
        // selects the first visible app card, which is less reproducible.
        private const val FIXED_TEST_APP_TITLE = ""

        // Whitelist the menus that are safe to browse. Do not blindly click all
        // clickable nodes: logout, factory reset, purchase, and delete actions
        // can also appear as clickable rows.
        private val SECONDARY_MENU_IDS = listOf(
            "replace_menu_downloads",
            "replace_menu_updates",
            "replace_menu_settings",
        )

        private val INSTALL_ACTION_TEXT = Pattern.compile(
            "^(安装|继续安装|允许|确定|Install|Continue|Allow|OK)$",
            Pattern.CASE_INSENSITIVE,
        )
        private val INSTALLED_STATE_TEXT = Pattern.compile(
            "^(打开|已安装|Open|Installed)$",
            Pattern.CASE_INSENSITIVE,
        )
    }

    private lateinit var device: UiDevice
    private lateinit var targetContext: Context

    @Before
    fun setUp() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        device = UiDevice.getInstance(instrumentation)
        targetContext = instrumentation.targetContext
        device.wakeUp()
    }

    @Test
    fun browseDownloadInstallAndVisitMyMenus() {
        try {
            startAppMarket()
            waitForResource(HOME_ROOT_ID, WAIT_MS)

            openDeterministicAppDetail()
            waitForResource(DETAIL_ROOT_ID, WAIT_MS)
            scrollDetailToBottom()

            clickResource(DOWNLOAD_BUTTON_ID, WAIT_MS)
            handleInstallerOrInMarketConfirmation()
            returnToAppMarketHome()

            clickResource(MY_TAB_ID, WAIT_MS)
            waitForResource(MY_ROOT_ID, WAIT_MS)
            browseWhitelistedSecondaryMenus()
        } catch (error: Throwable) {
            saveFailureArtifacts()
            throw error
        }
    }

    private fun startAppMarket() {
        val launchIntent = targetContext.packageManager
            .getLaunchIntentForPackage(APP_MARKET_PACKAGE)
            ?: error("No launcher activity found for $APP_MARKET_PACKAGE")

        launchIntent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TASK,
        )
        targetContext.startActivity(launchIntent)

        assertTrue(
            "App market did not become visible",
            device.wait(Until.hasObject(By.pkg(APP_MARKET_PACKAGE).depth(0)), WAIT_MS),
        )
    }

    private fun openDeterministicAppDetail() {
        if (FIXED_TEST_APP_TITLE.isNotBlank()) {
            val title = device.wait(
                Until.findObject(By.text(FIXED_TEST_APP_TITLE)),
                WAIT_MS,
            ) ?: error("Cannot find fixed test app: $FIXED_TEST_APP_TITLE")
            clickSelfOrClickableParent(title)
            return
        }

        assertTrue(
            "No app cards appeared on the home page",
            device.wait(
                Until.hasObject(By.res(APP_MARKET_PACKAGE, HOME_APP_CARD_ID)),
                WAIT_MS,
            ),
        )
        val cards = device.findObjects(By.res(APP_MARKET_PACKAGE, HOME_APP_CARD_ID))
        val card = cards.firstOrNull { it.isClickable } ?: cards.firstOrNull()
            ?: error("No app card object was returned")
        clickSelfOrClickableParent(card)
    }

    private fun scrollDetailToBottom() {
        val selector = By.res(APP_MARKET_PACKAGE, DETAIL_SCROLL_CONTAINER_ID)
        val container = device.findObject(selector) ?: device.findObject(By.scrollable(true))

        if (container != null) {
            // Stop when UI Automator reports that no further scroll was made,
            // but keep a hard limit to avoid an infinite loop on carousels.
            repeat(20) {
                val moved = container.scroll(Direction.DOWN, 0.85f)
                SystemClock.sleep(300)
                if (!moved) return
            }
            return
        }

        // Last-resort coordinate swipe. Resource-based scrolling is preferred.
        val x = device.displayWidth / 2
        val startY = (device.displayHeight * 0.80).toInt()
        val endY = (device.displayHeight * 0.20).toInt()
        repeat(12) {
            device.swipe(x, startY, x, endY, 24)
            SystemClock.sleep(300)
        }
    }

    private fun handleInstallerOrInMarketConfirmation() {
        val deadline = SystemClock.uptimeMillis() + INSTALL_WAIT_MS
        var sawInstallAction = false

        while (SystemClock.uptimeMillis() < deadline) {
            // UI Automator can operate on the system package installer as well
            // as the target app. This handles common localized confirmation UI.
            val action = device.findObject(By.text(INSTALL_ACTION_TEXT))
            if (action != null && action.isEnabled) {
                clickSelfOrClickableParent(action)
                sawInstallAction = true
                SystemClock.sleep(800)
                continue
            }

            if (device.hasObject(By.text(INSTALLED_STATE_TEXT))) {
                return
            }

            // Some automotive stores install silently and return to the detail
            // page. In that case, a changed/disabled download control can be a
            // better completion selector; add that app-specific check here.
            if (sawInstallAction && device.hasObject(By.pkg(APP_MARKET_PACKAGE))) {
                SystemClock.sleep(1_000)
            } else {
                SystemClock.sleep(500)
            }
        }

        error(
            "Installation did not reach an Installed/Open state within " +
                "${INSTALL_WAIT_MS / 1000}s. Replace the completion selector " +
                "with the actual app-market state if installation is silent.",
        )
    }

    private fun returnToAppMarketHome() {
        repeat(6) {
            if (device.hasObject(By.res(APP_MARKET_PACKAGE, HOME_ROOT_ID))) return

            val homeTab = device.findObject(By.res(APP_MARKET_PACKAGE, HOME_TAB_ID))
            if (homeTab != null) {
                homeTab.click()
            } else {
                device.pressBack()
            }
            SystemClock.sleep(500)
        }
        waitForResource(HOME_ROOT_ID, WAIT_MS)
    }

    private fun browseWhitelistedSecondaryMenus() {
        SECONDARY_MENU_IDS.forEach { menuId ->
            // Re-find every row after returning; old UiObject2 instances become
            // stale when the page hierarchy changes.
            clickResource(menuId, WAIT_MS)
            SystemClock.sleep(2_000) // Dwell time: define in the test protocol.

            device.pressBack()
            waitForResource(MY_ROOT_ID, WAIT_MS)
        }
    }

    private fun clickResource(resourceEntryName: String, timeoutMs: Long) {
        val item = device.wait(
            Until.findObject(By.res(APP_MARKET_PACKAGE, resourceEntryName)),
            timeoutMs,
        ) ?: error("Cannot find resource: $APP_MARKET_PACKAGE:id/$resourceEntryName")
        clickSelfOrClickableParent(item)
    }

    private fun waitForResource(resourceEntryName: String, timeoutMs: Long) {
        assertTrue(
            "Timed out waiting for $APP_MARKET_PACKAGE:id/$resourceEntryName",
            device.wait(
                Until.hasObject(By.res(APP_MARKET_PACKAGE, resourceEntryName)),
                timeoutMs,
            ),
        )
    }

    private fun clickSelfOrClickableParent(original: UiObject2) {
        var current: UiObject2? = original
        repeat(6) {
            val candidate = current ?: return@repeat
            if (candidate.isClickable && candidate.isEnabled) {
                candidate.click()
                return
            }
            current = candidate.parent
        }
        original.click()
    }

    private fun saveFailureArtifacts() {
        val outputDir = File(targetContext.getExternalFilesDir(null), "uiautomator-failures")
        outputDir.mkdirs()
        val stamp = System.currentTimeMillis()
        device.takeScreenshot(File(outputDir, "failure-$stamp.png"))
        device.dumpWindowHierarchy(File(outputDir, "failure-$stamp.xml"))
    }
}
