/**
 * 从超星学习通章节测验页面提取题目数据，导出为 JSON。
 * 自动检测并解码 cxSecret 字体混淆。
 * 
 * 用法: node extract_quiz.js [html文件路径] [选项]
 * 选项:
 *   --decode      尝试自动解码 cxSecret 字体混淆
 *   --ref <路径>  指定参考字体路径 (默认: simhei.ttf)
 *   --out <路径>  指定输出 JSON 路径 (默认: quiz_export.json)
 * 
 * 示例:
 *   node extract_quiz.js
 *   node extract_quiz.js work.html --decode
 *   node extract_quiz.js work.html --decode --ref "C:/Windows/Fonts/simhei.ttf"
 */

const fs = require('fs');
const path = require('path');

// ── 命令行参数 ──────────────────────────────────────────────
const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--') && !a.startsWith('-')) || '学生学习页面_files/work.html';
const outputFile = (() => {
  const idx = args.indexOf('--out'); return idx >= 0 ? args[idx + 1] : 'quiz_export.json';
})();
const doDecode = args.includes('--decode');
const refFont = (() => {
  const idx = args.indexOf('--ref'); return idx >= 0 ? args[idx + 1] : null;
})();

// ── 读取 HTML ───────────────────────────────────────────────
let html;
try {
  html = fs.readFileSync(inputFile, 'utf-8');
} catch (e) {
  console.error(`无法读取文件: ${inputFile}`);
  process.exit(1);
}

// ── 辅助函数 ───────────────────────────────────────────────

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function extractBetween(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return '';
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) return text.substring(startIdx + startMarker.length);
  return text.substring(startIdx + startMarker.length, endIdx);
}

// ── cxSecret 字体解码 ──────────────────────────────────────

/**
 * 从 HTML 中提取 cxSecret TTF 字体数据
 * @returns {Buffer|null} TTF 文件内容
 */
function extractCxSecretFont(html) {
  const match = html.match(/font-cxsecret[^}]*?base64,([A-Za-z0-9+/=]+)/);
  if (!match) return null;
  try {
    return Buffer.from(match[1].trim(), 'base64');
  } catch (e) {
    return null;
  }
}

/**
 * 从 TTF 字体提取 cxSecret 混淆映射表
 * 使用字形特征匹配（需参考字体）
 */
function decodeCxSecretFont(ttfBuf, refFontPath) {
  try {
    const { decodeCxSecret: decoder, mappingToSimple } = require('./cxsecret-decoder.js');
    const result = decoder(ttfBuf, refFontPath, { verbose: true, maxCandidates: 5000 });
    console.log(`[cxSecret] 自动解码置信度: ${(result.avgConfidence * 100).toFixed(1)}%`);
    return mappingToSimple(result.mapping);
  } catch (e) {
    console.warn('[cxSecret] 自动解码失败:', e.message);
    return null;
  }
}

/**
 * 已知的 cxSecret 映射表（当自动解码不可用时使用）
 * 此表覆盖该课程中使用的字体，其他课程可能需要补充
 */
const KNOWN_CXSECRET_MAP = {
  0x6091: 0x5C42, // 悑 → 层
  0x6092: 0x679C, // 悒 → 果
  0x6093: 0x4F1A, // 悓 → 会
  0x6095: 0x4EC0, // 悕 → 什
  0x6096: 0x754C, // 悖 → 界
  0x6097: 0x5982, // 悗 → 如
  0x6098: 0x751F, // 悘 → 生
  0x609A: 0x4E86, // 悚 → 了
  0x609B: 0x6700, // 悛 → 最
  0x609C: 0x591A, // 悜 → 多
  0x609D: 0x7AEF, // 悝 → 端
  0x609E: 0x4E00, // 悞 → 一
  0x60A1: 0x4E2A, // 悡 → 个
  0x60A2: 0x7684, // 悢 → 的
  0x60A4: 0x7AD9, // 悤 → 站
  0x60A5: 0x90FD, // 悥 → 都
  0x60A7: 0x7F51, // 悧 → 网
  0x60A9: 0x4EA4, // 悩 → 交
  0x6128: 0x5230, // 愨 → 到
};

/**
 * 使用映射表解码文本
 */
function decodeText(text, mapping) {
  if (!text || !mapping) return text;
  return text.split('').map(c => {
    const cp = c.codePointAt(0);
    return mapping[cp] ? String.fromCodePoint(mapping[cp]) : c;
  }).join('');
}

// ── 获取解码映射表 ─────────────────────────────────────────
let decodeMap = null;

if (doDecode) {
  const ttfBuf = extractCxSecretFont(html);
  if (ttfBuf) {
    console.log('[cxSecret] 检测到 cxSecret 字体，大小:', ttfBuf.length, 'bytes');

    // 尝试找参考字体
    const refCandidates = [
      refFont,
      'C:/Windows/Fonts/simhei.ttf',
      'C:/Windows/Fonts/simsun.ttf',
      'C:/Windows/Fonts/msyh.ttf',
    ].filter(Boolean);

    let refFound = null;
    for (const cand of refCandidates) {
      if (fs.existsSync(cand)) {
        refFound = cand;
        break;
      }
    }

    if (refFound) {
      console.log('[cxSecret] 使用参考字体:', refFound);
      const autoMap = decodeCxSecretFont(ttfBuf, refFound);
      // 将自动映射与已知映射合并（已知映射优先级更高）
      if (autoMap) {
        decodeMap = { ...autoMap, ...KNOWN_CXSECRET_MAP };
      } else {
        decodeMap = KNOWN_CXSECRET_MAP;
      }
    } else {
      console.log('[cxSecret] 未找到参考字体，使用已知映射表');
      decodeMap = KNOWN_CXSECRET_MAP;
    }
  } else {
    console.log('[cxSecret] 未检测到 cxSecret 字体');
  }
} else {
  // 即使不显式解码，也检测字体并提示
  const ttfBuf = extractCxSecretFont(html);
  if (ttfBuf) {
    console.log('[cxSecret] ⚠️  检测到 cxSecret 字体混淆！题目文本为乱码。');
    console.log('[cxSecret]    使用 --decode 参数可自动解码（需参考字体）');
    console.log('[cxSecret]    或在脚本中设置 decodeMap 变量');
    // 静默使用已知映射
    decodeMap = KNOWN_CXSECRET_MAP;
  }
}

