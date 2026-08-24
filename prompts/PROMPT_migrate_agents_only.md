# 仅重构 AGENTS 与 Skill 路由的轻量 Prompt

在不改产品业务代码、不改数据库和 UI 的前提下：

1. 用本包 `AGENTS.md` 替换当前根规则；
2. 安装三个 Skill：acceptance-router、project-engineering-acceptance、runtime-story-point-assurance；
3. 安装两个只读 reviewer；
4. 搜索旧 `$story-acceptance-protocol` 的文档/Prompt 引用，只做兼容别名和 deprecated 提示，不改变运行代码；
5. 输出旧规则到新协议的映射清单；
6. 校验 Skill frontmatter、TOML 和相对路径；
7. 不运行完整构建，只执行与配置真实性直接相关的轻量检查；
8. 将仓库规则改动单独提交，不与产品代码混合。
