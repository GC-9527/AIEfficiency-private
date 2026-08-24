export const NEW_STORY_TABS = Object.freeze([
  { id: "tb", label: "从 TB 单新建" },
  { id: "blank", label: "新建空白故事点" },
  { id: "backup", label: "从备份还原" },
  { id: "git-commit", label: "从 git commit 创建" },
  { id: "git-commit-batch", label: "从 git commit 批量创建" },
  { id: "history", label: "故事点历史列表" },
]);

export const DEFAULT_NEW_STORY_TAB = NEW_STORY_TABS[0].id;
