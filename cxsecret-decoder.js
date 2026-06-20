/**
 * cxSecret 字体解码器
 * 自动识别超星 cxSecret 混淆字体中的字符映射，支持多种参考字体。
 * 
 * 工作原理：
 * 1. 解析混淆 TTF，提取 cmap 表（混淆码点 → 字形索引）
 * 2. 为每个字形计算特征指纹（轮廓数、命令数、命令类型直方图、包围盒比例等）
 * 3. 在参考字体中查找最匹配的字形 → 得到真实字符
 * 4. 输出解码映射表
 */

const opentype = require('opentype.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════
//  字形特征提取
// ═══════════════════════════════════════════════════════════

/**
 * 计算字形的特征指纹
 * 设计为在不同字体（同一字符）之间尽可能一致
 */
function computeGlyphFingerprint(glyph, fontSize = 72) {
  const path = glyph.getPath(0, 0, fontSize);
  const bbox = glyph.getBoundingBox();
  if (!bbox) return null;

  // 归一化尺寸（相对于 em-square 1000）
  const w = bbox.x2 - bbox.x1;
  const h = bbox.y2 - bbox.y1;
  const aspectRatio = h > 0 ? w / h : 0;

  // 命令类型统计
  const cmdTypes = {};
  let contourCount = 0;
  const cmdSequence = [];

  for (const cmd of path.commands) {
    const type = cmd.type;
    cmdTypes[type] = (cmdTypes[type] || 0) + 1;
    cmdSequence.push(type);
    if (type === 'M') contourCount++;
  }

  // 命令类型直方图（归一化）
  const cmdTypeKeys = ['M', 'L', 'C', 'Q', 'Z'];
  const cmdHistogram = cmdTypeKeys.map(k => cmdTypes[k] || 0);

  // 命令类型序列的哈希（前 20 个命令足够区分）
  const cmdTypeSeq = cmdSequence.slice(0, 30).join('');
  const seqHash = crypto.createHash('md5').update(cmdTypeSeq).digest('hex').substring(0, 8);

  return {
    contourCount,
    cmdCount: path.commands.length,
    cmdHistogram,        // [M, L, C, Q, Z] 计数
    width: Math.round(w),
    height: Math.round(h),
    aspectRatio: Math.round(aspectRatio * 100) / 100,
    seqHash,
  };
}

/**
 * 计算两个指纹之间的距离（越小越相似）
 */
function fingerprintDistance(a, b) {
  if (!a || !b) return Infinity;

  let dist = 0;

  // 轮廓数差异（高权重）
  const contourDiff = Math.abs(a.contourCount - b.contourCount);
  dist += contourDiff * 100;

  // 命令数比率差异
  const cmdRatio = Math.max(a.cmdCount, b.cmdCount) / Math.max(1, Math.min(a.cmdCount, b.cmdCount));
  dist += Math.abs(cmdRatio - 1) * 50;

  // 长宽比差异
  const arDiff = Math.abs(a.aspectRatio - b.aspectRatio);
  dist += arDiff * 200;

  // 归一化尺寸差异
  const wDiff = Math.abs(a.width - b.width) / Math.max(1, Math.max(a.width, b.width));
  const hDiff = Math.abs(a.height - b.height) / Math.max(1, Math.max(a.height, b.height));
  dist += (wDiff + hDiff) * 100;

  // 命令直方图相似度（余弦距离）
  const dotA = Math.sqrt(a.cmdHistogram.reduce((s, v) => s + v * v, 0));
  const dotB = Math.sqrt(b.cmdHistogram.reduce((s, v) => s + v * v, 0));
  if (dotA > 0 && dotB > 0) {
    const cosine = a.cmdHistogram.reduce((s, v, i) => s + v * b.cmdHistogram[i], 0) / (dotA * dotB);
    dist += (1 - cosine) * 80;
  }

  return dist;
}

// ═══════════════════════════════════════════════════════════
//  主解码逻辑
// ═══════════════════════════════════════════════════════════

/**
 * 解码 cxSecret 字体
 * @param {Buffer|string} ttfData - TTF 文件 Buffer 或路径
 * @param {Buffer|string} refFontData - 参考字体 Buffer 或路径 (如 SimHei, Microsoft YaHei)
 * @param {Object} options
 * @returns {Object} { mapping: {scrambledCodepoint: realCodepoint}, table: Map, confidence: number }
 */
function decodeCxSecret(ttfData, refFontData, options = {}) {
  const ttfBuf = typeof ttfData === 'string' ? fs.readFileSync(ttfData) : ttfData;
  const refBuf = typeof refFontData === 'string' ? fs.readFileSync(refFontData) : refFontData;

  const cxFont = opentype.parse(ttfBuf.buffer);
  const refFont = opentype.parse(refBuf.buffer);

  const minConfidence = options.minConfidence || 0.3;
  const maxCandidates = options.maxCandidates || 5000;
  const verbose = options.verbose || false;

  // 1. 从 cxSecret 字体提取 cmap 和字形指纹
  const cxCmap = cxFont.tables.cmap.glyphIndexMap || {};
  const cxGlyphs = [];

  for (const [codeStr, glyphIdx] of Object.entries(cxCmap)) {
    const code = parseInt(codeStr);
    const glyph = cxFont.glyphs.get(glyphIdx);
    if (!glyph) continue;

    const fp = computeGlyphFingerprint(glyph);
    if (!fp) continue;

    cxGlyphs.push({
      scrambledCode: code,
      scrambledChar: String.fromCodePoint(code),
      glyphIdx,
      fingerprint: fp,
    });
  }

  if (verbose) console.log(`[cxSecret] 混淆字体包含 ${cxGlyphs.length} 个字符`);

  // 2. 从参考字体提取常见 CJK 字符的字形指纹
  const refCmap = refFont.tables.cmap.glyphIndexMap || {};
  const refGlyphs = [];

  // 只考虑常用 CJK 统一表意文字 (U+4E00-U+9FFF) 和 CJK 扩展 A (U+3400-U+4DBF)
  const cjkRanges = [
    [0x4E00, 0x9FFF],   // CJK Unified Ideographs
    [0x3400, 0x4DBF],   // CJK Extension A
  ];

  let scanned = 0;
  for (const [codeStr, glyphIdx] of Object.entries(refCmap)) {
    const code = parseInt(codeStr);
    // 只考虑 CJK 范围内的字符
    const inRange = cjkRanges.some(([lo, hi]) => code >= lo && code <= hi);
    if (!inRange) continue;

    if (scanned >= maxCandidates) break;

    const glyph = refFont.glyphs.get(glyphIdx);
    if (!glyph) continue;

    const fp = computeGlyphFingerprint(glyph);
    if (!fp) continue;

    refGlyphs.push({
      code,
      char: String.fromCodePoint(code),
      glyphIdx,
      fingerprint: fp,
    });
    scanned++;
  }

  if (verbose) console.log(`[cxSecret] 参考字体包含 ${refGlyphs.length} 个 CJK 字符`);

  // 3. 为每个混淆字符找最佳匹配
  const mapping = {};
  let totalConfidence = 0;

  for (const cxGlyph of cxGlyphs) {
    let bestMatch = null;
    let bestDist = Infinity;
    let secondBestDist = Infinity;

    for (const refGlyph of refGlyphs) {
      const dist = fingerprintDistance(cxGlyph.fingerprint, refGlyph.fingerprint);
      if (dist < bestDist) {
        secondBestDist = bestDist;
        bestDist = dist;
        bestMatch = refGlyph;
      } else if (dist < secondBestDist) {
        secondBestDist = dist;
      }
    }

    if (bestMatch) {
      // 置信度：最佳匹配与第二匹配之间的距离差距
      const confidence = secondBestDist === Infinity ? 1.0 :
        Math.min(1.0, (secondBestDist - bestDist) / Math.max(1, bestDist + secondBestDist) * 10);

      mapping[cxGlyph.scrambledCode] = {
        realCode: bestMatch.code,
        realChar: bestMatch.char,
        confidence: Math.round(confidence * 100) / 100,
        distance: Math.round(bestDist * 100) / 100,
      };
      totalConfidence += confidence;
    }
  }

  const avgConfidence = cxGlyphs.length > 0 ? totalConfidence / cxGlyphs.length : 0;

  if (verbose) {
    console.log(`[cxSecret] 平均置信度: ${(avgConfidence * 100).toFixed(1)}%`);
    console.log('[cxSecret] 映射表:');
    for (const [sc, info] of Object.entries(mapping)) {
      const sChar = String.fromCodePoint(parseInt(sc));
      console.log(`  U+${parseInt(sc).toString(16).toUpperCase()} ${sChar} → U+${info.realCode.toString(16).toUpperCase()} ${info.realChar} (置信度: ${(info.confidence*100).toFixed(0)}%)`);
    }
  }

  return {
    mapping,
    scrambledCount: cxGlyphs.length,
    refCount: refGlyphs.length,
    avgConfidence,
  };
}

/**
 * 应用解码映射到文本
 */
function decodeText(text, mapping) {
  if (!text || !mapping) return text;
  return text.split('').map(c => {
    const cp = c.codePointAt(0);
    const info = mapping[cp];
    return info ? info.realChar : c;
  }).join('');
}

/**
 * 将映射转换为简单的 {scrambledCodepoint: realCodepoint} 格式
 */
function mappingToSimple(mapping) {
  const simple = {};
  for (const [sc, info] of Object.entries(mapping)) {
    simple[parseInt(sc)] = info.realCode;
  }
  return simple;
}

// ═══════════════════════════════════════════════════════════
//  已知映射（基于常见 cxSecret 字体）
// ═══════════════════════════════════════════════════════════

// 当自动匹配置信度不足时，可手动补充
const KNOWN_MAPPINGS = {
  // 此处的映射可在遇到新字体时扩充
};

// ═══════════════════════════════════════════════════════════
//  导出
// ═══════════════════════════════════════════════════════════

module.exports = {
  decodeCxSecret,
  decodeText,
  mappingToSimple,
  computeGlyphFingerprint,
  fingerprintDistance,
  KNOWN_MAPPINGS,
};

// ═══════════════════════════════════════════════════════════
//  CLI 入口
// ═══════════════════════════════════════════════════════════
if (require.main === module) {
  const args = process.argv.slice(2);
  const ttfPath = args[0] || 'cxsecret.ttf';
  const refPath = args[1] || 'C:/Windows/Fonts/simhei.ttf';
  const verbose = !args.includes('--quiet');

  if (!fs.existsSync(ttfPath)) {
    console.error('错误: 找不到 cxSecret 字体文件:', ttfPath);
    console.error('用法: node cxsecret-decoder.js <cxsecret.ttf> [参考字体.ttf]');
    process.exit(1);
  }

  if (!fs.existsSync(refPath)) {
    console.error('错误: 找不到参考字体文件:', refPath);
    console.error('请指定一个包含 CJK 字符的 TrueType 字体');
    process.exit(1);
  }

  const result = decodeCxSecret(ttfPath, refPath, { verbose });

  if (result.avgConfidence < 0.5) {
    console.log(`\n⚠️  平均置信度较低 (${(result.avgConfidence*100).toFixed(1)}%)，建议检查映射结果`);
  }

  // 输出简单映射表
  console.log('\n// 复制此映射表到你的代码中:');
  console.log('const CXSECRET_MAPPING = {');
  for (const [sc, info] of Object.entries(result.mapping)) {
    console.log(`  0x${parseInt(sc).toString(16).toUpperCase()}: 0x${info.realCode.toString(16).toUpperCase()}, // ${String.fromCodePoint(parseInt(sc))} → ${info.realChar} (${(info.confidence*100).toFixed(0)}%)`);
  }
  console.log('};');
}
