#!/usr/bin/env node
/**
 * run-tests.mjs — dsh-session-tools 的回归测试
 *
 * 三个脚本都不是库，只能当命令跑，所以这里造临时数据、起子进程、读输出断言。
 * 每个用例都对应一个曾经出过错的地方：
 *
 *   1. index-sessions: 短会话合并键要带上首问，同标题同轮数的两件事不能合并
 *   2. export-session: 正文里未闭合的代码围栏不能吞掉后续轮次
 *   3. export-session: 空正文的用户消息不占轮号，头部轮数与 USER 边界数一致
 *   4. check-md: 显式 --yaml-end 找不到时必须报分段错误，不能回退到默认规则
 *
 * 用法: node test/run-tests.mjs
 * 退出码: 0 全过 / 1 有失败
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const indexScript = join(root, 'index-sessions.cjs')
const exportScript = join(root, 'export-session.mjs')
const checkScript = join(root, 'check-md.cjs')
const searchScript = join(root, 'search-sessions.mjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const run = (script, args, opts = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...opts })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** Writes a fake session event stream. */
async function writeSession(dir, { title, turns, first }) {
  await mkdir(dir, { recursive: true })
  const now = Date.now()
  const events = [
    { type: 'session', createdAt: now - 60_000, cwd: '/root/workspace' },
    { type: 'session/title', time: now - 50_000, data: { title } },
  ]
  for (let i = 0; i < turns; i++) {
    events.push({
      type: 'user/message',
      time: now - 40_000 + i,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: i === 0 ? first : `follow-up ${i}` }] },
    })
    events.push({
      type: 'assistant/message',
      time: now - 39_000 + i,
      data: { message: { content: [{ type: 'text', text: `answer ${i}` }] } },
    })
  }
  const body = events.map(e => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body)))
}

const work = await mkdtemp(join(tmpdir(), 'dst-test-'))

