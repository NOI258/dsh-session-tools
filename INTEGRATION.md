# 集成说明（给 DSH agent 读）

> 最后更新：2026-11-27

人看的介绍在 [`README.md`](./README.md)，维护细节在 [`MAINTENANCE.md`](./MAINTENANCE.md)。这份只讲**怎么用、怎么验证、哪些坑会坑到你**。

---

## 0. 先确认一件事：这不是插件

本仓库是**四个独立 CLI 脚本**，没有 `cordis.patch.yml`，不注册任何工具。

- ❌ 不要 `dsh plugin add` 这个仓库——加了也不会出现工具
- ❌ 不要 `npm i` 这个仓库——没有发布 npm（`package.json` 里 `private: true`）
- ✅ 用 bash 直接调 `node <脚本> <参数>`

脚本零构建，Node 18+ 直接跑。唯一的外部依赖是 `check-md.cjs` 需要的 `yaml`。

---

## 1. 四个脚本

| 脚本 | 干什么 | 输出 |
|---|---|---|
| `export-session.mjs` | 把 DSH 会话的 zstd 事件流导出成可读 markdown | 一个 `.md` 文件 |
| `index-sessions.cjs` | 扫会话目录，生成 `INDEX.md` 总表 | 一个 `INDEX.md` |
| `check-md.cjs` | 校验「YAML 主体 + Markdown 附录」格式的文件 | 终端报告 |
| `search-sessions.mjs` | 在全部会话里搜关键词（消息级 AND，带缓存） | 终端命中行 / JSON |

### 调用方式

```bash
# 导出会话（输出路径可省略）
node /root/workspace/dsh-session-tools/export-session.mjs \
  "/root/.dsh/sessions/--root-workspace--/session-<完整id>" [输出路径]

# 生成索引（根目录和 --out 都可省略）
node /root/workspace/dsh-session-tools/index-sessions.cjs [会话根目录] [--out=<路径>]

# 校验文件格式
node /root/workspace/dsh-session-tools/check-md.cjs <文件路径> [--yaml-end=<结束标记>]
```

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常 |
| 1 | 检查发现失败项（`check-md`）或测试有失败 |
| 2 | 用法错误 / 依赖缺失 |

**看到 2 不代表目标文件有问题**，是参数或环境不对——先查参数，别急着改文件。

### 三个会坑到你的行为

1. **`export-session.mjs` 不给输出路径时，文件落在脚本所在目录**，不是当前工作目录。要可预测就永远显式给路径。
2. **`--out=` 和 `--yaml-end=` 的值里含 `=` 是安全的**（已修），但 `--out=` 指向的父目录**不会自动创建**。目录不存在就写失败。
3. **`--yaml-end=` 传空值是用法错误（exit 2）**，不会静默回退到默认规则。这是有意的。

---

## 2. 会话数据在哪

```
~/.dsh/sessions/<workspace>/session-<完整id>/session.v4.jsonl.zstd
```

- `<workspace>`：把工作目录路径的 `/` 换成 `-`。`/root/workspace` → `--root-workspace--`
- 文件是 zstd 压缩，**可能多帧**。Node 的 `zstdDecompressSync` 只解第一帧，多帧要先逐帧切开——脚本里已经处理了
- 是 append-only 事件流：`user/message`、`assistant/message`、`tool/call`、`session/title`

**别去** `~/.dsh/storages/session_projcache/` 找对话正文，那里只有投影状态。

### 读取顺序（成本从低到高）

1. 读 `~/.dsh/sessions/INDEX.md` —— 零成本，先看这个
2. 有 `resume-*.md` 摘要就读它 —— 几千 token
3. 只有需要具体某段时，才导出全文再 `grep` —— 几万 token，**别整份读进 context**

导 200+ 轮的会话是几万 token；长会话里每多读一份全文，后面的对话空间就少一块。

---

## 3. 验证（拿不准就先跑这个）

```bash
cd /root/workspace/dsh-session-tools && node test/run-tests.mjs; echo "exit=$?"
```

25 项检查。**全过说明脚本本身没坏**，问题在参数、路径或数据上。

这台机器上还实用地跑过一次真实数据复核：

```bash
node ~/.dsh/sessions/scan-sessions.cjs
# 然后确认 INDEX 里某个会话的轮数，和下面导出的轮数一致
node export-session.mjs "/root/.dsh/sessions/--root-workspace--/session-<id>" /tmp/chk.md
```

两个数字对不上就说明有一份索引脚本没同步——见第 4 节。

---

## 4. 本机上的特殊状况：索引脚本有两份

```
/root/workspace/dsh-session-tools/index-sessions.cjs     仓库正本
/root/.dsh/sessions/scan-sessions.cjs                    本机实际在用的分叉副本
```

**两份互不引用，改一边要手动同步另一边。** 后者功能是子集，但多了硬编码 TOPIC、当前会话标记、项目分片分类。

2026-11-27 出过一次：只在仓库版修了轮数统计，本机 `scan-sessions.cjs` 没修，INDEX 一直显示 25 轮、导出显示 23 轮。两处都已修，但结构没合并。

合并方案是把 `scan-sessions.cjs` 改成调 `index-sessions.cjs` 的薄包装，但会改动现有 INDEX 的章节结构，需要先确认能不能接受。**别自行合并。**

---

## 5. 已知不足（会影响你该不该用它）

- **`check-md.cjs` 不是通用 markdown 校验器。** 分段规则是「第一个顶层 `key:` 行开始，到独立 `---` 或全大写裸行结束」，照特定文件格式写的。结构不同就得改规则。
- **跟 DSH 事件字段名绑死**：`user/message`、`assistant/message`、`session`、`session/title`、`data.source.kind`、`data.message.content`。DSH 改格式就要跟着改，没有适配层。
- **索引只在本地扫目录**，不认远端、不增量，每次全量扫。
- **时间跨度取文件顺序的首尾事件**，不是时间戳 min/max。文件顺序若乱，跨度会显示成反的（实测的真实会话都是单调的，未改）。
- **测试是手搓的**，不是框架，加用例要重复样板代码，没有 coverage。

---

## 6. 别做的事

| 别这样 | 为什么 |
|---|---|
| `dsh plugin add` 这个仓库 | 没有 patch，注册不了任何东西 |
| 导出后整份读进 context | 几万 token，先 grep |
| 改完只跑一次测试就说"修好了" | 也要反向验证：把修复还原，确认测试会 FAIL |
| 自行合并两份索引脚本 | 会改 INDEX 结构，需先确认 |
| 看到 exit 2 就改源文件 | 多半是参数错了 |

**改代码之后的最低要求**：`node test/run-tests.mjs` 全绿 + 把修复临时还原确认对应断言会 FAIL + 拿真实会话复核一次。只跑一次全绿说明不了测试在测东西。
