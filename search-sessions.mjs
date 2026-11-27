#!/usr/bin/env node
/**
 * search-sessions.mjs — 在全部 DSH 会话里搜一句话说过什么
 *
 * 会话事件流是压在磁盘上的 zstd，grep 直接搜是搜不到的。这个脚本负责解压、
 * 只取真人发言和模型正文（和 export-session 同一套规则），再按消息级匹配。
 *
 * 时间都花在解压和 JSON.parse 上：49 个会话约 7 秒。所以第一次解析后把正文
 * 缓存到 ~/.cache/dsh-session-tools，按源文件 mtime+size 失效，第二次起 <1 秒。
 *
 * 用法:
 *   node search-sessions.mjs <关键词...> [选项]
 *
 * 选项:
 *   --sessions=<目录>   会话根目录，默认 ~/.dsh/sessions
 *   --limit=<n>         最多显示多少条命中消息（默认 20）
 *   --context=<n>       每条命中上下各带几行（默认 1）
 *   --role=user|assistant|all   只搜某一方（默认 all）
 *   --session=<前缀>    只搜目录名以此开头的会话
 *   --json              每条命中输出一行 JSON
 *   --case              大小写敏感（默认不敏感）
 *   --no-cache          跳过缓存，强制重新解析
 *
 * 多个关键词是 AND：同一消息里都出现才算命中。
 * 退出码: 0 有命中 / 1 无命中 / 2 用法错误
 */
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';
import { findEventFile, readSessionText, parseEvents } from './lib/session-decode.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => args.includes(`--${name}`);

const sessionRoot = opt('sessions') || process.env.DSH_SESSIONS || join(homedir(), '.dsh', 'sessions');
const limit = Number(opt('limit') ?? 20);
const context = Number(opt('context') ?? 1);
const role = opt('role') || 'all';
const onlySession = opt('session');
const asJson = flag('json');
const caseSensitive = flag('case');
const useCache = !flag('no-cache');
const cacheRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dsh-session-tools');

const needles = args.filter(a => !a.startsWith('--'));

if (!needles.length) {
  console.error('用法: node search-sessions.mjs <关键词...> [--limit=20] [--context=1] [--role=user|assistant|all] [--session=<前缀>] [--json] [--case] [--no-cache]');
  process.exit(2);
}
if (!Number.isInteger(limit) || limit < 1) { console.error('--limit 需要正整数'); process.exit(2); }
if (!Number.isInteger(context) || context < 0) { console.error('--context 需要非负整数'); process.exit(2); }
if (!['user', 'assistant', 'all'].includes(role)) { console.error('--role 只能是 user / assistant / all'); process.exit(2); }
if (!statSync(sessionRoot, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`会话目录不存在: ${sessionRoot}`);
  process.exit(2);
}

const fmtTime = (ms) => {
  if (!ms) return '';
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16);
};
const shortId = (dirName) => dirName.replace(/^session-/, '').slice(0, 8);
const norm = (s) => (caseSensitive ? s : s.toLowerCase());
const needlesN = needles.map(norm);

/** 列出所有会话目录（root/<workspace>/<sessionDir>） */
function listSessionDirs(root) {
  const out = [];
  for (const ws of readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory() || ws.name.startsWith('.')) continue;
    const wsDir = join(root, ws.name);
    let entries = [];
    try { entries = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (onlySession && !e.name.startsWith(onlySession) && !e.name.startsWith(`session-${onlySession}`)) continue;
      out.push({ dir: join(wsDir, e.name), name: e.name });
    }
  }
  return out;
}

