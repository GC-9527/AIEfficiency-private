/**
 * 记忆树冷启动预置 25 节点（方案 §7.3）
 *
 * 结构：root + 8 大类 + 若干模式节点
 * level: 0=root / 1=大类 / 2=模式
 */

export const PRESET_TREE = {
  title: "root",
  children: [
    {
      title: "音频类",
      children: [
        { title: "焦点管理（AudioFocus）" },
        { title: "播放中断" },
        { title: "路由异常（A2DP/USB/本地）" },
      ],
    },
    {
      title: "渲染/UI 类",
      children: [
        { title: "Surface / SurfaceView" },
        { title: "适配 / 分辨率" },
        { title: "动画 / 卡顿" },
      ],
    },
    {
      title: "权限 / 安全类",
      children: [
        { title: "Runtime Permission" },
        { title: "Permission Denied" },
      ],
    },
    {
      title: "稳定性类",
      children: [
        { title: "ANR" },
        { title: "Native Crash" },
        { title: "Java Crash" },
        { title: "OOM" },
      ],
    },
    {
      title: "兼容性类",
      children: [
        { title: "Android 版本" },
        { title: "AAOS 特性（CarService 等）" },
        { title: "厂商定制" },
      ],
    },
    {
      title: "网络 / 通信类",
      children: [
        { title: "请求超时" },
        { title: "DNS / 代理" },
      ],
    },
    {
      title: "环境 / 硬件（非问题）",
      children: [
        { title: "设备硬件故障" },
        { title: "网络环境" },
        { title: "测试环境配置" },
      ],
    },
    {
      title: "其他",
      children: [{ title: "待归类" }],
    },
  ],
};

/**
 * 把预置树写入 memory_tree（幂等：已有同名同 level 节点跳过）
 *
 * @param {Object} db - better-sqlite3 Database 实例（app.db 或 common.db 视调用场景）
 * @returns {{ created: number, skipped: number }}
 */
export function seedPresetTree(db) {
  const insertNode = db.prepare(
    `INSERT INTO memory_tree (parent_id, level, title, summary, weight, status)
     VALUES (?, ?, ?, ?, 1.0, 'active')`
  );
  const findNode = db.prepare(
    "SELECT id FROM memory_tree WHERE (parent_id IS ? OR parent_id = ?) AND title = ? AND level = ?"
  );

  let created = 0, skipped = 0;

  function walk(parent_id, parent_level, node) {
    const level = parent_level + 1;
    const title = node.title;
    const existing = findNode.get(parent_id, parent_id, title, level);
    let node_id;
    if (existing) {
      node_id = existing.id;
      skipped++;
    } else {
      const info = insertNode.run(parent_id, level, title, node.summary || null);
      node_id = info.lastInsertRowid;
      created++;
    }
    for (const child of node.children || []) walk(node_id, level, child);
  }

  // root 单独处理（parent_id=NULL, level=0）
  const rootExisting = findNode.get(null, -1, PRESET_TREE.title, 0);
  let root_id;
  if (rootExisting) {
    root_id = rootExisting.id;
    skipped++;
  } else {
    const info = insertNode.run(null, 0, PRESET_TREE.title, null);
    root_id = info.lastInsertRowid;
    created++;
  }
  for (const child of PRESET_TREE.children) walk(root_id, 0, child);

  return { created, skipped };
}
