# 维护备注

README 讲「怎么用」，这份讲**怎么改、怎么验、哪里会踩**。给自己以后回来看的。

最后更新：2026-11-27

---

## 一、分支：默认分支是 `main`，但推送习惯是 `master`

远端有两条分支，而且都在用：

| 分支 | 角色 |
|---|---|
| `main` | GitHub 上的默认分支，clone / 网页首页看到的都是它 |
| `master` | 实际推代码的地方 |

**问题**：只推 `master` 时，GitHub 首页显示的提交不会变，看起来像没推上去。2026-11-27 这次就是这样——`master` 已经有 `ddc2b68`，`main` 还停在 `8a672aa`。

**现在的规矩**：推完 `master` 立刻 fast-forward 一次 `main`。

```bash
cd ~/workspace/dsh-session-tools
TOKEN=$(cat /root/.dsh/.github_token)

# 推 master
git push "https://x-access-token:${TOKEN}@github.com/NOI258/dsh-session-tools.git" HEAD:master

# main 跟上（--force 不需要，-f 只在确认 main 没别人的提交时才用）
git push "https://x-access-token:${TOKEN}@github.com/NOI258/dsh-session-tools.git" HEAD:main

# 确认两条都指同一个提交
git ls-remote "https://x-access-token:${TOKEN}@github.com/NOI258/dsh-session-tools.git"
```

本地仓库没有配 upstream tracking（`git status -sb` 只显示 `## master`，没有 `[ahead N]`），所以看不出跟远端的差距。别依赖 `git status` 判断推没推上去，用 `git ls-remote` 比哈希。

要彻底省事，就在 GitHub 网页上把默认分支改成 `master`，然后固定只推 `master`。

---

## 二、改一次的标准流程

1. **先跑一遍现状**，确认基线是绿的
   ```bash
   node test/run-tests.mjs; echo "[exit: $?]"
   ```
2. 改代码
3. **加回归测试**——每个修复对应一个用例，断言写在「修好之后应该成立」的那一侧
4. **反向验证**：把修复临时还原成旧写法，重跑，确认新测试 **FAIL**
5. 恢复代码，再跑一次，全绿
6. commit → 推 `master` → FF `main`
7. **拿真实数据复核一次**，别只用造出来的样本

第 4 步别省。测试全绿只能说明「没坏」，说明不了「测到了」。这套测试真实踩过：反向验证时 3 项 FAIL，恢复后 18/18。

第 7 步也别省。造的数据往往太干净——轮数那次的 bug 在合成样本里不出现，是拿真实会话（`ce81bd26`）跑出来才暴露的。

---

## 三、测试

```bash
node test/run-tests.mjs      # 25 项；exit 0 = 全过，1 = 有失败
```

三个脚本都不是库，只能当命令跑，所以测试是「造临时数据 → 起子进程 → 读输出断言」。临时目录在 `/tmp/dst-test-*`，跑完自动删。

| 用例 | 断言数量 | 防的是哪个曾经出过的错 |
|---|---|---|
| 1. 短会话合并键 | 3 | 同标题同轮数但内容不同的两个会话被并成一行 |
| 2. 动态围栏 | 5 | 正文里有未闭合的 ` ``` `，把后面所有轮次吞进同一个代码块 |
| 3. 轮数一致性 | 5 | 空正文用户消息让头部轮数比实际 `^===== USER` 行数多，轮号还跳 |
| 4. check-md 结束标记 | 5 | 显式 `--yaml-end` 找不到时静默回退默认规则，把错误切到检测范围外 |
| 5. check-md 边界写法 | 5 | 顶层键带值认不出起点、`--yaml-end=` 空值静默回退、CRLF 下代码块不检查、层表不从 1 起始误报空档、标记含 `=` 被截断 |
| 6. index 边界写法 | 2 | `--out` 路径含 `=` 被截断写错位置、轮数口径与导出不一致 |

改测试注意一点：`check` 的 detail 参数会被打进日志，别在里面拼敏感内容（token、路径里的用户名）。

---

## 四、版本线（倒序）

| commit | 内容 |
|---|---|
| `ddc2b68` | 空正文用户消息不占轮号；导出头部轮数与 `USER` 边界数一致 |
| `470416a` | 短会话合并键带首问；导出动态围栏；`--yaml-end` 缺失报错；新增 `test/run-tests.mjs` |
| `8a672aa` | README 补运行环境 |
| `2894c2e` | 版本号数值排序（v10 别排 v4 后）、表格竖线转义、伪轮次分隔行转义、`--yaml-end` 整行精确匹配 |

### 轮数那个 bug 的原理（`ddc2b68`）

`export-session.mjs` 原来这样写：

```js
if (o.data?.source?.kind !== 'user') continue;
turn++;                                   // ← 先自增
const body = /* 取正文 */;
if (!body) continue;                      // ← 空正文再跳过
```

空正文的用户消息（用户只发了附件、或只有工具块）会把 `turn` 推进一格，却不写出对应的 `===== USER #n` 行。两个后果：

