#!/usr/bin/env node
/**
 * run-tests.mjs — dsh-session-tools 的回归测试
 *
 * 三个脚本都不是库，只能当命令跑，所以这里造临时数据、起子进程、读输出断言。
 * 每个用例都对应一个曾经出过错的地方：
 *
 *   1. index-sessions: 短会话合并键要带上首问，同标题同轮数的两件事不能合并
 *   2. export-session: 正文里未闭合的代码围栏不能吞掉后续轮次
 *   3. check-md: 显式 --yaml-end 找不到时必须报分段错误，不能回退到默认规则
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

  // ---------- 3. check-md 结束标记 ----------
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
} finally {
  await rm(work, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length} 项检查，${failed.length} 项失败`)
process.exit(failed.length === 0 ? 0 : 1)
