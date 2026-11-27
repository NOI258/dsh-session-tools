#!/usr/bin/env node
/**
 * check-md.cjs — 校验「YAML 主体 + Markdown 附录」混合格式的配置文件
 *
 * 这个格式的问题是：主体必须是合法 YAML，但同一个文件后半段又是 Markdown。
 * 手动改的时候很容易把 Markdown 表格、编号列表插进 YAML 区，
 * 结果要么解析失败，要么被静默扭曲成奇怪的结构。
 *
 * 用法:
 *   node check-md.cjs <文件路径> [--yaml-end=<结束标记>]
 *
 * 退出码: 0 全过 / 1 有失败项 / 2 用法错误
 */
'use strict';

const fs = require('fs');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const endFlag = args.find(a => a.startsWith('--yaml-end='));
const yamlEndMarker = endFlag ? endFlag.split('=')[1] : null;

if (!target) {
  console.error('用法: node check-md.cjs <文件路径> [--yaml-end=<结束标记>]');
  process.exit(2);
}
if (!fs.existsSync(target)) {
  console.error(`文件不存在: ${target}`);
  process.exit(2);
}

// ---------- 依赖 ----------
function loadYaml() {
  const candidates = [
    'yaml',
    process.env.YAML_MODULE,
    '/opt/dsh/node_modules/yaml',
    '/usr/local/lib/node_modules/yaml',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* 下一个 */ }
  }
  return null;
}
const YAML = loadYaml();
if (!YAML) {
  console.error('找不到 yaml 模块。安装一个再跑:');
  console.error('  npm i -g yaml');
  console.error('或用 YAML_MODULE=<绝对路径> 指定。');
  process.exit(2);
}

// ---------- 读文件与分段 ----------
const src = fs.readFileSync(target, 'utf8');
const lines = src.split('\n');

// YAML 主体：从第一个以 `key:` 开头的行开始，到第一个独立 `---` 行（或结束标记）为止
function findYamlRange() {
  const startIdx = lines.findIndex(l => /^[A-Za-z_][\w-]*:\s*$/.test(l) && !l.startsWith(' '));
  if (startIdx < 0) return null;

  // 显式指定结束标记时优先。整行精确匹配：用 includes 的话，正文里任何含该词的
  // 句子都会被当成边界，YAML 主体会被从中间切断，而错误被切到检测范围之外。
  if (yamlEndMarker) {
    const want = yamlEndMarker.trim();
    const i = lines.findIndex(l => l.trim() === want);
    if (i > startIdx) return { startIdx, endIdx: i };
  }

  // 默认：只认「显式结束标记」，不认「非法行」
  //   1. 独立 `---` 行
  //   2. 全大写标识符裸行（如 END_OF_PERSONA_POLICY）
  // 这样中间的非法行会留在 YAML 区里，被解析和污染检测抓到，
  // 而不是被当成边界、把错误切到检测范围之外。
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (/^---\s*$/.test(l)) return { startIdx, endIdx: i };
    if (/^[A-Z][A-Z0-9_]*\s*$/.test(l)) return { startIdx, endIdx: i };
  }
  return { startIdx, endIdx: lines.length };
}

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const pass = (n, d) => add('PASS', n, d);
const fail = (n, d) => add('FAIL', n, d);
const warn = (n, d) => add('WARN', n, d);

