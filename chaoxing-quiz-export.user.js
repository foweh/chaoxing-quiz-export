// ==UserScript==
// @name         超星学习通 - 章节测验导出 + 循环练习
// @namespace    https://mooc1.chaoxing.com
// @version      1.0.0
// @description  一键导出所有章节测验题目为 JSON + 生成独立的循环练习 HTML 页面
// @author       You
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        https://mooc1.chaoxing.com/mooc-ans/knowledge/cards*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      mooc1.chaoxing.com
// @connect      mooc1-ans.chaoxing.com
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  配置
  // ═══════════════════════════════════════════════════════════
  const CONFIG = {
    panelId: 'cx-export-panel',
    // 抓取间隔(ms)，避免请求过快
    fetchDelay: 800,
    // cards 页面 URL 模板
    cardsUrl: '/mooc-ans/knowledge/cards',
    // quiz API URL 模板
    quizApiUrl: '/mooc-ans/api/work',
    // 课程基础参数（从页面提取，也可手动覆盖）
    courseId: null,
    clazzId: null,
    cpi: null,
  };

  // ═══════════════════════════════════════════════════════════
  //  工具函数
  // ═══════════════════════════════════════════════════════════

  /** 去除 HTML 标签 */
  function stripHtml(s) {
    if (!s) return '';
    return s
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 提取两个标记之间的内容 */
  function extractBetween(text, startMarker, endMarker, fromIndex) {
    const startIdx = text.indexOf(startMarker, fromIndex || 0);
    if (startIdx === -1) return { text: '', endIdx: -1 };
    const contentStart = startIdx + startMarker.length;
    const endIdx = text.indexOf(endMarker, contentStart);
    if (endIdx === -1) return { text: text.substring(contentStart), endIdx: text.length };
    return { text: text.substring(contentStart, endIdx), endIdx: endIdx + endMarker.length };
  }

  /** 简单的 HTML 转义（用于练习页面） */
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 延迟 */
  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 发起 GET 请求（走 GM_xmlhttpRequest 跨域） */
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        onload: (r) => resolve(r.responseText),
        onerror: (e) => reject(e),
        ontimeout: () => reject(new Error('timeout')),
        timeout: 15000,
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  从页面提取基础参数
  // ═══════════════════════════════════════════════════════════
  function extractBaseParams() {
    // 从 URL 提取
    const urlParams = new URLSearchParams(location.search);
    CONFIG.courseId = CONFIG.courseId || urlParams.get('courseId') || urlParams.get('courseid');
    CONFIG.clazzId = CONFIG.clazzId || urlParams.get('clazzid') || urlParams.get('clazzId');
    CONFIG.cpi = CONFIG.cpi || urlParams.get('cpi');

    // 从页面隐藏域提取
    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : null;
    };
    CONFIG.courseId = CONFIG.courseId || getVal('courseId') || getVal('curCourseId');
    CONFIG.clazzId = CONFIG.clazzId || getVal('clazzId');
    CONFIG.cpi = CONFIG.cpi || getVal('cpi');
  }

  // ═══════════════════════════════════════════════════════════
  //  解析课程目录树 → 章节列表
  // ═══════════════════════════════════════════════════════════
  function getChapterList() {
    const chapters = [];
    const tree = document.getElementById('coursetree');
    if (!tree) {
      console.warn('[CX Export] 未找到 #coursetree');
      return chapters;
    }

    // 遍历所有 .posCatalog_select（二级章节）
    const selects = tree.querySelectorAll('.posCatalog_select[id^="cur"]');
    selects.forEach((sel) => {
      const id = sel.id.replace('cur', ''); // knowledgeid
      const nameEl = sel.querySelector('.posCatalog_name');
      const title = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent).trim() : '';
      if (id && title) {
        chapters.push({ knowledgeId: id, title: title });
      }
    });
    return chapters;
  }

  // ═══════════════════════════════════════════════════════════
  //  抓取 cards 页面 → 提取 mArg
  // ═══════════════════════════════════════════════════════════
  async function fetchCardsMAarg(knowledgeId) {
    const params = new URLSearchParams({
      clazzid: CONFIG.clazzId,
      courseid: CONFIG.courseId,
      knowledgeid: knowledgeId,
      num: 0,
      ut: 's',
      cpi: CONFIG.cpi,
      mooc2: 1,
      isMicroCourse: false,
      editorPreview: 0,
    });
    const url = `https://mooc1.chaoxing.com${CONFIG.cardsUrl}?${params.toString()}`;
    try {
      const html = await gmGet(url);
      // 提取 mArg JSON
      const mArgMatch = html.match(/mArg\s*=\s*(\{[\s\S]*?\});/);
      if (!mArgMatch) return null;
      let mArgJson = mArgMatch[1];
      // 尝试清理可能的尾部逗号（简单处理）
      try {
        return JSON.parse(mArgJson);
      } catch (e) {
        // 如果解析失败，尝试更宽松的匹配
        const altMatch = html.match(/mArg\s*=\s*(.+?);\s*\n\s*}catch/);
        if (altMatch) {
          try {
            return JSON.parse(altMatch[1]);
          } catch (e2) {
            console.warn('[CX Export] mArg 解析失败:', knowledgeId, e2.message);
            return null;
          }
        }
        return null;
      }
    } catch (e) {
      console.warn('[CX Export] 获取 cards 失败:', knowledgeId, e.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  从 mArg 提取测验附件信息
  // ═══════════════════════════════════════════════════════════
  function getQuizAttachments(mArg) {
    if (!mArg || !mArg.attachments) return [];
    return mArg.attachments.filter((att) => att.type === 'workid').map((att) => ({
      workId: att.property ? att.property.workid : null,
      jobId: att.jobid || '',
      enc: att.enc || '',
      title: att.property ? att.property.title : '',
      worktype: att.property ? att.property.worktype : '',
      _jobid: att.property ? att.property._jobid : att.jobid || '',
      // 额外参数
      knowledgeid: mArg.defaults ? mArg.defaults.knowledgeid : null,
      ktoken: mArg.defaults ? mArg.defaults.ktoken : '',
    }));
  }

  // ═══════════════════════════════════════════════════════════
  //  抓取测验题目 HTML
  // ═══════════════════════════════════════════════════════════
  async function fetchQuizHtml(quizInfo) {
    const params = new URLSearchParams({
      api: 1,
      workId: quizInfo.workId,
      jobid: quizInfo.jobId,
      originJobId: quizInfo._jobid,
      needRedirect: true,
      skipHeader: true,
      knowledgeid: quizInfo.knowledgeid || '',
      ktoken: quizInfo.ktoken || '',
      cpi: CONFIG.cpi,
      ut: 's',
      clazzId: CONFIG.clazzId,
      type: quizInfo.worktype === 'workB' ? 'b' : '',
      enc: quizInfo.enc,
      mooc2: 1,
      courseid: CONFIG.courseId,
    });
    const url = `https://mooc1.chaoxing.com${CONFIG.quizApiUrl}?${params.toString()}`;
    return await gmGet(url);
  }

  // ═══════════════════════════════════════════════════════════
  //  解析题目 HTML → 结构化题目数组
  // ═══════════════════════════════════════════════════════════
  function parseQuestions(html) {
    const questions = [];

    // 匹配每个 TiMu 块
    const timuRegex = /<div class="TiMu newTiMu[^"]*" data="(\d+)"[^>]*>([\s\S]*?)(?=<div class="TiMu newTiMu|<div class="ZY_sub|<\/form>)/g;
    let match;

    while ((match = timuRegex.exec(html)) !== null) {
      const quesId = match[1];
      const block = match[2];

      // 题号
      const numMatch = block.match(/<i class="fl"[^>]*>(\d+)<\/i>/);
      const number = numMatch ? parseInt(numMatch[1]) : null;

      // 题型标签 — 从 .newZy_TItle 提取
      const typeMatch = block.match(/<span class="newZy_TItle">([^<]*)<\/span>/);
      const typeLabel = typeMatch ? stripHtml(typeMatch[1]) : '';

      // 题目文本 — 在 .font-cxsecret 或 .fontLabel 内
      let questionText = '';
      const fontDivMatch = block.match(/<div class="[^"]*font-cxsecret[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (fontDivMatch) {
        // 提取所有 <p> 标签
        const pRegex = /<p>([\s\S]*?)<\/p>/g;
        const parts = [];
        let pm;
        while ((pm = pRegex.exec(fontDivMatch[1])) !== null) {
          const t = stripHtml(pm[1]);
          if (t) parts.push(t);
        }
        questionText = parts.join('\n');
      }
      if (!questionText) {
        // 尝试直接匹配 p 标签
        const pRegex2 = /<p>([\s\S]*?)<\/p>/g;
        const parts2 = [];
        let pm2;
        while ((pm2 = pRegex2.exec(block)) !== null) {
          const t = stripHtml(pm2[1]);
          if (t && !t.includes('【') && !t.includes('】')) parts2.push(t);
        }
        questionText = parts2.join('\n');
      }

      // ── 根据不同题型解析选项和答案 ──
      let options = [];
      let answer = '';
      let answerText = ''; // 纯文本答案

      if (typeLabel.includes('单选') || typeLabel.includes('多选') || typeLabel.includes('判断')) {
        // 提取选项 — 通常在 .TiMu 内的 <li> 或 label 中
        // 常见格式: <li class="chooseli_li"><input type="radio"...><span>选项文本</span></li>
        const optRegex = /<(?:li|label|div)[^>]*?(?:class="[^"]*chooseli[^"]*"|class="[^"]*option[^"]*")[^>]*>([\s\S]*?)<\/(?:li|label|div)>/gi;
        let om;
        const optLabels = [];
        while ((om = optRegex.exec(block)) !== null) {
          const optHtml = om[1];
          const spanMatch = optHtml.match(/<span[^>]*>([\s\S]*?)<\/span>/);
          if (spanMatch) {
            optLabels.push(stripHtml(spanMatch[1]));
          } else {
            const txt = stripHtml(optHtml);
            if (txt && txt.length < 200) optLabels.push(txt);
          }
        }

        // 如果没匹配到，尝试匹配 <span class="fl">A</span> 模式
        if (optLabels.length === 0) {
          const letterRegex = /<span[^>]*class="fl"[^>]*>([A-Z])<\/span>\s*<div[^>]*>([\s\S]*?)<\/div>/gi;
          let lm;
          while ((lm = letterRegex.exec(block)) !== null) {
            optLabels.push(stripHtml(lm[2]));
          }
        }

        options = optLabels.map((text, i) => ({
          label: String.fromCharCode(65 + i), // A, B, C, D...
          text: text,
        }));

        // 正确答案 — 通常在 .rightAnswer 或 .correctAnswer 中
        const correctMatch = block.match(/(?:正确答案|rightanswer)[：:]\s*([^<\n]+)/i);
        if (correctMatch) {
          answer = correctMatch[1].trim();
        }

        // 也尝试从 data-answer 属性获取
        const dataAnsMatch = block.match(/data-answer="([^"]*)"/);
        if (dataAnsMatch) answer = dataAnsMatch[1];

      } else if (typeLabel.includes('填空')) {
        // 填空题 — 答案通常在 input 的 value 或特定 div 中
        const blankAnswers = [];
        const blankRegex = /<input[^>]*?value="([^"]*)"/g;
        let bm;
        while ((bm = blankRegex.exec(block)) !== null) {
          if (bm[1].trim()) blankAnswers.push(bm[1].trim());
        }
        answer = blankAnswers.join('；');

      } else {
        // 简答题 / 其他主观题
        // 提取学生答案
        const answerDivMatch = block.match(/<div class="myAllAnswerBx">([\s\S]*?)<!--显示答案解析-->/);
        if (answerDivMatch) {
          const pMatch = answerDivMatch[1].match(/<div class="myAnswer[^"]*">[\s\S]*?<p>([\s\S]*?)<\/p>/);
          if (pMatch) answerText = stripHtml(pMatch[1]);
          answer = answerText;
        }
      }

      questions.push({
        id: quesId,
        number: number,
        type: typeLabel,
        question: questionText,
        options: options,
        answer: answer,
        answerText: answerText || answer,
      });
    }

    return questions;
  }

  // ═══════════════════════════════════════════════════════════
  //  生成循环练习 HTML（完全独立，单文件）
  // ═══════════════════════════════════════════════════════════
  function generatePracticeHTML(allQuizzes) {
    // 将所有题目扁平化，附带上章节信息
    let allQuestions = [];
    allQuizzes.forEach((quiz) => {
      quiz.questions.forEach((q, idx) => {
        allQuestions.push({
          ...q,
          quizTitle: quiz.chapterTitle || quiz.quizTitle,
          chapterTitle: quiz.chapterTitle,
          quizTitle2: quiz.quizTitle,
          globalIndex: allQuestions.length,
        });
      });
    });

    // 安全转义：防止 JSON 中包含 </script> 破坏 HTML
    const quizDataJson = JSON.stringify(allQuizzes).replace(/<\//g, '<\\/');
    // 题目数据也嵌入
    const questionsJson = JSON.stringify(allQuestions).replace(/<\//g, '<\\/');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>章节测验 · 循环练习</title>
<style>
/* ═══ 基础重置 ═══ */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f5f6fa;--card-bg:#fff;--text:#2d3436;--text-secondary:#636e72;
  --primary:#6c5ce7;--primary-light:#a29bfe;--success:#00b894;--danger:#d63031;
  --warning:#fdcb6e;--border:#dfe6e9;--shadow:0 2px 12px rgba(0,0,0,.08);
  --radius:12px;--transition:.2s ease;
}
body.dark{
  --bg:#1a1a2e;--card-bg:#16213e;--text:#eee;--text-secondary:#a4b0be;
  --border:#2d3436;--shadow:0 2px 12px rgba(0,0,0,.3);
}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6;transition:background var(--transition),color var(--transition);}

/* ═══ 顶部导航 ═══ */
.topbar{
  position:sticky;top:0;z-index:100;background:var(--card-bg);border-bottom:1px solid var(--border);
  padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;
  box-shadow:var(--shadow);
}
.topbar .title{font-size:18px;font-weight:700;color:var(--primary);}
.topbar .stats{font-size:13px;color:var(--text-secondary);}
.topbar .controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.topbar button,.topbar select{
  padding:6px 14px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);
  color:var(--text);cursor:pointer;font-size:13px;transition:all var(--transition);
}
.topbar button:hover{border-color:var(--primary);color:var(--primary);}
.topbar button.active{background:var(--primary);color:#fff;border-color:var(--primary);}
.topbar select{min-width:140px;}
.progress-bar{width:100%;height:4px;background:var(--border);border-radius:2px;overflow:hidden;}
.progress-bar .fill{height:100%;background:var(--primary);transition:width .3s;}

/* ═══ 主内容区 ═══ */
.main{padding:24px 20px 80px;max-width:860px;margin:0 auto;}
.question-card{background:var(--card-bg);border-radius:var(--radius);padding:28px 30px;box-shadow:var(--shadow);margin-bottom:20px;transition:all var(--transition);}
.question-card.correct{border-left:4px solid var(--success);}
.question-card.wrong{border-left:4px solid var(--danger);}
.question-card.revealed{border-left:4px solid var(--primary);}
.q-header{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;}
.q-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;}
.q-badge.single{background:#e8f5e9;color:#2e7d32;}
.q-badge.multi{background:#fff3e0;color:#e65100;}
.q-badge.judge{background:#e3f2fd;color:#1565c0;}
.q-badge.short{background:#fce4ec;color:#c62828;}
.q-badge.fill{background:#f3e5f5;color:#6a1b9a;}
.q-meta{font-size:12px;color:var(--text-secondary);}
.q-text{font-size:16px;line-height:1.8;margin-bottom:20px;white-space:pre-wrap;word-break:break-word;}

/* ═══ 选项 ═══ */
.options{display:flex;flex-direction:column;gap:10px;}
.option{
  display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border:2px solid var(--border);
  border-radius:10px;cursor:pointer;transition:all var(--transition);font-size:15px;line-height:1.5;
}
.option:hover{border-color:var(--primary-light);background:rgba(108,92,231,.04);}
.option.selected{border-color:var(--primary);background:rgba(108,92,231,.08);}
.option.correct-answer{border-color:var(--success)!important;background:rgba(0,184,148,.08)!important;}
.option.wrong-answer{border-color:var(--danger)!important;background:rgba(214,48,49,.08)!important;}
.option .opt-label{font-weight:700;font-size:14px;min-width:24px;color:var(--primary);}
.option .opt-text{flex:1;}

/* ═══ 答案区 ═══ */
.answer-section{margin-top:20px;display:none;}
.answer-section.show{display:block;}
.answer-box{padding:16px 20px;border-radius:10px;background:rgba(0,184,148,.06);border:1px solid var(--success);}
.answer-box .ans-label{font-weight:700;color:var(--success);margin-bottom:6px;}
.answer-box .ans-text{font-size:15px;white-space:pre-wrap;word-break:break-word;color:var(--text);}

/* ═══ 底部操作 ═══ */
.action-bar{display:flex;justify-content:center;align-items:center;gap:16px;margin-top:20px;flex-wrap:wrap;}
.action-bar button{
  padding:10px 28px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;
  border:none;transition:all var(--transition);display:flex;align-items:center;gap:6px;
}
.btn-primary{background:var(--primary);color:#fff;}
.btn-primary:hover{opacity:.85;transform:translateY(-1px);}
.btn-outline{background:transparent;border:2px solid var(--primary)!important;color:var(--primary);}
.btn-outline:hover{background:var(--primary);color:#fff;}
.btn-success{background:var(--success);color:#fff;}
.btn-danger{background:transparent;border:2px solid var(--danger)!important;color:var(--danger);}
.key-hint{font-size:11px;opacity:.6;margin-left:4px;}

/* ═══ Toast ═══ */
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999;padding:10px 24px;
  border-radius:20px;font-size:14px;color:#fff;background:#2d3436;opacity:0;transition:opacity .3s;}
.toast.show{opacity:1;}

/* ═══ 响应式 ═══ */
@media(max-width:600px){
  .main{padding:16px 10px 60px;}
  .question-card{padding:20px 16px;}
  .topbar{padding:10px 12px;}
  .topbar .title{font-size:15px;}
}
</style>
</head>
<body>
<div class="topbar" id="topbar">
  <span class="title">📝 章节测验练习</span>
  <span class="stats" id="stats">加载中...</span>
  <div class="controls">
    <select id="chapterFilter"><option value="all">📂 全部章节</option></select>
    <select id="typeFilter">
      <option value="all">📋 全部题型</option>
      <option value="单选题">单选题</option>
      <option value="多选题">多选题</option>
      <option value="判断题">判断题</option>
      <option value="简答题">简答题</option>
      <option value="填空题">填空题</option>
    </select>
    <button id="btnRandom" title="随机打乱">🔀 随机</button>
    <button id="btnReset" title="重置进度">🔄 重置</button>
    <button id="btnDark" title="夜间模式">🌓</button>
  </div>
</div>
<div class="progress-bar"><div class="fill" id="progressFill" style="width:0%"></div></div>
<div class="main" id="main"></div>
<div class="toast" id="toast"></div>

<script>
(function(){
  const QUIZ_DATA = ${quizDataJson};
  const ALL_QUESTIONS = ${questionsJson};

  // ═══ 状态 ═══
  let currentIndex = 0;
  let filteredQuestions = [...ALL_QUESTIONS];
  let showAnswer = false;
  let selectedOption = null;
  let judged = false;
  let correctCount = parseInt(localStorage.getItem('cx_practice_correct') || '0');
  let totalCount = parseInt(localStorage.getItem('cx_practice_total') || '0');
  const answeredMap = JSON.parse(localStorage.getItem('cx_practice_answered') || '{}');

  // ═══ DOM 引用 ═══
  const $main = document.getElementById('main');
  const $stats = document.getElementById('stats');
  const $progress = document.getElementById('progressFill');
  const $chapterFilter = document.getElementById('chapterFilter');
  const $typeFilter = document.getElementById('typeFilter');
  const $btnRandom = document.getElementById('btnRandom');
  const $btnReset = document.getElementById('btnReset');
  const $btnDark = document.getElementById('btnDark');
  const $toast = document.getElementById('toast');

  // ═══ 初始化 ═══
  function init() {
    // 填充章节筛选
    const chapters = [...new Set(ALL_QUESTIONS.map(q => q.chapterTitle || q.quizTitle))];
    chapters.forEach(ch => {
      if (ch) {
        const opt = document.createElement('option');
        opt.value = ch;
        opt.textContent = ch;
        $chapterFilter.appendChild(opt);
      }
    });

    // 恢复暗色模式
    if (localStorage.getItem('cx_practice_dark') === '1') {
      document.body.classList.add('dark');
    }

    // 恢复上次位置
    const savedIndex = parseInt(localStorage.getItem('cx_practice_index') || '0');
    if (savedIndex > 0 && savedIndex < ALL_QUESTIONS.length) {
      currentIndex = savedIndex;
    }

    applyFilters();
    render();
  }

  // ═══ 筛选 ═══
  function applyFilters() {
    const chVal = $chapterFilter.value;
    const typeVal = $typeFilter.value;
    filteredQuestions = ALL_QUESTIONS.filter(q => {
      if (chVal !== 'all' && q.chapterTitle !== chVal && q.quizTitle !== chVal) return false;
      if (typeVal !== 'all' && !q.type.includes(typeVal)) return false;
      return true;
    });
    if (filteredQuestions.length === 0) {
      filteredQuestions = [...ALL_QUESTIONS];
    }
    if (currentIndex >= filteredQuestions.length) currentIndex = 0;
    saveState();
  }

  // ═══ 渲染 ═══
  function render() {
    if (filteredQuestions.length === 0) {
      $main.innerHTML = '<div class="question-card" style="text-align:center;padding:60px;"><p style="font-size:18px;color:var(--text-secondary);">🎉 没有匹配的题目</p></div>';
      return;
    }

    const q = filteredQuestions[currentIndex];
    if (!q) return;

    showAnswer = false;
    selectedOption = null;
    judged = false;

    // 进度
    const progress = ((currentIndex + 1) / filteredQuestions.length) * 100;
    $progress.style.width = progress + '%';
    $stats.textContent = (currentIndex + 1) + ' / ' + filteredQuestions.length + ' | ✅ ' + correctCount + ' | 📊 ' + totalCount;

    // 题型徽章
    let badgeClass = 'short';
    if (q.type.includes('单选')) badgeClass = 'single';
    else if (q.type.includes('多选')) badgeClass = 'multi';
    else if (q.type.includes('判断')) badgeClass = 'judge';
    else if (q.type.includes('填空')) badgeClass = 'fill';

    const hasOptions = q.options && q.options.length > 0;

    let html = '';
    html += '<div class="question-card" id="qcard">';
    html += '<div class="q-header">';
    html += '<span class="q-badge ' + badgeClass + '">' + escapeHtml(q.type) + '</span>';
    html += '<span class="q-meta">#' + (currentIndex + 1) + ' · ' + escapeHtml(q.chapterTitle || q.quizTitle2 || '') + '</span>';
    html += '</div>';
    html += '<div class="q-text">' + escapeHtml(q.question) + '</div>';

    if (hasOptions) {
      html += '<div class="options" id="options">';
      q.options.forEach((opt, i) => {
        html += '<div class="option" data-idx="' + i + '" onclick="window.__selectOption(' + i + ')">';
        html += '<span class="opt-label">' + escapeHtml(opt.label) + '</span>';
        html += '<span class="opt-text">' + escapeHtml(opt.text) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<div class="answer-section" id="answerSection">';
    html += '<div class="answer-box">';
    html += '<div class="ans-label">💡 答案</div>';
    html += '<div class="ans-text" id="ansText">' + escapeHtml(q.answerText || q.answer || '(无答案)') + '</div>';
    html += '</div>';
    html += '</div>';

    html += '<div class="action-bar">';
    html += '<button class="btn-outline" onclick="window.__prevQuestion()">◀ 上一题<span class="key-hint">←</span></button>';
    html += '<button class="btn-primary" id="btnReveal" onclick="window.__revealAnswer()">👁 显示答案<span class="key-hint">Space</span></button>';
    html += '<button class="btn-outline" onclick="window.__nextQuestion()">下一题 ▶<span class="key-hint">→</span></button>';
    html += '</div>';

    html += '</div>';
    $main.innerHTML = html;

    saveState();
  }

  // ═══ 全局函数（供 onclick 调用） ═══
  window.__selectOption = function(idx) {
    if (judged) return;
    const q = filteredQuestions[currentIndex];
    if (!q || !q.options) return;
    selectedOption = idx;
    document.querySelectorAll('.option').forEach((el, i) => {
      el.classList.toggle('selected', i === idx);
    });
  };

  window.__revealAnswer = function() {
    const q = filteredQuestions[currentIndex];
    if (!q) return;
    showAnswer = true;
    judged = true;
    const $section = document.getElementById('answerSection');
    if ($section) $section.classList.add('show');
    const $btn = document.getElementById('btnReveal');
    if ($btn) { $btn.textContent = '✅ 已显示'; $btn.classList.add('btn-success'); $btn.classList.remove('btn-primary'); }

    // 判断选项正误
    if (q.options && q.options.length > 0 && selectedOption !== null) {
      document.querySelectorAll('.option').forEach((el, i) => {
        const optLabel = q.options[i].label;
        if (q.answer && q.answer.includes(optLabel)) {
          el.classList.add('correct-answer');
        } else if (i === selectedOption && !(q.answer && q.answer.includes(optLabel))) {
          el.classList.add('wrong-answer');
        }
      });

      // 统计
      const selectedLabel = q.options[selectedOption] ? q.options[selectedOption].label : '';
      const isCorrect = q.answer && q.answer.includes(selectedLabel);
      if (!answeredMap[q.id]) {
        answeredMap[q.id] = true;
        if (isCorrect) correctCount++;
        totalCount++;
        localStorage.setItem('cx_practice_correct', correctCount);
        localStorage.setItem('cx_practice_total', totalCount);
        localStorage.setItem('cx_practice_answered', JSON.stringify(answeredMap));
      }

      const $card = document.getElementById('qcard');
      if ($card) {
        $card.classList.add(isCorrect ? 'correct' : 'wrong');
      }
    } else if (!(q.options && q.options.length > 0)) {
      // 主观题 - 直接统计
      if (!answeredMap[q.id]) {
        answeredMap[q.id] = true;
        totalCount++;
        localStorage.setItem('cx_practice_total', totalCount);
        localStorage.setItem('cx_practice_answered', JSON.stringify(answeredMap));
      }
    }

    $stats.textContent = (currentIndex + 1) + ' / ' + filteredQuestions.length + ' | ✅ ' + correctCount + ' | 📊 ' + totalCount;
  };

  window.__prevQuestion = function() {
    if (currentIndex > 0) {
      currentIndex--;
    } else {
      currentIndex = filteredQuestions.length - 1;
    }
    render();
  };

  window.__nextQuestion = function() {
    if (currentIndex < filteredQuestions.length - 1) {
      currentIndex++;
    } else {
      currentIndex = 0;
    }
    render();
  };

  // ═══ 键盘导航 ═══
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'SELECT') return;
    switch(e.key) {
      case 'ArrowLeft': e.preventDefault(); window.__prevQuestion(); break;
      case 'ArrowRight': e.preventDefault(); window.__nextQuestion(); break;
      case ' ': e.preventDefault(); window.__revealAnswer(); break;
      case '1': case '2': case '3': case '4': case '5': case '6': {
        const idx = parseInt(e.key) - 1;
        if (filteredQuestions[currentIndex] && filteredQuestions[currentIndex].options && idx < filteredQuestions[currentIndex].options.length) {
          window.__selectOption(idx);
        }
        break;
      }
    }
  });

  // ═══ 筛选事件 ═══
  $chapterFilter.addEventListener('change', function() { currentIndex = 0; applyFilters(); render(); });
  $typeFilter.addEventListener('change', function() { currentIndex = 0; applyFilters(); render(); });

  // ═══ 随机按钮 ═══
  $btnRandom.addEventListener('click', function() {
    $btnRandom.classList.toggle('active');
    if ($btnRandom.classList.contains('active')) {
      // 随机打乱
      for (let i = filteredQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filteredQuestions[i], filteredQuestions[j]] = [filteredQuestions[j], filteredQuestions[i]];
      }
      currentIndex = 0;
      toast('🔀 已随机打乱');
    } else {
      // 恢复原始顺序
      applyFilters();
      currentIndex = 0;
      toast('↩ 已恢复顺序');
    }
    render();
  });

  // ═══ 重置按钮 ═══
  $btnReset.addEventListener('click', function() {
    if (confirm('确定要重置所有练习进度吗？')) {
      correctCount = 0;
      totalCount = 0;
      currentIndex = 0;
      localStorage.removeItem('cx_practice_correct');
      localStorage.removeItem('cx_practice_total');
      localStorage.removeItem('cx_practice_answered');
      localStorage.removeItem('cx_practice_index');
      Object.keys(answeredMap).forEach(k => delete answeredMap[k]);
      toast('🔄 进度已重置');
      render();
    }
  });

  // ═══ 暗色模式 ═══
  $btnDark.addEventListener('click', function() {
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    localStorage.setItem('cx_practice_dark', isDark ? '1' : '0');
  });

  // ═══ 辅助 ═══
  function saveState() {
    localStorage.setItem('cx_practice_index', currentIndex);
  }
  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout($toast._t);
    $toast._t = setTimeout(() => $toast.classList.remove('show'), 2000);
  }

  init();
})();
<\/script>
</body>
</html>`;
  }

  // ═══════════════════════════════════════════════════════════
  //  UI 面板
  // ═══════════════════════════════════════════════════════════
  function createPanel() {
    // 移除旧面板
    const old = document.getElementById(CONFIG.panelId);
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = CONFIG.panelId;
    panel.innerHTML = `
      <style>
        #${CONFIG.panelId} {
          position: fixed; bottom: 20px; right: 20px; z-index: 99999;
          background: #fff; border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.18);
          padding: 16px 20px; min-width: 280px; font-family: -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
          font-size: 13px; color: #333; transition: all .2s;
        }
        #${CONFIG.panelId}.collapsed { min-width: auto; padding: 10px; }
        #${CONFIG.panelId} .cx-header {
          display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
        }
        #${CONFIG.panelId} .cx-title { font-size: 15px; font-weight: 700; color: #6c5ce7; }
        #${CONFIG.panelId} .cx-toggle {
          cursor: pointer; background: none; border: none; font-size: 16px; color: #999; padding: 2px 6px;
        }
        #${CONFIG.panelId} .cx-body { display: block; }
        #${CONFIG.panelId}.collapsed .cx-body { display: none; }
        #${CONFIG.panelId} .cx-btn {
          display: block; width: 100%; padding: 10px 16px; margin-bottom: 8px; border: none;
          border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600; text-align: center;
          transition: all .2s; color: #fff;
        }
        #${CONFIG.panelId} .cx-btn.primary { background: #6c5ce7; }
        #${CONFIG.panelId} .cx-btn.primary:hover { background: #5a4bd1; }
        #${CONFIG.panelId} .cx-btn.secondary { background: #00b894; }
        #${CONFIG.panelId} .cx-btn.secondary:hover { background: #00a381; }
        #${CONFIG.panelId} .cx-btn:disabled { opacity: .5; cursor: not-allowed; }
        #${CONFIG.panelId} .cx-progress { margin-top: 8px; display: none; }
        #${CONFIG.panelId} .cx-progress.show { display: block; }
        #${CONFIG.panelId} .cx-progress-text { font-size: 12px; color: #999; margin-bottom: 4px; }
        #${CONFIG.panelId} .cx-progress-bar {
          height: 6px; background: #eee; border-radius: 3px; overflow: hidden;
        }
        #${CONFIG.panelId} .cx-progress-fill {
          height: 100%; background: linear-gradient(90deg, #6c5ce7, #a29bfe); width: 0%;
          transition: width .3s;
        }
        #${CONFIG.panelId} .cx-log {
          max-height: 120px; overflow-y: auto; font-size: 11px; color: #999; margin-top: 8px;
          line-height: 1.5; display: none;
        }
        #${CONFIG.panelId} .cx-log.show { display: block; }
      </style>
      <div class="cx-header">
        <span class="cx-title">📦 测验导出</span>
        <button class="cx-toggle" id="cxToggle">−</button>
      </div>
      <div class="cx-body">
        <button class="cx-btn primary" id="cxExportAll">🚀 导出所有章节测验</button>
        <button class="cx-btn secondary" id="cxDownloadPractice">📝 下载练习HTML</button>
        <div class="cx-progress" id="cxProgress">
          <div class="cx-progress-text" id="cxProgressText">准备中...</div>
          <div class="cx-progress-bar"><div class="cx-progress-fill" id="cxProgressFill"></div></div>
        </div>
        <div class="cx-log" id="cxLog"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // 折叠
    document.getElementById('cxToggle').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      document.getElementById('cxToggle').textContent = panel.classList.contains('collapsed') ? '+' : '−';
    });

    // 缓存最后一次导出的数据
    let lastExportData = null;

    // 导出所有
    document.getElementById('cxExportAll').addEventListener('click', async () => {
      const btn = document.getElementById('cxExportAll');
      btn.disabled = true;
      btn.textContent = '⏳ 正在抓取...';
      lastExportData = await exportAllQuizzes();
      btn.disabled = false;
      btn.textContent = '🚀 导出所有章节测验';

      if (lastExportData) {
        // 自动下载 JSON
        downloadJSON(lastExportData);
        log('✅ 全部完成！JSON 已下载。点击下方按钮下载练习HTML');
      }
    });

    // 下载练习HTML
    document.getElementById('cxDownloadPractice').addEventListener('click', () => {
      if (!lastExportData) {
        alert('请先点击"导出所有章节测验"');
        return;
      }
      const html = generatePracticeHTML(lastExportData.quizzes);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '章节测验_循环练习.html';
      a.click();
      URL.revokeObjectURL(url);
      log('📝 练习HTML已下载');
    });

    // 辅助函数
    function log(msg) {
      const el = document.getElementById('cxLog');
      el.classList.add('show');
      el.innerHTML += '<div>' + msg + '</div>';
      el.scrollTop = el.scrollHeight;
    }

    function setProgress(percent, text) {
      const prog = document.getElementById('cxProgress');
      prog.classList.add('show');
      document.getElementById('cxProgressFill').style.width = percent + '%';
      document.getElementById('cxProgressText').textContent = text;
    }

    return { log, setProgress };
  }

  // ═══════════════════════════════════════════════════════════
  //  主流程：导出所有章节测验
  // ═══════════════════════════════════════════════════════════
  async function exportAllQuizzes() {
    extractBaseParams();
    if (!CONFIG.courseId || !CONFIG.clazzId) {
      alert('无法获取课程参数，请确认在课程页面运行');
      return null;
    }

    // UI 引用
    const panel = document.getElementById(CONFIG.panelId);
    const logEl = document.getElementById('cxLog');
    const progEl = document.getElementById('cxProgress');
    const progFill = document.getElementById('cxProgressFill');
    const progText = document.getElementById('cxProgressText');

    function log(msg) {
      if (logEl) {
        logEl.classList.add('show');
        logEl.innerHTML += '<div>' + msg + '</div>';
        logEl.scrollTop = logEl.scrollHeight;
      }
    }
    function setProgress(pct, text) {
      if (progEl) progEl.classList.add('show');
      if (progFill) progFill.style.width = pct + '%';
      if (progText) progText.textContent = text;
    }

    setProgress(0, '正在解析课程目录...');
    log('📋 解析课程目录...');

    const chapters = getChapterList();
    log('📂 找到 ' + chapters.length + ' 个章节');

    if (chapters.length === 0) {
      log('⚠️ 未找到章节，请刷新页面后重试');
      setProgress(100, '失败：未找到章节');
      return null;
    }

    const allQuizzes = [];
    let totalSteps = chapters.length;
    let completed = 0;

    for (const ch of chapters) {
      log('🔍 [' + ch.title + '] 检查测验...');
      setProgress(Math.round((completed / totalSteps) * 100), '检查: ' + ch.title);

      const mArg = await fetchCardsMAarg(ch.knowledgeId);
      await delay(CONFIG.fetchDelay);

      if (!mArg) {
        log('  ⚠️ 无 mArg 数据');
        completed++;
        continue;
      }

      const attachments = getQuizAttachments(mArg);
      if (attachments.length === 0) {
        log('  📭 本章节无测验');
        completed++;
        continue;
      }

      log('  📝 发现 ' + attachments.length + ' 个测验');

      for (const att of attachments) {
        log('    ⏳ 抓取: ' + (att.title || att.workId));
        try {
          const quizHtml = await fetchQuizHtml(att);
          await delay(CONFIG.fetchDelay);

          const questions = parseQuestions(quizHtml);
          log('    ✅ 解析到 ' + questions.length + ' 道题');

          allQuizzes.push({
            chapterTitle: ch.title,
            knowledgeId: ch.knowledgeId,
            quizTitle: att.title || '',
            workId: att.workId,
            worktype: att.worktype,
            questionCount: questions.length,
            questions: questions,
          });
        } catch (e) {
          log('    ❌ 抓取失败: ' + e.message);
        }
      }
      completed++;
    }

    setProgress(100, '完成！共 ' + allQuizzes.length + ' 个测验');

    const totalQuestions = allQuizzes.reduce((sum, qz) => sum + qz.questions.length, 0);
    log('🎉 总计: ' + allQuizzes.length + ' 个测验, ' + totalQuestions + ' 道题');

    const exportData = {
      exportedAt: new Date().toISOString(),
      courseId: CONFIG.courseId,
      clazzId: CONFIG.clazzId,
      totalQuizzes: allQuizzes.length,
      totalQuestions: totalQuestions,
      quizzes: allQuizzes,
    };

    return exportData;
  }

  // ═══════════════════════════════════════════════════════════
  //  下载 JSON
  // ═══════════════════════════════════════════════════════════
  function downloadJSON(data) {
    // 下载总合 JSON
    const totalJson = JSON.stringify(data, null, 2);
    const blob = new Blob([totalJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'quiz_export_all.json';
    a.click();
    URL.revokeObjectURL(url);

    // 也分别下载每个测验的 JSON
    data.quizzes.forEach((qz, i) => {
      const singleData = {
        exportedAt: data.exportedAt,
        chapterTitle: qz.chapterTitle,
        quizTitle: qz.quizTitle,
        workId: qz.workId,
        questions: qz.questions,
      };
      const singleJson = JSON.stringify(singleData, null, 2);
      const b2 = new Blob([singleJson], { type: 'application/json' });
      const u2 = URL.createObjectURL(b2);
      const a2 = document.createElement('a');
      a2.href = u2;
      a2.download = 'quiz_' + (i + 1) + '_' + (qz.quizTitle || qz.workId).replace(/[\/\\:*?"<>|]/g, '_') + '.json';
      a2.click();
      URL.revokeObjectURL(u2);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  入口
  // ═══════════════════════════════════════════════════════════
  function init() {
    // 等待页面加载完成后再创建面板
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(createPanel, 1500));
    } else {
      setTimeout(createPanel, 1500);
    }
  }

  init();
})();
