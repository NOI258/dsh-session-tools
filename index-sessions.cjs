#!/usr/bin/env node
/**
 * index-sessions.cjs — 扫描 DSH 会话目录，生成 INDEX.md
 *
 * 会话多了以后，没人记得哪个 id 对应哪件事。这个脚本扫一遍所有会话，
 * 提取时间跨度、轮数、大小、主题，按类型分类输出成一张表。
 *
 * 用法:
 *   node index-sessions.cjs [会话根目录] [--out=<输出路径>]
 *
 * 默认根目录: $DSH_HOME/sessions 或 ~/.dsh/sessions
 * 默认输出:   <根目录>/INDEX.md
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const outFlag = args.find(a => a.startsWith('--out='));
const positional = args.filter(a => !a.startsWith('--'));

const ROOT = positional[0]
  || (process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'sessions'))
  || path.join(os.homedir(), '.dsh', 'sessions');

if (!fs.existsSync(ROOT)) {
  console.error(`会话根目录不存在: ${ROOT}`);
  process.exit(2);
}
const OUT = outFlag ? outFlag.split('=')[1] : path.join(ROOT, 'INDEX.md');

// ---------- zstd ----------
const M = 0x28b52ffd, SKIP = 0x184d2a50, MASK = 0xfffffff0;
function decode(buf) {
  try { return zlib.zstdDecompressSync(buf); } catch { /* 多帧 */ }
  const chunks = []; let s = 0, n = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    const m = buf.readUInt32LE(i);
    if (m === M || (m & MASK) === SKIP) {
      if (n > 0) chunks.push(zlib.zstdDecompressSync(buf.subarray(s, i)));
      s = i; n++;
    }
  }
  if (!n) throw new Error('无 zstd 帧');
  chunks.push(zlib.zstdDecompressSync(buf.subarray(s)));
  return Buffer.concat(chunks);
}

