/**
 * cxSecret 字体解码器 v3.0
 * 
 * 使用 Typr.js 解析 TTF 字体 → 计算字形路径哈希 → 查表解码
 * Typr.js 提取自 ABC超星学习通助手 v4.6.0，与远程 table.json 哈希表完全兼容。
 * 
 * 用法:
 *   node cxsecret-decoder.js [cxsecret.ttf] [--table-url <url>] [--out mapping.json]
 * 
 * 依赖:
 *   typr-cxsecret.js  (Typr TrueType 解析库)
 */

const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { Typr } = require('./typr-cxsecret.js');

// ═══════════════════════════════════════════════════════════
//  网络请求
// ═══════════════════════════════════════════════════════════

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════
//  核心：构建解码映射
// ═══════════════════════════════════════════════════════════

/**
 * 从 cxSecret TTF 字体和哈希查找表构建解码映射
 * 
 * 算法（与 ABC 脚本一致）：
 *   1. 遍历所有 CJK 统一表意文字 (U+4E00-U+9FA5)
 *   2. 检查 cxSecret 字体是否有该码点的字形
 *   3. 若有，用 Typr 获取字形路径
 *   4. md5(JSON.stringify(path)).slice(24) → 8字符哈希
 *   5. 查 table.json 获取真实 Unicode 码点
 * 
 * @param {Uint8Array} ttfData - cxSecret TTF 字体数据
 * @param {Object} lookupTable - { hash8: realCodepoint, ... }
 * @returns {Object} { scrambledCodepoint: realCodepoint, ... }
 */
function buildDecryptionTable(ttfData, lookupTable) {
  const fonts = Typr.parse(ttfData.buffer);
  const font = fonts[0];
  const match = {};

  const CHINESE_CHAR_START = 0x4E00; // 19968  CJK 统一表意文字起始
  const CHINESE_CHAR_END   = 0x9FA5; // 40869  常用 CJK 结束

  for (let charCode = CHINESE_CHAR_START; charCode <= CHINESE_CHAR_END; charCode++) {
    const glyphIdx = Typr.U.codeToGlyph(font, charCode);
    if (!glyphIdx) continue;

    const path = Typr.U.glyphToPath(font, glyphIdx);
    const hash = crypto.createHash('md5').update(JSON.stringify(path)).digest('hex').slice(24);
    const realCode = lookupTable[hash];

    if (realCode !== undefined) {
      match[charCode] = realCode;
    }
  }

  return match;
}

/**
 * 使用解码表解码文本
 */
function decodeText(text, decryptionTable) {
  if (!text || !decryptionTable) return text;
  return text.split('').map(c => {
    const cp = c.codePointAt(0);
    return decryptionTable[cp] ? String.fromCodePoint(decryptionTable[cp]) : c;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
//  远程查找表
// ═══════════════════════════════════════════════════════════

const DEFAULT_TABLE_URLS = [
  'https://www.forestpolice.org/ttf/2.0/table.json',
  'https://cs.dkjdda.top/table.json',
];

async function fetchLookupTable(customUrl) {
  const urls = customUrl ? [customUrl, ...DEFAULT_TABLE_URLS] : DEFAULT_TABLE_URLS;

  for (const url of urls) {
    try {
      console.log(`[decode] 下载查找表: ${url}`);
      const json = await httpGet(url);
      const table = JSON.parse(json);
      console.log(`[decode] 查找表加载成功，${Object.keys(table).length} 个条目`);
      return table;
    } catch (e) {
      console.warn(`[decode] 下载失败: ${url} - ${e.message}`);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const ttfPath = args.find(a => !a.startsWith('--') && /\.(ttf|otf)$/i.test(a));
  const tableUrlIdx = args.indexOf('--table-url');
  const tableUrl = tableUrlIdx >= 0 ? args[tableUrlIdx + 1] : null;
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const verbose = args.includes('--verbose') || args.includes('-v');

  if (!ttfPath) {
    console.error('用法: node cxsecret-decoder.js <font.ttf> [--table-url <url>] [--out mapping.json]');
    process.exit(1);
  }

  if (!fs.existsSync(ttfPath)) {
    console.error('字体文件不存在:', ttfPath);
    process.exit(1);
  }

  console.log('[decode] 加载字体:', ttfPath);
  const ttfBuf = fs.readFileSync(ttfPath);

  console.log('[decode] 获取查找表...');
  const lookupTable = await fetchLookupTable(tableUrl);
  if (!lookupTable) {
    console.error('[decode] 无法获取查找表，请检查网络或使用 --table-url 指定');
    process.exit(1);
  }

  console.log('[decode] 构建解码映射 (遍历 U+4E00-U+9FA5)...');
  const ttfData = new Uint8Array(ttfBuf);
  const mapping = buildDecryptionTable(ttfData, lookupTable);

  console.log(`\n解码映射表 (${Object.keys(mapping).length} 个字符):`);
  const lines = [];
  for (const [sc, real] of Object.entries(mapping)) {
    const sChar = String.fromCodePoint(parseInt(sc));
    const rChar = String.fromCodePoint(real);
    const line = `  U+${parseInt(sc).toString(16).toUpperCase()} ${sChar} → U+${real.toString(16).toUpperCase()} ${rChar}`;
    console.log(line);
    lines.push(line);
  }

  if (Object.keys(mapping).length === 0) {
    console.warn('\n⚠️  未找到映射。可能此字体不是 cxSecret 字体，或查找表版本不匹配。');
    return;
  }

  // 输出可直接使用的映射代码
  console.log('\n// 复制到你的 extract_quiz.js 或 Tampermonkey 脚本中:');
  console.log('const CXSECRET_MAPPING = {');
  for (const [sc, real] of Object.entries(mapping)) {
    console.log(`  0x${parseInt(sc).toString(16).toUpperCase()}: 0x${real.toString(16).toUpperCase()}, // ${String.fromCodePoint(parseInt(sc))} → ${String.fromCodePoint(real)}`);
  }
  console.log('};');

  // 保存 JSON
  if (outPath) {
    // 保存为简单的 {scrambledHex: realHex} 格式
    const exportMap = {};
    for (const [sc, real] of Object.entries(mapping)) {
      exportMap['0x' + parseInt(sc).toString(16).toUpperCase()] = '0x' + real.toString(16).toUpperCase();
    }
    fs.writeFileSync(outPath, JSON.stringify(exportMap, null, 2), 'utf-8');
    console.log(`\n💾 映射表已保存到: ${outPath}`);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { buildDecryptionTable, decodeText, fetchLookupTable, httpGet };