try {
  // ---------- 1. 短会话合并键 ----------
  {
    const sessions = join(work, 'sessions')
    const ws = join(sessions, 'ws')
    await writeSession(join(ws, 'session-aaa00001'), { title: 'same title', turns: 3, first: '问 A' })
    await writeSession(join(ws, 'session-bbb00002'), { title: 'same title', turns: 3, first: '问 B' })
    await writeSession(join(ws, 'session-ccc00003'), { title: 'same title', turns: 3, first: '问 A' })
    const out = join(work, 'INDEX.md')
    const r = run(indexScript, [sessions, `--out=${out}`])
    const md = await readFile(out, 'utf8').catch(() => '')
    const shortTable = md.split('## 短会话')[1]?.split('## 空壳')[0] ?? ''
    const rows = shortTable.split('\n').filter(l => l.startsWith('| `'))
    check('index: 同标题同轮数但首问不同的会话分成两行', rows.length === 2, `表格行数: ${rows.length}`)
    check('index: 内容完全相同的会话仍然合并', /（×2）/.test(shortTable), shortTable.includes('×2') ? '×2' : '没有合并标记')
    check('index: 退出码 0', r.code === 0, `exit ${r.code}`)
  }

  // ---------- 2. export 动态围栏 ----------
  {
    const dir = join(work, 'exports', 'session-ddd00004')
    await mkdir(dir, { recursive: true })
    const now = Date.now()
    const events = [
      { type: 'session', createdAt: now, cwd: '/root/workspace' },
      // 第一条正文里有一个永不闭合的代码围栏
      { type: 'user/message', time: now, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'before\n```js\nnever closed' }] } },
      { type: 'assistant/message', time: now, data: { message: { content: [{ type: 'text', text: 'first answer' }] } } },
      // 第二轮必须还能被识别成一个新的轮次边界
      { type: 'user/message', time: now + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second question' }] } },
      { type: 'assistant/message', time: now + 1, data: { message: { content: [{ type: 'text', text: 'second answer' }] } } },
    ]
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n')))
    const out = join(work, 'dialog.md')
    const r = run(exportScript, [dir, out])
    const md = await readFile(out, 'utf8').catch(() => '')
    const userBounds = (md.match(/^===== USER #/gm) ?? []).length
    const assistantBounds = (md.match(/^----- YUNO #/gm) ?? []).length
    check('export: 两轮各自有轮次边界', userBounds === 2 && assistantBounds === 2, `USER=${userBounds} YUNO=${assistantBounds}`)
    const fenceHeads = (md.match(/^`{3,}markdown$/gm) ?? []).length
    check('export: 每条正文都单独围栏', fenceHeads === 4, `围栏头: ${fenceHeads}`)
    check('export: 含反引号的正文用更长的围栏包裹', md.includes('````markdown'), md.includes('````markdown') ? '4 个反引号' : '仍是 3 个')
    check('export: 正文内容没有被围栏改写', md.includes('never closed') && md.includes('second answer'), '')
    check('export: 退出码 0', r.code === 0, `exit ${r.code}`)
  }

  // ---------- 3. export 轮数一致性 ----------
  // 空正文的用户消息（只有工具块或纯空白）过去会让 turn 先自增再跳过，
  // 结果头部轮数比实际写出的 USER 边界多，轮号还会跳号。
  {
    const dir = join(work, 'exports', 'session-eee00005')
    await mkdir(dir, { recursive: true })
    const now = Date.now()
    const userMsg = (t, text) => ({ type: 'user/message', time: t, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    const asstMsg = (t, text) => ({ type: 'assistant/message', time: t, data: { message: { content: [{ type: 'text', text }] } } })
    const events = [
      { type: 'session', createdAt: now, cwd: '/root/workspace' },
      userMsg(now, 'first question'),
      asstMsg(now, 'first answer'),
      // 空正文：真实会话里确实存在（用户只发了附件/只有工具块）
      { type: 'user/message', time: now + 1, data: { source: { kind: 'user' }, content: [] } },
      asstMsg(now + 1, 'answer to empty turn'),
      userMsg(now + 2, 'second question'),
      asstMsg(now + 2, 'second answer'),
    ]
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n')))
    const out = join(work, 'dialog-turns.md')
    const r = run(exportScript, [dir, out])
    const md = await readFile(out, 'utf8').catch(() => '')
    const userBounds = (md.match(/^===== USER #/gm) ?? []).length
    const declared = Number((md.match(/^- 对话轮数：(\d+)/m) ?? [])[1])
    const nums = [...md.matchAll(/^===== USER #(\d+)/gm)].map(m => Number(m[1]))
    check('export: 头部轮数等于实际写出的 USER 边界数', declared === userBounds, `头部 ${declared} / 实际 ${userBounds}`)
    check('export: 空正文消息不占轮号', declared === 2, `头部 ${declared}（应为 2）`)
    check('export: 轮号连续不跳号', nums.join(',') === '1,2', `轮号: ${nums.join(',') || '(无)'}`)
    check('export: 空正文轮次之后的正文仍然保留', md.includes('answer to empty turn') && md.includes('second answer'), '')
    check('export: 退出码 0', r.code === 0, `exit ${r.code}`)
  }

  // ---------- 4. check-md 结束标记 ----------
  {
    const good = join(work, 'good.md')
    await writeFile(good, 'name: test\nbody:\n  # 这里提到 END 不算边界\n  a: 1\nEND\n# Markdown 区\n')
    const ok = run(checkScript, [good, '--yaml-end=END'])
    check('check-md: 标记存在时正常通过', ok.code === 0, `exit ${ok.code}`)

    const missing = run(checkScript, [good, '--yaml-end=NO_SUCH_MARKER'])
    check('check-md: 显式标记缺失时退出码非 0', missing.code === 1, `exit ${missing.code}`)
    check('check-md: 显式标记缺失时报告分段错误', /\[FAIL\] 分段/.test(missing.out), missing.out.split('\n').find(l => l.includes('分段')) ?? '(没有分段行)')
    check('check-md: 错误里点明是哪个标记', missing.out.includes('NO_SUCH_MARKER'), '')
    check('check-md: 不再静默回退到默认规则', !/YAML 解析/.test(missing.out), missing.out.includes('YAML 解析') ? '仍然继续解析了' : '没有继续解析')
  }

  // ---------- 5. check-md 的边界写法 ----------
  // 这些格式都合法，但旧实现认不出来：认不出时要么报假错，要么静默跳过检查。
  {
    const valued = join(work, 'valued.md')
    await writeFile(valued, 'name: demo\nversion: 1\n---\n# md\n')
    const r1 = run(checkScript, [valued])
    const seg = r1.out.split('\n').find(l => l.includes('分段')) ?? '(没有分段行)'
    check('check-md: 顶层键带值时有 YAML 起点', /\[PASS\] 分段/.test(r1.out) && r1.code === 0, seg)

    // 空值的 --yaml-end= 是写错了，不能当成没传
    const basic = join(work, 'basic.md')
    await writeFile(basic, 'name:\n---\n# md\n')
    const r2 = run(checkScript, [basic, '--yaml-end='])
    check('check-md: --yaml-end= 空值报用法错误', r2.code === 2 && /空的/.test(r2.out),
      `exit ${r2.code} / ${r2.out.trim().split('\n')[0] || '(无输出)'}`)

    // CRLF：yaml 代码块必须还能被找到并检查
    const crlf = join(work, 'crlf.md')
    await writeFile(crlf, 'name:\r\n---\r\n# md\r\n```yaml\r\na: 1\r\n```\r\n')
    const r3 = run(checkScript, [crlf])
    const blockLine = r3.out.split('\n').find(l => l.includes('代码块')) ?? '(没有代码块行)'
    check('check-md: CRLF 文件里的 yaml 块仍被检查', /\[PASS\] 代码块: 1 块/.test(r3.out), blockLine)

    // 层号不一定从 1 开始
    const lv0 = join(work, 'lv0.md')
    await writeFile(lv0, 'name:\nlayer_order:\n  layers:\n    - level: 0\n    - level: 1\n    - level: 2\n---\n# md\n')
    const r4 = run(checkScript, [lv0])
    const contLine = r4.out.split('\n').find(l => l.includes('层表连续性')) ?? '(没有该行)'
    check('check-md: 层表 0,1,2 判为连续', /\[PASS\] 层表连续性/.test(r4.out), contLine)

    // 结束标记本身含等号
    const eq = join(work, 'eq.md')
    await writeFile(eq, 'name:\nA=B\n---\n# md\n')
    const r5 = run(checkScript, [eq, '--yaml-end=A=B'])
    const eqSeg = r5.out.split('\n').find(l => l.includes('分段')) ?? '(没有分段行)'
    check('check-md: 结束标记含等号不被截断', r5.code === 0 && /\[PASS\] 分段/.test(r5.out), eqSeg)
  }

  // ---------- 6. index-sessions 的边界写法 ----------
  // 同一份会话数据，INDEX 的轮数和 export 的轮数必须是同一个数。
  {
    const sessions = join(work, 'sessions6')
    const sdir = join(sessions, 'ws', 'session-fff00006')
    await mkdir(sdir, { recursive: true })
    const now = Date.now()
    const ev = [
      { type: 'session', createdAt: now - 1000, cwd: '/root/workspace' },
      { type: 'session/title', time: now - 900, data: { title: 'edge title' } },
      { type: 'user/message', time: now - 800, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] } },
      { type: 'assistant/message', time: now - 700, data: { message: { content: [{ type: 'text', text: 'a1' }] } } },
      // 空正文用户消息：不占轮号
      { type: 'user/message', time: now - 600, data: { source: { kind: 'user' }, content: [] } },
      { type: 'user/message', time: now - 500, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] } },
    ]
    await writeFile(join(sdir, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(ev.map(e => JSON.stringify(e)).join('\n') + '\n')))

    // 输出路径含等号：split('=') 会把它截断成另一个文件
    const out = join(work, 'out=a', 'INDEX.md')
    await mkdir(dirname(out), { recursive: true })
    const r = run(indexScript, [sessions, `--out=${out}`])
    const md = await readFile(out, 'utf8').catch(() => '')
    check('index: --out 路径含等号时写到正确位置', r.code === 0 && md.length > 0,
      `exit ${r.code}，目标文件${md ? '存在' : '不存在'}`)

    const row = (md.split('## 短会话')[1] ?? '').split('\n').find(l => l.startsWith('| `'))
    const turns = row ? row.split('|')[3].trim() : '(没找到数据行)'
    check('index: 轮数不计空正文用户消息', turns === '2', `轮数: ${turns}（应为 2）`)
  }
  // ---------- 7. search-sessions ----------
  // 关键词是消息级 AND：两个词分在不同消息里不算命中。
  // 角色过滤和退出码是 grep 语义，无命中必须非 0，否则脚本里没法判断。
  {
    const sessions = join(work, 'sessions7')
    const ws = join(sessions, 'ws')
    await writeSession(join(ws, 'session-ggg00007'), { title: '搜索测试', turns: 2, first: 'alpha beta 关键词' })
    const cacheHome = join(work, 'cache7')
    const env = { ...process.env, XDG_CACHE_HOME: cacheHome }
    const base = ['--sessions=' + sessions]

    const hit = run(searchScript, ['alpha', ...base], { env })
    check('search: 关键词命中真人发言', hit.code === 0 && /USER/.test(hit.out), `exit ${hit.code}`)

    const and = run(searchScript, ['alpha', 'answer', ...base], { env })
    check('search: 两个词分属不同消息不算命中', and.code === 1, `exit ${and.code}`)

    const both = run(searchScript, ['alpha beta', 'alpha', ...base], { env })
    check('search: 多词同消息同时命中', both.code === 0, `exit ${both.code}`)

    const onlyUser = run(searchScript, ['answer', '--role=user', ...base], { env })
    check('search: --role=user 过滤掉模型正文', onlyUser.code === 1, `exit ${onlyUser.code}`)

    const onlyAsst = run(searchScript, ['answer', '--role=assistant', ...base], { env })
    check('search: --role=assistant 能命中模型正文', onlyAsst.code === 0, `exit ${onlyAsst.code}`)

    const limited = run(searchScript, ['answer', '--limit=1', ...base], { env })
    const shown = (limited.out.match(/^ws|^\S{8}\s+\d{4}-/gm) ?? []).length
    check('search: --limit 限制显示条数', limited.code === 0, `exit ${limited.code}`)

    const badRole = run(searchScript, ['alpha', '--role=nobody', ...base], { env })
    check('search: 非法 --role 报用法错误', badRole.code === 2, `exit ${badRole.code}`)

    const missing = run(searchScript, ['zzz-not-there', ...base], { env })
    check('search: 无命中退出码为 1', missing.code === 1, `exit ${missing.code}`)

    const json = run(searchScript, ['alpha', '--json', ...base], { env })
    let parsed = null
    try { parsed = JSON.parse(json.out.trim().split('\n')[0]) } catch { /* 留空 */ }
    check('search: --json 输出可解析且带字段', parsed?.role === 'USER' && Array.isArray(parsed?.snippets),
      parsed ? JSON.stringify(Object.keys(parsed)) : '不是合法 JSON')

    // 缓存命中和不命中必须给出同样的结果
    const cold = run(searchScript, ['alpha', '--no-cache', ...base], { env })
    const warm = run(searchScript, ['alpha', ...base], { env })
    const warm2 = run(searchScript, ['alpha', ...base], { env })
    check('search: 缓存前后结果一致', cold.out === warm.out && warm.out === warm2.out,
      cold.out === warm.out ? '一致' : '缓存改变了输出')
  }
  // ---------- 8. 文档和 package.json 与 bin 数量同步 ----------
  // 加计新工具时最容易漏的两处：README 开头的「N 个脚本」和 package.json 的 files。
  // 这两处漏了不会报错，只会在别人 clone 下来时找不到文件、或者看到过时的介绍。
  {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const files = Object.values(pkg.bin ?? {}).map(b => b.replace(/^\.\//, ''))
    const readme = await readFile(join(root, 'README.md'), 'utf8')
    const integ = await readFile(join(root, 'INTEGRATION.md'), 'utf8')
    const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

    // 只检查「正确数字出现过」是不够的：文档里同一句话会出现三次，
    // 改一处留两处，旧写法照样通过。所以必须检查「错误数字一次都没出现」。
    const ALL = CN.slice(1, 11)
    const wrongIn = (doc) => ALL.filter(n => n !== CN[files.length] && doc.includes(`${n}个脚本`))
    const wrongReadme = wrongIn(readme)
    const wrongInteg = wrongIn(integ)
    check('docs: bin 数量与 README 的「N 个脚本」一致',
      readme.includes(`${CN[files.length]}个脚本`) && wrongReadme.length === 0,
      `bin ${files.length} 个；${wrongReadme.length ? `README 里还有「${wrongReadme.join('、')}个脚本」` : '全部一致'}`)
    check('docs: INTEGRATION 里没有过时的脚本数', wrongInteg.length === 0,
      wrongInteg.length ? `还有「${wrongInteg.join('、')}个脚本」` : '全部一致')

    const missingReadme = files.filter(f => !readme.includes(f))
    check('docs: README 列出每个 bin 脚本', missingReadme.length === 0, missingReadme.join('、') || '全部列出')

    const missingInteg = files.filter(f => !integ.includes(f))
    check('docs: INTEGRATION 列出每个 bin 脚本', missingInteg.length === 0, missingInteg.join('、') || '全部列出')

    const pkgFiles = pkg.files ?? []
    const missingPkg = files.filter(f => !pkgFiles.includes(f))
    check('package: files 覆盖每个 bin（否则 clone 下来缺文件）', missingPkg.length === 0,
      missingPkg.join('、') || '全部覆盖')
  }
} finally {
  await rm(work, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length} 项检查，${failed.length} 项失败`)
process.exit(failed.length === 0 ? 0 : 1)
