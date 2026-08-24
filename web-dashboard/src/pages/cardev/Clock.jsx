import React, { useEffect, useRef } from "react";

/**
 * 毫秒级时钟（YYYY-MM-DD HH:mm:ss.SSS）。
 * 通过 requestAnimationFrame + 直接写 textContent 更新，避免 60fps 触发 React 重渲染。
 */
export default function Clock({ className = "" }) {
  const ref = useRef(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const n = new Date();
        el.textContent =
          n.getFullYear() + "-" +
          String(n.getMonth() + 1).padStart(2, "0") + "-" +
          String(n.getDate()).padStart(2, "0") + " " +
          String(n.getHours()).padStart(2, "0") + ":" +
          String(n.getMinutes()).padStart(2, "0") + ":" +
          String(n.getSeconds()).padStart(2, "0") + "." +
          String(n.getMilliseconds()).padStart(3, "0");
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <span ref={ref} className={`font-mono tabular-nums ${className}`} />;
}
