/**
 * 从超星学习通章节测验页面提取题目数据，导出为 JSON。
 * 
 * 用法: node extract_quiz.js [html文件路径]
 * 默认读取: 学生学习页面_files/work.html
 * 输出: quiz_export.json
 */

const fs = require('fs');
const path = require('path');

// ── 命令行参数 ──────────────────────────────────────────────
const inputFile = process.argv[2] || '学生学习页面_files/work.html';
const outputFile = process.argv[3] || 'quiz_export.json';

// ── 读取 HTML ───────────────────────────────────────────────
let html;
try {
  html = fs.readFileSync(inputFile, 'utf-8');
} catch (e) {
  console.error(`无法读取文件: ${inputFile}`);
  process.exit(1);
}

// ── 辅助函数 ───────────────────────────────────────────────

/** 提取纯文本，去除 HTML 标签并 trim */
function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** 安全地提取两个标记之间的内容 */
function extractBetween(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return '';
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) return text.substring(startIdx + startMarker.length);
  return text.substring(startIdx + startMarker.length, endIdx);
}

/** 提取所有匹配的块 */
function extractBlocks(text, startMarker, endMarker) {
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const startIdx = text.indexOf(startMarker, searchFrom);
    if (startIdx === -1) break;
    const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
    if (endIdx === -1) break;
    blocks.push(text.substring(startIdx, endIdx + endMarker.length));
    searchFrom = endIdx + endMarker.length;
  }
  return blocks;
}

// ── 提取测验元数据 ──────────────────────────────────────────

// 测验名称
const titleMatch = html.match(/<h3>([^<]+)<\/h3>/);
const quizTitle = titleMatch ? titleMatch[1].trim() : '';

// 题量 & 满分
const metas = {};
const metaRegex = /<span>([^<:：]+)[:：]?\s*([^<]*)<\/span>/g;
let metaMatch;
while ((metaMatch = metaRegex.exec(html)) !== null) {
  const key = metaMatch[1].trim();
  const val = metaMatch[2].trim();
  if (key && val) metas[key] = val;
}

// 隐藏字段
const hiddenFields = {};
const hiddenRegex = /<input[^>]+id="(\w+)"[^>]+value="([^"]*)"/g;
let hiddenMatch;
while ((hiddenMatch = hiddenRegex.exec(html)) !== null) {
  hiddenFields[hiddenMatch[1]] = hiddenMatch[2];
}

// 测验状态
const statusMatch = html.match(/testTit_status[^>]*>[\s\S]*?<\/i>\s*([^<]*)</);
const status = statusMatch ? statusMatch[1].trim() : '';

// ── 提取题目 ────────────────────────────────────────────────

const questions = [];

// 用正则匹配每个 TiMu 块
const timuRegex = /<div class="TiMu newTiMu ans-cc singleQuesId" data="(\d+)">([\s\S]*?)(?=<div class="TiMu newTiMu|<div class="ZY_sub|<\/form>)/g;
let timuMatch;

while ((timuMatch = timuRegex.exec(html)) !== null) {
  const quesId = timuMatch[1];
  const quesHtml = timuMatch[2];

  // 题号
  const numMatch = quesHtml.match(/<i class="fl"[^>]*>(\d+)<\/i>/);
  const number = numMatch ? parseInt(numMatch[1]) : null;

  // 题型标签
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
    // 跳过 "我的答案：" 标签
    const content = aMatch[1];
    if (content.includes('answerFont')) continue; // 跳过标签行
    const pTextMatch = content.match(/<p>([\s\S]*?)<\/p>/);
    if (pTextMatch) {
      answerText += (answerText ? '\n' : '') + stripHtml(pTextMatch[1]);
    }
  }

  questions.push({
    id: quesId,
    number: number,
    type: typeLabel,
    question: questionTextParts.join('\n'),
    answer: answerText
  });
}

// ── 构建输出 ────────────────────────────────────────────────

const result = {
  exportedAt: new Date().toISOString(),
  sourceFile: inputFile,
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
