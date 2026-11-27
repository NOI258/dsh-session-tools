# dsh-session-tools

DSH 把每个会话存成 zstd 压缩的 JSONL 事件流，扔在 `~/.dsh/sessions/` 下，没有查看工具。

所以我写了三个脚本。

- `index-sessions.cjs` — 几十个会话里找哪个是哪个
- `export-session.mjs` — 把事件流导出成能读的对话
- `check-md.cjs` — 改完配置文件确认没改坏

改这个仓库之前先看 [MAINTENANCE.md](./MAINTENANCE.md)：分支怎么推、测试怎么验、哪些坑已经踩过。

---

## index-sessions.cjs

```bash
node index-sessions.cjs
node index-sessions.cjs /path/to/sessions --out=INDEX.md
```

扫一遍会话目录，生成一张表：id、时间跨度、轮数、大小、主题。

三个坑：

自动标题不能信。有些会话标题是 `idk`，跟内容毫无关系，所以我加了判断——标题无意义就改用首问。

空壳要单独拎出来。打开但没说话的会话只有几条初始化事件，混在短会话里很难看。

短会话要合并。同一件事反复开的会话按内容前缀并成一行，不然表会长得没法看。

## export-session.mjs

```bash
node export-session.mjs ~/.dsh/sessions/--root-workspace--/session-abc12345
node export-session.mjs ~/.dsh/sessions/.../session.v4.jsonl.zstd out.md
```

只留真人发言和模型正文。工具调用压成一行摘要，系统注入和 reasoning 全丢。

事件流文件名不固定（`session.v4`、`session.v5` 都可能），脚本会自己找。

## check-md.cjs

```bash
node check-md.cjs AGENTS.md
node check-md.cjs AGENTS.md --yaml-end=END_OF_CONFIG
```

这个格式——YAML 主体 + Markdown 附录——结构清楚，代价是主体区必须是合法 YAML。手动改的时候插个表格进去，轻则解析失败，重则被 YAML 当成普通字符串吞掉，等发现的时候已经面目全非了。

所以需要跑一遍。检查项：分段对不对、YAML 能不能解析、主体区有没有混进表格或编号列表、有没有空字段、`layer_order.layers` 自不自洽、代码块单独解析、章节引用是否有对应声明。

---

## 一个让我改了两次的坑

第一版分段规则是「遇到非法行就结束 YAML 主体」。

然后我造了个坏样本——在 YAML 区插个表格——跑出来**全部通过**。

因为表格上面那行是顶格裸文本，被当成了分段边界。污染行就这么被划到 Markdown 区，不在检测范围里了。

错误被切到检测范围之外。

改成只认显式结束标记：独立 `---` 行，或者 `END_OF_XXX` 这种全大写裸行。非法行不结束分段，留在里面让解析器抓。

修完：

```
正本      9 项全过  exit=0
坏样本    2 项 FAIL  exit=1
```

结论就一句：**检查器说「全过」的时候，先确认它真的在看。** 拿确定坏掉的东西去测，才叫验证。

---

## 装

Node 18+。前两个零依赖。

`check-md.cjs` 要 `yaml`：

```bash
npm i -g yaml
YAML_MODULE=/path/to/node_modules/yaml node check-md.cjs AGENTS.md
```

脚本会依次试 `require('yaml')`、`$YAML_MODULE`、几个全局路径。

## 运行环境

宿主是一台 Android 15 手机（骁龙 4 Gen 2，12 GB 内存 / 256 GB 存储），没有电脑。终端用 Termux，Linux 环境跑在 proot 里。

容器内能查到的（`/proc`、`df` 实测，不是估计）：

- Ubuntu 24.04.5 LTS，aarch64，内核 5.10-gki
- 8 个核；`/proc/self/status` 的 `TracerPid` 非 0，proot 在跟踪
- 可见内存 11.1 GiB，根分区 224 GiB（已用 90%）
- Node v24.22.1、npm 11.19.1

Android 版本、SoC 型号、整机容量在容器里查不到（没有 `getprop`），这部分按机主说明。

三个脚本只用 Node 标准库，`check-md.cjs` 额外需要 `yaml`。这不是硬性要求，只说明「实际验证过的组合」：Node 18+ 理论上都能跑，但只有上面那套是实测过的。

## 不做的部分

- 不管内容好不好。`check-md.cjs` 只能说文件坏没坏，说不了规则写得对不对。
- 检查项是照我的文件格式写的。你的结构不一样就得改分段规则。
- 没测试框架。验证靠手搓样本。
- 跟 DSH 事件流的字段名绑着（`user/message`、`session/title` 这些）。格式变了要跟着改。

---

MIT