/** 事件流 → 只含真人发言与模型正文的消息列表（结果可缓存） */
function extractMessages(file) {
  const events = parseEvents(readSessionText(file));
  const messages = [];
  let title = '';
  for (const e of events) {
    if (e.type === 'session/title' && e.data?.title) { title = e.data.title; break; }
  }
  for (const e of events) {
    let who = null;
    let text = '';
    if (e.type === 'user/message') {
      if (e.data?.source?.kind !== 'user') continue;      // 与 export-session 同规则：跳过系统注入
      who = 'USER';
      text = (e.data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    } else if (e.type === 'assistant/message') {
      who = 'YUNO';
      text = (e.data?.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    } else continue;
    if (text) messages.push({ role: who, time: e.time, text });
  }
  return { title, messages };
}

/**
 * 读缓存或重新解析。
 * 缓存键带上源文件的大小和 mtime：会话还在追加时不命中，自动重建。
 * 缓存坏了、写不进去（只读文件系统）都只是变慢，不影响搜索本身。
 */
function loadSession(dir) {
  let file;
  let st;
  try {
    file = findEventFile(dir);
    st = statSync(file);
  } catch {
    return null;               // 空壳或写入中的会话，跳过
  }

  const key = `${basename(dir)}.${st.size}.${Math.round(st.mtimeMs)}`;
  const cachePath = join(cacheRoot, `${key}.jsonl.zst`);

  if (useCache) {
    try {
      const raw = zstdDecompressSync(readFileSync(cachePath)).toString('utf8');
      const lines = raw.split('\n').filter(Boolean);
      return { title: JSON.parse(lines[0] ?? '{}').title ?? '', messages: lines.slice(1).map(l => JSON.parse(l)), fromCache: true };
    } catch { /* 没缓存或缓存坏了，走解析 */ }
  }

  let parsed;
  try { parsed = extractMessages(file); } catch { return null; }
  if (useCache) {
    try {
      mkdirSync(cacheRoot, { recursive: true });
      // 同一个会话的旧缓存（尺寸或 mtime 变了）删掉，否则目录会无限长
      for (const f of readdirSync(cacheRoot)) {
        if (f.startsWith(`${basename(dir)}.`) && f !== `${key}.jsonl.zst`) {
          try { rmSync(join(cacheRoot, f)); } catch { /* 删不掉就算了 */ }
        }
      }
      const body = [JSON.stringify({ title: parsed.title }), ...parsed.messages.map(m => JSON.stringify(m))].join('\n');
      writeFileSync(cachePath, zstdCompressSync(Buffer.from(body)));
    } catch { /* 缓存失败不影响结果 */ }
  }
  return { ...parsed, fromCache: false };
}

const results = [];
const seenSessions = new Set();

for (const s of listSessionDirs(sessionRoot)) {
  const loaded = loadSession(s.dir);
  if (!loaded) continue;

  for (const m of loaded.messages) {
    if (role !== 'all' && m.role !== (role === 'user' ? 'USER' : 'YUNO')) continue;

    const lowerText = norm(m.text);
    if (!needlesN.every(n => lowerText.includes(n))) continue;

    const lines = m.text.split('\n').map(l => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
    const hits = [];
    lines.forEach((line, i) => { if (needlesN.some(k => norm(line).includes(k))) hits.push(i); });
    if (!hits.length) continue;              // 理论上不会：消息级已过，但守住边界

    results.push({ session: shortId(s.name), sessionDir: s.name, title: loaded.title, time: m.time, role: m.role, lines, hits });
    seenSessions.add(s.name);
  }
}

// 最近的先说：这条命令的典型问题是「我上次是不是说过这个」
results.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
const shown = results.slice(0, limit);

if (asJson) {
  for (const r of shown) {
    console.log(JSON.stringify({
      session: r.session, title: r.title, time: fmtTime(r.time), role: r.role,
      snippets: r.hits.map(i => r.lines[i]),
    }));
  }
} else {
  for (const r of shown) {
    console.log(`\n${r.session}  ${fmtTime(r.time)}  ${r.role}${r.title ? `  «${r.title}»` : ''}`);
    const want = new Set();
    for (const i of r.hits) {
      for (let k = Math.max(0, i - context); k <= Math.min(r.lines.length - 1, i + context); k++) want.add(k);
    }
    for (const i of [...want].sort((a, b) => a - b)) {
      const mark = r.hits.includes(i) ? '>' : ' ';
      console.log(`${mark} ${String(i + 1).padStart(5)} | ${r.lines[i]}`);
    }
  }
}

if (!results.length) {
  console.error(`没有匹配: ${needles.join(' ')}`);
  process.exit(1);
}

console.error(`共 ${results.length} 条命中（${seenSessions.size} 个会话），显示 ${shown.length} 条`);
