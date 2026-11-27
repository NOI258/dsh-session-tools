/**
 * session-decode.mjs — 会话事件流的读取与解压
 *
 * 抽出来的原因：export-session 和 search-sessions 都要读同一份 .jsonl.zstd。
 * 事件流可能多帧（进程多次追加），zstdDecompressSync 只解单帧，所以必须逐帧切。
 *
 * 目录里的事件文件名不固定（有 session.v4.jsonl.zstd，也有 .v10. 之类的新格式），
 * 版本号按数值比较：字符串排序会把 v10 排在 v4 前面，选错文件。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

const ZSTD_MAGIC = 0x28b52ffd;
const SKIP_BASE = 0x184d2a50;
const SKIP_MASK = 0xfffffff0;

/** 解压可能多帧的 zstd 数据 */
export function decodeMultiFrame(buf) {
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
export function findEventFile(dir) {
  const candidates = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl'))
    .sort();
  if (!candidates.length) throw new Error(`目录里没有 *.jsonl.zstd: ${dir}`);
  const versionOf = (name) => {
    const m = name.match(/\.v(\d+)\./);
    return m ? Number(m[1]) : -1;
  };
  const versioned = candidates
    .filter(f => /\.v\d+\./.test(f))
    .sort((a, b) => versionOf(b) - versionOf(a));
  return join(dir, (versioned[0] || candidates[0]));
}

/** 读一个事件流文件，返回解压后的文本 */
export function readSessionText(file) {
  const raw = readFileSync(file);
  return file.endsWith('.zstd') ? decodeMultiFrame(raw).toString('utf8') : raw.toString('utf8');
}

/** JSONL 文本 → 事件对象数组，坏行跳过 */
export function parseEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半写入的行丢掉 */ }
  }
  return out;
}