const range = findYamlRange();
if (!range) {
  fail('分段', '找不到 YAML 主体起点（期望第一行顶层 key，如 `name:`）');
} else {
  const { startIdx, endIdx } = range;
  pass('分段', `YAML 主体 第 ${startIdx + 1}–${endIdx} 行；Markdown 区 第 ${endIdx + 1} 行起`);

  const body = lines.slice(startIdx, endIdx).join('\n');

  // ---------- 1. YAML 解析（重复键视为错误）----------
  let doc = null;
  try {
    doc = YAML.parse(body, { uniqueKeys: true });
    pass('YAML 解析', `${Object.keys(doc).length} 个顶层键，无重复键`);
  } catch (e) {
    fail('YAML 解析', String(e.message).split('\n')[0]);
  }

  // ---------- 2. 主体区 Markdown 污染 ----------
  {
    const bad = [];
    lines.slice(startIdx, endIdx).forEach((l, i) => {
      const t = l.trim();
      const ln = startIdx + i + 1;
      // YAML 里 # 开头是合法注释，不检测标题
      if (t.startsWith('|') && t.endsWith('|')) bad.push(`第 ${ln} 行 表格`);
      else if (/^\d+\.\s/.test(t)) bad.push(`第 ${ln} 行 编号列表`);
      else if (/^[-*+]\s+\*\*/.test(t)) bad.push(`第 ${ln} 行 粗体列表`);
    });
    bad.length
      ? fail('主体区 Markdown 污染', bad.slice(0, 5).join('; ') + (bad.length > 5 ? ` 等 ${bad.length} 处` : ''))
      : pass('主体区 Markdown 污染', '无表格、编号列表、粗体列表');
  }

  // ---------- 3. 空值 ----------
  {
    const empties = [];
    (function walk(node, path) {
      if (node === null || node === undefined) { empties.push(path); return; }
      if (Array.isArray(node)) {
        if (!node.length) empties.push(path + ' (空数组)');
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      } else if (typeof node === 'string' && !node.trim()) empties.push(path + ' (空字符串)');
    })(doc, '');
    empties.length
      ? warn('空值', empties.slice(0, 5).join('; ') + (empties.length > 5 ? ` 等 ${empties.length} 处` : ''))
      : pass('空值', '无空字段');
  }

  // ---------- 4. 条件检查：层表自洽（只有存在时才查）----------
  if (doc && doc.layer_order && Array.isArray(doc.layer_order.layers)) {
    const levels = doc.layer_order.layers.map(l => l.level);
    const sorted = [...levels].sort((a, b) => a - b);
    const asc = JSON.stringify(levels) === JSON.stringify(sorted);
    const uniq = levels.length === new Set(levels).size;
    const contiguous = levels.every((_, i) => levels.includes(i + 1));

    asc ? pass('层表顺序', '升序') : fail('层表顺序', `乱序: ${levels.join(',')}`);
    uniq ? pass('层表唯一性', '无重复') : fail('层表唯一性', `重复: ${levels}`);
    contiguous ? pass('层表连续性', `1–${Math.max(...levels)} 无空档`) : warn('层表连续性', `有空档: ${levels.join(',')}`);
  }
}

// ---------- 5. 代码块解析 ----------
{
  const blocks = [...src.matchAll(/```yaml\n([\s\S]*?)```/g)];
  if (!blocks.length) warn('代码块', '没有 ```yaml 块（如果文件里不该有，忽略这条）');
  else {
    let ok = 0;
    blocks.forEach((b, i) => {
      try { YAML.parse(b[1], { uniqueKeys: true }); ok++; }
      catch (e) { fail(`代码块 #${i + 1}`, String(e.message).split('\n')[0]); }
    });
    if (ok === blocks.length) pass('代码块', `${blocks.length} 块全部可解析`);
  }
}

// ---------- 6. 交叉引用（Markdown 区）----------
{
  const refs = new Set([...src.matchAll(/第\s*(\d+)\s*节/g)].map(m => +m[1]));
  const declared = new Set([...src.matchAll(/^# (\d+)\. /gm)].map(m => +m[1]));
  if (refs.size && declared.size) {
    const bad = [...refs].filter(n => !declared.has(n));
    bad.length
      ? fail('章节引用', `引用了不存在的节: ${bad.join(', ')}`)
      : pass('章节引用', `${refs.size} 个引用全部存在`);
  } else if (refs.size) {
    warn('章节引用', `引用了 ${refs.size} 个节，但没找到「# N. 标题」格式的声明`);
  }
}

// ---------- 输出 ----------
const ICON = { PASS: '✓', FAIL: '✗', WARN: '!' };
for (const r of results) console.log(`${ICON[r.level]} [${r.level}] ${r.name}: ${r.detail}`);

const fails = results.filter(r => r.level === 'FAIL').length;
const warns = results.filter(r => r.level === 'WARN').length;
console.log(`\n${results.length} 项检查，${fails} 项失败，${warns} 项警告`);
process.exit(fails ? 1 : 0);