- 头部 `- 对话轮数：145` 比文件里 `^===== USER` 的 142 行多 3
- 轮号出现断号（比如 1、2、4）

修法就是 `turn++` 挪到 `if (!body) continue` 后面。真实会话复核：`ce81bd26` 现在输出 `142 轮`，`grep -c '^===== USER #'` 也是 142。

---

## 五、已知没修的

1. **`index-sessions.cjs` 和 `~/.dsh/sessions/scan-sessions.cjs` 是两份分叉代码**
   日常实际用的是 `scan-sessions.cjs`，但它是早期分叉，功能是子集：没有 `--out`、没有文件版本选择、短会话合并键没有首问、单元格不转义；它独有的功能是硬编码 `TOPIC` 表、当前会话标记、项目分片 / 自动化分类。两份互不引用，改一边必须手动同步另一边。轮数那次就是只改了一边，INDEX 还显示旧数字。

   合并的方案：把 `scan-sessions.cjs` 独有的分类逻辑搬进 `index-sessions.cjs`，再把前者改成调后者的薄包装。没做是因为会改变现有 INDEX 的结构（少了「项目分片」「自动化任务」两节），需要先确认能不能接受。

2. **同轮号可能出现两条 `----- YUNO #n`**
   空正文用户消息之后紧跟的 assistant 消息，会挂在前一轮的编号上。所以一个轮次里可能有两条 YUNO 行。这是保真导出（真有两条 assistant 消息就该出两行），不是错，但读起来容易误会。

3. **跟 DSH 事件流字段名绑死**
   依赖 `user/message`、`assistant/message`、`session`、`session/title`、`data.source.kind`、`data.message.content`。DSH 改了事件格式就得跟着改，没有适配层。

4. **`check-md.cjs` 的分段规则是照特定文件格式写的**
   结构不一样就得改规则。它判「坏没坏」，判不了「内容对不对」。

5. **没有测试框架**
   手搓样本 + 子进程断言。够用，但加用例时要自己重复样板代码。

6. **时间跨度取文件顺序的首尾事件，不是时间戳的 min/max**（未确认风险）
   `f0`/`l0` 是「按事件顺序遇到的第一个/最后一个时间」，文件顺序若被打乱，跨度会显示成反的。实测的真实会话都是单调的，所以没改；要改成 min/max 只是两行的事。

---

## 六、日常运维命令

```bash
# 索引过期了重扫（索引本身就是这仓库的工具生成的时，别递归）
node ~/.dsh/sessions/scan-sessions.cjs

# 导出一个会话（输出路径不给就落在当前目录的 dialog-<短id>.md）
node ~/workspace/dsh-session-tools/export-session.mjs \
  "/root/.dsh/sessions/--root-workspace--/session-<完整id>"

# 检查一个 markdown 文件的格式
YAML_MODULE=/path/to/node_modules/yaml node check-md.cjs AGENTS.md
```

**注意这里有两份 `export-session.mjs`**：

- `~/workspace/dsh-session-tools/export-session.mjs` ← **正本**，跟着这个仓库走
- `~/workspace/exports/export-session.mjs` ← 副本，2026-11-27 已从正本覆盖同步

两份不自动同步。动了正本记得手动覆盖副本：

```bash
cp ~/workspace/dsh-session-tools/export-session.mjs ~/workspace/exports/export-session.mjs
```

前面踩过一次：副本停在旧版本，跑副本会得到旧行为（轮数多报、伪轮次边界不被转义），而且看不出来是在跑旧代码。

---

## 七、成本

导大会话很贵：长会话每问一轮都要重新计费全部历史。导出 200+ 轮的会话，光把内容读进上下文就是几万 token。

省的做法：先看 `~/.dsh/sessions/INDEX.md`（零成本），需要摘要读 `resume-*.md`，只有要具体某段时才导出全文再 `grep`，别整份读。
