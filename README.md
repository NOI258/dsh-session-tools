# dsh-session-tools

DeepSeek Harness（DSH）的会话工具集：**把存盘的事件流变成能整理、能校验的东西。**

DSH 把每个会话存成 append-only 的 JSONL 事件流，zstd 压缩，放在 `~/.dsh/sessions/` 下。默认没有任何查看工具。于是有三个现实问题：

- 聊到上下文满了，之前聊了什么，查不到
- 会话攒到几十个，记不住哪个 id 是哪件事
- 配置文件改完，不知道坏没坏

这三个脚本对应这三件事。

---

## 工具

### `index-sessions.cjs` — 会话索引

扫描所有会话，提取时间跨度、轮数、大小、主题，按类型分类生成一张 `INDEX.md`。

```bash
node index-sessions.cjs                    # 默认扫 ~/.dsh/sessions
node index-sessions.cjs /path/to/sessions --out=INDEX.md
```

处理了三个容易踩的点：

- **自动标题不可靠**。有些标题是模型自己起的（`idk`），跟内容无关。标题无意义时改用首问。
- **空壳会话**。打开但没说话的会话只有几条初始化事件，单独归一类。
- **重复短会话**。同一件事反复开的会话按内容前缀合并，避免刷屏。

### `export-session.mjs` — 导出成可读 Markdown

把事件流导成对话记录：只保留真人发言和模型正文，工具调用压成一行摘要，跳过系统注入和 reasoning。

```bash
node export-session.mjs ~/.dsh/sessions/--root-workspace--/session-abc12345
node export-session.mjs ~/.dsh/sessions/.../session.v4.jsonl.zstd out.md
```

会自己找目录里的事件流文件，不假设固定文件名。输出默认写到当前目录的 `dialog-<短id>.md`。

### `check-md.cjs` — 校验「YAML 主体 + Markdown 附录」格式

这个格式的设计好处是结构清晰、可被程序解析；代价是**主体区必须是合法 YAML**。手动改的时候很容易把 Markdown 表格或编号列表插进去，结果是解析失败，或者更糟——被 YAML 当成普通字符串静默吞掉。

```bash
node check-md.cjs AGENTS.md
node check-md.cjs AGENTS.md --yaml-end=END_OF_CONFIG
```

检查项：

| 检查 | 说明 |
|---|---|
| 分段 | 找到 YAML 主体和 Markdown 区的边界 |
| YAML 解析 | 重复键视为错误 |
| 主体区污染 | 表格行、编号列表、粗体列表 |
| 空值 | 空字符串、空数组 |
| 层表自洽 | 存在 `layer_order.layers` 时检查升序/唯一/连续 |
| 代码块 | 每个 ` ```yaml ` 块单独解析 |
| 章节引用 | 「第 N 节」是否都有对应的 `# N. ` 声明 |

---

## 一个真实案例：检查器自己出了假阴性

第一版的分段规则是「遇到非法行就结束 YAML 主体」。

测试时构造了一个坏样本——在 YAML 区插了个 Markdown 表格——结果**检查器报全部通过**。

原因是：表格前面那行 `本文件多层叠加。` 是顶格裸文本，被当成了分段边界。于是污染行被划到 Markdown 区，不在检测范围内。

**错误被切到检测范围之外了。**

修法：分段只认**显式结束标记**（独立 `---` 行，或 `END_OF_XXX` 这种全大写裸行）。非法行不结束分段，留在 YAML 区里，被解析和污染检测抓出来。

修完后：

```
正本      9 项全过  exit=0
坏样本    2 项 FAIL  exit=1（YAML 解析 + 表格污染）
```

这个案例说明一件事：**检查器报「全过」这个结果本身也需要验证。** 用确认坏掉的样本去测，才叫验证；用「应该没问题」的文件去测，只是走个过场。

---

## 安装

Node.js 18 以上。前两个脚本零依赖。

`check-md.cjs` 需要 `yaml` 模块：

```bash
npm i -g yaml
# 或者指定路径
YAML_MODULE=/path/to/node_modules/yaml node check-md.cjs AGENTS.md
```

脚本会依次尝试 `require('yaml')`、`$YAML_MODULE`、几个常见的全局安装路径。

---

## 局限

说清楚，免得期待错位：

- **只管格式，不管内容。** `check-md.cjs` 能告诉你「文件坏了」，不能告诉你「这段规则写得好不好」。
- **检查项针对特定格式。** 它假设文件是「YAML 主体 + Markdown 附录」这个结构。别的结构要先改分段规则。
- **没有测试框架。** 验证靠手搓样本，靠每次改完跑一遍。
- **和 DSH 的内部格式耦合。** `export-session` 和 `index-sessions` 依赖事件流的 `type` 字段命名（`user/message`、`assistant/message`、`session/title`）。DSH 改格式的话要跟着改。

---

## License

MIT
