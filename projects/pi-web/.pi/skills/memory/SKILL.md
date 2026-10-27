---
name: memory
description: 管理当前项目的 SQLite 长期记忆。用户要求保存、搜索、修正或列出项目记忆时使用。
---

# 项目记忆

使用 `.pi/skills/memory/scripts/memory.py`，数据库为 `$PI_CODING_AGENT_DIR/pi-web-memory.sqlite`，默认位于 `~/.pi/agent/`，首次操作自动初始化。结构定义在 `data/schema.sql`。

## 保存与搜索

```bash
python3 .pi/skills/memory/scripts/memory.py add-memory "需要记住的项目事实" \
  --category decision --importance 4 --cwd /absolute/project/path --project project-name \
  --session-id current-session-id --session-name "当前会话名称"

python3 .pi/skills/memory/scripts/memory.py search "关键词" --project project-name
```

- 新增时必须带当前 `--cwd` 和由目录名得到的 `--project`，不能把不同项目的事实混在一起。
- 有活动 Pi 会话时，从原生会话头与命名元数据取得 `--session-id`、`--session-name`，保留事实来源；没有会话时省略。
- 用户明确要求记住的普通项目事实直接保存。财务、健康、法律、身份、地址和私密文档等敏感信息先确认；不保存密码、密钥、验证码、助记词或完整卡号。
- 召回结果先看 `created_at` 并用当前代码验证，旧记忆只是线索。发现过时时新增修正事实，必要时归档旧项。
- 结构调整通过 `schema-change`，保留已有记忆，优先采用增量变更。
