package com.test.emptyapp;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;

/**
 * 极简空红页 Activity。
 *
 * 用途：在车机上测量"点击应用图标 -> 看到红色首页"的耗时（高速摄像机抓红屏出现时刻），
 * 以此推动系统 launcher / framework 优化冷启动底座。本 App 自身逻辑趋近于零，
 * 故测出的时间基本是 系统点击响应 + 进程 fork + 窗口创建/合成 的开销。
 *
 * 双保险红屏：
 *  - 主题 windowBackground = 红（启动窗口 starting window 即红，最早可见，几乎不含 App 代码耗时）；
 *  - 内容视图也设红（即便某些 ROM 禁了 starting window 也保证红屏）。
 *
 * logcat（TAG=EMPTY_APP_PERF）打点用于和摄像机交叉对账：
 *  - onCreate @ +Xms（相对进程启动）
 *  - firstFrame @ +Yms（首帧绘制完成 ≈ 红屏可见，相对进程启动）
 * 摄像机量的是 点击->红屏；二者之差 ≈ 点击->进程启动（系统/launcher 的 fork 段）。
 */
public class MainActivity extends Activity {

    private static final String TAG = "EMPTY_APP_PERF";

    private static long processStartElapsed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            return Process.getStartElapsedRealtime();
        }
        return SystemClock.elapsedRealtime();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        final long t0 = processStartElapsed();
        final long onCreateAt = SystemClock.elapsedRealtime();
        super.onCreate(savedInstanceState);

        // 纯红内容页（最小布局）。
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.RED);
        setContentView(root);

        Log.i(TAG, "onCreate @ +" + (onCreateAt - t0) + "ms (processStart=" + t0 + ")");

        // 首帧绘制完成打点（≈用户看到红屏）。
        final View decor = getWindow().getDecorView();
        decor.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
            @Override
            public boolean onPreDraw() {
                decor.getViewTreeObserver().removeOnPreDrawListener(this);
                decor.post(new Runnable() {
                    @Override
                    public void run() {
                        long firstFrame = SystemClock.elapsedRealtime();
                        Log.i(TAG, "firstFrame(red visible) @ +" + (firstFrame - t0) + "ms");
                    }
                });
                return true;
            }
        });
    }
}
