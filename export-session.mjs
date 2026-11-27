#!/usr/bin/env node
/**
 * export-session.mjs — 把 DSH session 事件流导出成可读 Markdown
 *
 * session 存在磁盘上是一条 append-only 的 JSONL 事件流，zstd 压缩，可能多帧。
 * 里面混着系统注入、reasoning、工具调用和真正的对话，直接读很难看。
 * 这个脚本只保留真人发言和模型正文，工具调用压成一行摘要。
 *
 * 用法:
 *   node export-session.mjs <会话目录 | 压缩文件> [输出.md]
 *
 * 例:
 *   node export-session.mjs ~/.dsh/sessions/--root-workspace--/session-abc123
 *   node export-session.mjs ~/.dsh/sessions/.../session.v4.jsonl.zstd out.md
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join, basename } from 'node:path';

const ZSTD_MAGIC = 0x28b52ffd;
const SKIP_BASE = 0x184d2a50;
const SKIP_MASK = 0xfffffff0;

/** 解压可能多帧的 zstd 数据 */
function decodeMultiFrame(buf) {
  try { return zstdDecompressSync(buf); } catch { /* 走逐帧 */ }
  const chunks = [];
  let start = 0, frames = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    const magic = buf.readUInt32LE(i);
    if (magic === ZSTD_MAGIC || (magic & SKIP_MASK) === SKIP_BASE) {
      if (frames > 0) chunks.push(zstdDecompressSync(buf.subarray(start, i)));
      start = i;
      frames++;
    }
  }
  if (frames === 0) throw new Error('找不到 zstd 帧');
  chunks.push(zstdDecompressSync(buf.subarray(start)));
  return Buffer.concat(chunks);
}

/** 目录里找事件流文件，不假设固定文件名 */
function findEventFile(dir) {
  const candidates = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl'))
    .sort();
  if (!candidates.length) throw new Error(`目录里没有 *.jsonl.zstd: ${dir}`);
  // 优先带版本号的最新格式。版本号按数值比较：字符串排序会把 v10 排在 v4 前面。
  const versionOf = (name) => {
    const m = name.match(/\.v(\d+)\./);
    return m ? Number(m[1]) : -1;
  };
  const versioned = candidates
    .filter(f => /\.v\d+\./.test(f))
    .sort((a, b) => versionOf(b) - versionOf(a));
  return join(dir, (versioned[0] || candidates[0]));
}

const input = process.argv[2];
if (!input) {
  console.error('用法: node export-session.mjs <会话目录 | 压缩文件> [输出.md]');
  process.exit(2);
}

const st = statSync(input, { throwIfNoEntry: false });
if (!st) { console.error(`路径不存在: ${input}`); process.exit(2); }

const src = st.isDirectory() ? findEventFile(input) : input;
const raw = readFileSync(src);
const text = src.endsWith('.zstd')
  ? decodeMultiFrame(raw).toString('utf8')
  : raw.toString('utf8');

const sessionId = st.isDirectory() ? basename(input) : basename(join(src, '..'));
const shortId = sessionId.replace(/^session-/, '').slice(0, 8);
const outPath = process.argv[3] || `dialog-${shortId}.md`;

const objs = text.split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const fmtTime = (ms) => {
  if (!ms) return '';
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16);
};

// 分隔行是导出文件的骨架：正文里若出现同形文本，会伪造出一轮根本不存在的对话。
// 只在行首转义，正文照常可读，grep '^===== USER' 仍然只命中真正的轮次边界。
const escapeBoundaries = (text) =>
  text.replace(/^(?:=====\s*USER\b|-----\s*YUNO\b)/gm, '\\$&');

// 每条正文单独放进一个围栏块，围栏长度按内容动态选：比正文里最长的反引号串再长一个。
// 否则一段没闭合的 ``` 会把后面所有轮次吞进同一个代码块，导出文件结构就废了。
const fenceFor = (text) => {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
};
const fencedBlock = (text) => {
  const fence = fenceFor(text);
  return `${fence}markdown\n${escapeBoundaries(text)}\n${fence}`;
};

const out = [];
let meta = null;
let turn = 0;

for (const o of objs) {
  if (o.type === 'session') { meta = o; continue; }

  if (o.type === 'user/message') {
    if (o.data?.source?.kind !== 'user') continue;      // 跳过系统注入
    const body = (o.data?.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    // 空正文的消息（只有工具块或纯空白）不占轮号。先自增再跳过会让 turn 跑在
    // 实际写出的轮次边界前面：头部「对话轮数」比 '^===== USER' 行数多，轮号还跳。
    if (!body) continue;
    turn++;
    out.push(`\n===== USER #${turn} · ${fmtTime(o.time)} =====\n${fencedBlock(body)}`);
  }

  if (o.type === 'assistant/message') {
    const blocks = o.data?.message?.content || [];
    const body = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const calls = blocks.filter(b => b.type === 'tool-call').map(b => {
      let brief = '';
      try {
        const a = JSON.parse(b.arguments);
        brief = a.command || a.queries?.join(' | ') || a.url || a.path || a.description || '';
      } catch { brief = String(b.arguments).slice(0, 120); }
      return `  > [${b.name}] ${String(brief).replace(/\s+/g, ' ').slice(0, 160)}`;
    });
    if (!body && !calls.length) continue;
    out.push(`\n----- YUNO #${turn} · ${fmtTime(o.time)} -----`);
    if (body) out.push(fencedBlock(body));
    if (calls.length) out.push(calls.join('\n'));
  }
}

const header = [
  `# ${sessionId} 对话导出`,
  '',
  `- 导出时间：${fmtTime(Date.now())}`,
  `- 会话创建：${meta ? fmtTime(meta.createdAt) : '未知'}`,
  `- 工作目录：${meta?.cwd ?? '未知'}`,
  `- 原始事件：${objs.length} 条`,
  `- 对话轮数：${turn}`,
  '',
  '> 只含真人发言与模型正文；工具调用压成单行，reasoning 未收录。',
  '',
].join('\n');

writeFileSync(outPath, header + out.join('\n') + '\n');
console.log(`${outPath}  ${turn} 轮，${(header + out.join('\n')).length} 字符`);