// ── 提取测验元数据 ──────────────────────────────────────────

const titleMatch = html.match(/<h3>([^<]+)<\/h3>/);
const quizTitle = titleMatch ? titleMatch[1].trim() : '';

const metas = {};
const metaRegex = /<span>([^<:：]+)[:：]?\s*([^<]*)<\/span>/g;
let metaMatch;
while ((metaMatch = metaRegex.exec(html)) !== null) {
  const key = metaMatch[1].trim();
  const val = metaMatch[2].trim();
  if (key && val) metas[key] = val;
}

const hiddenFields = {};
const hiddenRegex = /<input[^>]+id="(\w+)"[^>]+value="([^"]*)"/g;
let hiddenMatch;
while ((hiddenMatch = hiddenRegex.exec(html)) !== null) {
  hiddenFields[hiddenMatch[1]] = hiddenMatch[2];
}

const statusMatch = html.match(/testTit_status[^>]*>[\s\S]*?<\/i>\s*([^<]*)</);
const status = statusMatch ? statusMatch[1].trim() : '';

// ── 提取题目 ────────────────────────────────────────────────

const questions = [];
const timuRegex = /<div class="TiMu newTiMu ans-cc singleQuesId" data="(\d+)">([\s\S]*?)(?=<div class="TiMu newTiMu|<div class="ZY_sub|<\/form>)/g;
let timuMatch;

while ((timuMatch = timuRegex.exec(html)) !== null) {
  const quesId = timuMatch[1];
  const quesHtml = timuMatch[2];

  const numMatch = quesHtml.match(/<i class="fl"[^>]*>(\d+)<\/i>/);
  const number = numMatch ? parseInt(numMatch[1]) : null;

  const typeMatch = quesHtml.match(/<span class="newZy_TItle">([^<]*)<\/span>/);
  const typeLabel = typeMatch ? stripHtml(typeMatch[1]) : '';

  // 题目文本 — 可能跨多个 <p>
  const titleDiv = extractBetween(quesHtml, '<div class="clearfix font-cxsecret fontLabel"', '</div>');
  const pRegex = /<p>([\s\S]*?)<\/p>/g;
  const questionTextParts = [];
  let pMatch;
  while ((pMatch = pRegex.exec(titleDiv)) !== null) {
    const text = stripHtml(pMatch[1]);
    if (text) questionTextParts.push(text);
  }

  // 我的答案
  const answerDiv = extractBetween(quesHtml, '<div class="myAllAnswerBx">', '<!--显示答案解析-->');
  const answerPRegex = /<div class="myAnswer[^"]*">([\s\S]*?)<\/div>/g;
  let answerText = '';
  let aMatch;
  while ((aMatch = answerPRegex.exec(answerDiv)) !== null) {
    const content = aMatch[1];
    if (content.includes('answerFont')) continue;
    const pTextMatch = content.match(/<p>([\s\S]*?)<\/p>/);
    if (pTextMatch) {
      answerText += (answerText ? '\n' : '') + stripHtml(pTextMatch[1]);
    }
  }

  // 原始题目文本（混淆版）
  const rawQuestion = questionTextParts.join('\n');

  // 解码题目文本
  const decodedQuestion = decodeMap ? decodeText(rawQuestion, decodeMap) : rawQuestion;

  questions.push({
    id: quesId,
    number: number,
    type: typeLabel,
    question: decodedQuestion,
    questionRaw: decodedQuestion !== rawQuestion ? rawQuestion : undefined,
    answer: answerText
  });
}

// ── 构建输出 ────────────────────────────────────────────────

const decodedCount = decodeMap ? questions.filter(q => q.questionRaw).length : 0;

const result = {
  exportedAt: new Date().toISOString(),
  sourceFile: inputFile,
  decoded: decodedCount > 0,
  decodeMethod: doDecode ? 'auto' : 'known-mapping',
  quiz: {
    title: quizTitle,
    status: status,
    metadata: metas,
    courseId: hiddenFields.courseId || '',
    classId: hiddenFields.classId || '',
    cpi: hiddenFields.cpi || '',
    workId: hiddenFields.workId || '',
    answerId: hiddenFields.answerId || '',
    questionCount: questions.length
  },
  questions: questions
};

// ── 写入 JSON ───────────────────────────────────────────────

fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');
console.log(`✅ 成功导出 ${questions.length} 道题目 → ${outputFile}`);
console.log(`   测验名称: ${quizTitle}`);
console.log(`   题量: ${questions.length}`);
if (decodedCount > 0) {
  console.log(`   🔓 已解码 ${decodedCount} 道题目的 cxSecret 字体混淆`);
}
if (decodeMap) {
  const mapSize = Object.keys(decodeMap).length;
  console.log(`   映射表: ${mapSize} 个字符`);
}
