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

**不发布 npm。** 三个脚本零构建，clone 下来直接跑：

```bash
git clone https://github.com/NOI258/dsh-session-tools
cd dsh-session-tools
node test/run-tests.mjs          # 先确认基线是绿的
node export-session.mjs <会话目录>
```

想长期放在 DSH 环境里用，把这个目录扔进工作区就行——它们是纯 CLI，
适合让 DSH agent 直接调：导出会话、重建索引、校验配置这类活本来就该排队交给它做。
`package.json` 只为本地 `npm pack` 和 bin 定义存在，`private` 已设为 true，防止误发。

Node 18+。前两个零依赖。

`check-md.cjs` 要 `yaml`：

```bash
npm i -g yaml
YAML_MODULE=/path/to/node_modules/yaml node check-md.cjs AGENTS.md
```

脚本会依次试 `require('yaml')`、`$YAML_MODULE`、几个全局路径。

## 运行环境

宿主是一台 **vivo Y300i**（型号 V2444A，平台 PD2444），Android 15、骁龙 4 Gen 2（4nm）、6500mAh 电池、12 GB 内存 / 256 GB 存储，没有电脑。终端用 Termux，Linux 环境跑在 proot 里。

容器内能查到的（`/proc`、`df` 实测，不是估计）：

- Ubuntu 24.04.5 LTS，aarch64，内核 5.10-gki
- 8 个核；`/proc/self/status` 的 `TracerPid` 非 0，proot 在跟踪
- 可见内存 11.1 GiB，根分区 224 GiB（已用 90%）
- Node v24.22.1、npm 11.19.1

容器里没有 `getprop`，所以上面这些是机主说明 + 手机端实测补的（2026-11-27）：`ro.product.model=V2444A`、`ro.product.device=PD2444`、`ro.build.version.release=15`、`ro.board.platform=parrot`。

三个脚本只用 Node 标准库，`check-md.cjs` 额外需要 `yaml`。这不是硬性要求，只说明「实际验证过的组合」：Node 18+ 理论上都能跑，但只有上面那套是实测过的。

## 不足

按影响排序。详细维护说明见 [MAINTENANCE.md](./MAINTENANCE.md)。

**1. 索引脚本有两份，会分叉**
仓库里的 `index-sessions.cjs` 和本机实际在用的 `~/.dsh/sessions/scan-sessions.cjs` 是两个独立实现，互不引用。后者功能是子集（没有 `--out`、没有文件版本选择、合并键没有首问），但多了硬编码 TOPIC、当前会话标记、项目分片分类。改了这边忘了那边，就会出现在 INDEX 里写 25 轮、导出写 23 轮的情况——2026-11-27 踩过一次。合并方案写在 MAINTENANCE 里，会改动现有 INDEX 结构所以还没做。

**2. `check-md.cjs` 的分段规则是特化的**
它认「第一个顶层 `key:` 行开始，到独立 `---` 或全大写裸行结束」。文件结构不一样就得改规则。它判得了「格式坏没坏」，判不了「内容对不对」。

**3. 跟 DSH 事件流的字段名绑死**
依赖 `user/message`、`assistant/message`、`session`、`session/title`、`data.source.kind`、`data.message.content`。DSH 改格式就得跟着改，没有适配层。多帧 zstd 的解码也是照当前格式写的。

**4. 索引只在本地扫目录**
不认远端会话，不增量更新，每次全量扫。会话多了会变慢（实测几十个目录在手机上是几秒级）。

**5. 导出大会话很吃 context**
导 200+ 轮的会话是几万 token。所以顺序应该是：先看 INDEX（零成本）→ 要摘要读 `resume-*.md` → 要具体某段才导出全文再 grep，别整份读。

**6. 时间跨度取文件顺序的首尾事件，不是时间戳 min/max**（未确认风险）
`f0`/`l0` 按事件顺序取第一个/最后一个时间。文件顺序若被打乱，跨度会显示成反的。实测的真实会话都是单调的，所以没改；要改成 min/max 只是两行的事。

**7. 测试是手搓的，不是框架**
`test/run-tests.mjs` 造临时数据、起子进程、读输出断言。够用，但加用例要重复样板代码，也没有 coverage 统计。

---

MIT