const TZ = 8 * 3600 * 1000;
const ts = (ms) => ms ? new Date(ms + TZ).toISOString().slice(5, 16).replace('T', ' ') : '—';
const kb = (n) => n < 1048576 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1048576).toFixed(1)}MB`;
const sid = (r) => r.sd.replace(/^session-/, '').slice(0, 8);

// ---------- 扫描 ----------
const rows = [];
for (const ws of fs.readdirSync(ROOT)) {
  const wp = path.join(ROOT, ws);
  let wst; try { wst = fs.statSync(wp); } catch { continue; }
  if (!wst.isDirectory() || ws.startsWith('.')) continue;

  for (const sd of fs.readdirSync(wp)) {
    const dir = path.join(wp, sd);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl'));
    if (!files.length) { rows.push({ ws, sd, empty: 1 }); continue; }

    const ver = files.filter(f => /\.v\d+\./.test(f)).sort().reverse();
    const raw = fs.readFileSync(path.join(dir, ver[0] || files[0]));

    let text;
    try { text = raw[0] === 0x7b ? raw.toString('utf8') : decode(raw).toString('utf8'); }
    catch (e) { rows.push({ ws, sd, err: e.message, size: raw.length }); continue; }

    const objs = text.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    let f0 = null, l0 = null, turns = 0, title = null, q = null;
    for (const o of objs) {
      const t = o.time || o.createdAt;
      if (t) { if (!f0) f0 = t; l0 = t; }
      if (o.type === 'session/title') {
        const d = o.data;
        title = typeof d === 'string' ? d : (d?.title || null);
      }
      if (o.type === 'user/message' && o.data?.source?.kind === 'user') {
        turns++;
        if (!q) {
          const s = (o.data.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
          if (s) q = s.replace(/\s+/g, ' ').slice(0, 60);
        }
      }
    }
    rows.push({ ws, sd, size: raw.length, events: objs.length, turns, f0, l0, title, q });
  }
}

// ---------- 分类 ----------
const label = (r) => {
  const t = (r.title || '').trim();
  const q = (r.q || '').trim();
  const boring = !t || /^idk/i.test(t) || t === '(无)';
  return boring ? (q || '(无内容)') : t;
};

const main = [], short = [], shell = [];
for (const r of rows) {
  if (r.empty) { shell.push(r); continue; }
  if (r.err) { shell.push(r); continue; }
  if ((r.turns || 0) === 0 && (r.events || 0) <= 6) shell.push(r);
  else if ((r.turns || 0) >= 10) main.push(r);
  else short.push(r);
}
const byTime = (a, b) => (b.l0 || 0) - (a.l0 || 0);
[main, short, shell].forEach(g => g.sort(byTime));

// 短会话按内容前缀合并，避免刷屏
const groups = new Map();
for (const r of short) {
  const k = label(r).slice(0, 26);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const merged = [...groups.entries()]
  .map(([k, v]) => ({ k, v: v.sort(byTime) }))
  .sort((a, b) => (b.v[0].l0 || 0) - (a.v[0].l0 || 0));

// ---------- 生成 ----------
const NOW = new Date(Date.now() + TZ).toISOString().slice(0, 16).replace('T', ' ');
const L = [];
L.push('# Session 索引', '');
L.push(`生成时间：${NOW}`);
L.push(`根目录：\`${ROOT}\``);
L.push(`共 ${rows.length} 个目录 — 主线 ${main.length}、短会话 ${short.length}（合并 ${merged.length} 条）、空壳 ${shell.length}`);
L.push('');
L.push('> ⚠️ **自动标题不可靠。** 有些标题是模型自动起的（如 `idk`），不代表内容；标题无意义时本表改用首问。');
L.push('');
L.push('## 怎么用', '');
L.push('按成本从低到高恢复一个旧会话：', '');
L.push('1. **看本索引** — 找到 id 和主题，零成本');
L.push('2. **要摘要** — 如果已有摘要文件，读它（几千 token）');
L.push('3. **要细节** — `node export-session.mjs <会话目录>` 导出全文再搜（几万 token）', '');
L.push('原始位置：`<根目录>/<workspace>/<session-id>/*.jsonl.zstd`', '');
L.push('## 主线会话（10 轮以上）', '');
L.push('| id | 时间跨度 | 轮数 | 大小 | 内容 |', '|---|---|---|---|---|');
for (const r of main) {
  L.push(`| \`${sid(r)}\` | ${ts(r.f0)} → ${ts(r.l0)} | ${r.turns} | ${kb(r.size)} | ${label(r).slice(0, 34)} |`);
}
L.push('', '## 短会话', '');
L.push('| id | 时间 | 轮数 | 大小 | 内容 |', '|---|---|---|---|---|');
for (const { k, v } of merged) {
  if (v.length > 1) {
    const ids = v.map(x => `\`${sid(x)}\``).join('、');
    const total = v.reduce((a, x) => a + (x.size || 0), 0);
    L.push(`| ${ids} | ${ts(v[v.length - 1].f0)} | 各 ${v[0].turns} | 合计 ${kb(total)} | ${k}（×${v.length}） |`);
  } else {
    const r = v[0];
    L.push(`| \`${sid(r)}\` | ${ts(r.f0)} | ${r.turns} | ${kb(r.size)} | ${k} |`);
  }
}
L.push('', '## 空壳（无对话）', '');
if (shell.length) {
  for (const r of shell) {
    L.push(`- \`${sid(r)}\`${r.err ? ` — 解压失败: ${r.err}` : ' — 只有初始化事件，没有对话'}`);
  }
} else L.push('无');
L.push('', '---', '');
L.push('更新索引：', '', '```bash', `node index-sessions.cjs "${ROOT}"`, '```');

fs.writeFileSync(OUT, L.join('\n') + '\n');
console.log(`已写入 ${OUT}`);
console.log(`主线 ${main.length} / 短 ${short.length}→${merged.length} / 空壳 ${shell.length}`);
