// ==UserScript==
// @name         ABC助手 - 仅章节测验模式
// @namespace    chaoxing-abchelper
// @version      1.0.0
// @description  限制ABC插件仅处理章节测验，跳过视频/文档/自动切换等
// @author       You
// @match        *://*.chaoxing.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SETTING_KEY = 'setting';

  // 目标配置：只做章节测验
  const QUIZ_ONLY_OVERRIDES = {
    'config.basicConfig.autoAnswer.value': true,        // 自动答题 ✅
    'config.basicConfig.autoSubmit.value': true,        // 自动提交 ✅
    'config.basicConfig.autoChangeChapter.value': false, // 不要自动切章节 ❌
    'config.basicConfig.autoRefresh.value': false,       // 不要定时刷新 ❌
    'config.basicConfig.videoPlayrate.value': 1,         // 视频1倍速（相当于不加速）
  };

  function deepSet(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in current)) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }

  function applyOverrides() {
    try {
      let settings = JSON.parse(GM_getValue(SETTING_KEY, '{}'));
      if (!settings || !settings.config) {
        // 设置不存在，ABC 可能还没初始化，稍后重试
        return false;
      }

      for (const [path, value] of Object.entries(QUIZ_ONLY_OVERRIDES)) {
        deepSet(settings, path, value);
      }

      GM_setValue(SETTING_KEY, JSON.stringify(settings));
      console.log('[ABC QuizOnly] ✅ 已限制为仅章节测验模式');
      return true;
    } catch (e) {
      console.warn('[ABC QuizOnly] 设置失败:', e);
      return false;
    }
  }

  // ABC 脚本在 document-start 加载，我们在 DOM 就绪后修改其设置
  let attempts = 0;
  function tryApply() {
    if (applyOverrides()) return;
    if (++attempts < 20) setTimeout(tryApply, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryApply, 2000));
  } else {
    setTimeout(tryApply, 2000);
  }
})();
