// ==UserScript==
// @name         超星学习通 - 章节测验导出 + 循环练习
// @namespace    https://mooc1.chaoxing.com
// @version      2.0.0
// @description  一键导出所有章节测验题目为 JSON + 生成完整练习HTML（错题本+导入去重） + 自动解码 cxSecret 字体混淆
// @author       You
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        https://mooc1.chaoxing.com/mooc-ans/knowledge/cards*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      mooc1.chaoxing.com
// @connect      mooc1-ans.chaoxing.com
// @connect      forestpolice.org
// @connect      dkjdda.top
// @require      https://lib.baomitu.com/blueimp-md5/2.19.0/js/md5.min.js
// ==/UserScript==

(function () {
  'use strict';

  console.log('[CX Export] 脚本已加载 v2.0.0');

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

    // ═══════════════════════════════════════════════════════
  //  cxSecret 动态解码器 (基于 Typr + 远程哈希表)
  // ═══════════════════════════════════════════════════════
  const cxDecoder = {
    /** 从 HTML 提取 cxSecret TTF 字体数据 */
    extractFont(html) {
      const m = html.match(/font-cxsecret[^}]*?base64,([A-Za-z0-9+/=]+)/);
      return m ? m[1] : null;
    },

    /** 获取远程哈希查找表 (带缓存) */
    async getLookupTable() {
      if (this._table) return this._table;
      const urls = [
        'https://www.forestpolice.org/ttf/2.0/table.json',
        'https://cs.dkjdda.top/table.json',
      ];
      for (const url of urls) {
        try {
          const json = await gmGet(url);
          this._table = JSON.parse(json);
          console.log('[cxSecret] 查找表加载成功, ' + Object.keys(this._table).length + ' 条目');
          return this._table;
        } catch (e) {
          console.warn('[cxSecret] 查找表加载失败:', url, e.message);
        }
      }
      return null;
    },

    /** 构建解码表 (按字体 b64 缓存) */
    async buildTable(fontB64) {
      // 用 fontB64 的简单哈希作为缓存键
      const key = 'cxsec_' + (fontB64.length * 31 + fontB64.charCodeAt(10) || 0);
      if (this._cache && this._cache[key]) return this._cache[key];

      const lookupTable = await this.getLookupTable();
      if (!lookupTable) return null;

      try {
        const binStr = atob(fontB64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        const fonts = Typr.parse(bytes.buffer);
        const font = fonts[0];
        const match = {};

        const START = 0x4E00, END = 0x9FA5;
        for (let cc = START; cc <= END; cc++) {
          const gid = Typr.U.codeToGlyph(font, cc);
          if (!gid) continue;
          const path = Typr.U.glyphToPath(font, gid);
          const hash = md5(JSON.stringify(path)).slice(24);
          const real = lookupTable[hash];
          if (real !== undefined) match[cc] = real;
        }

        if (!this._cache) this._cache = {};
        this._cache[key] = match;
        console.log('[cxSecret] 解码表构建完成, ' + Object.keys(match).length + ' 个字符');
        return match;
      } catch (e) {
        console.error('[cxSecret] 构建解码表失败:', e);
        return null;
      }
    },

    _table: null,
    _cache: null,
  };

  /** 解码 cxSecret 混淆文本 (自动检测字体) */
  async function decodeCxSecret(text, htmlContext) {
    if (!text || !htmlContext) return text;
    const fontB64 = cxDecoder.extractFont(htmlContext);
    if (!fontB64) return text; // 无混淆字体，无需解码
    const table = await cxDecoder.buildTable(fontB64);
    if (!table) return text;
    return text.split('').map(c => {
      const cp = c.codePointAt(0);
      return table[cp] ? String.fromCodePoint(table[cp]) : c;
    }).join('');
  }

  /** 同步版 (使用预构建表，用于已缓存的场景) */
  function decodeCxSecretSync(text, table) {
    if (!text || !table) return text;
    return text.split('').map(c => {
      const cp = c.codePointAt(0);
      return table[cp] ? String.fromCodePoint(table[cp]) : c;
    }).join('');
  }


  /** 延迟 */
  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 发起 GET 请求（走 GM_xmlhttpRequest 跨域） */
  // ── 内嵌 Typr.js ──
var Typr$1 = {};
var Typr = {};
  Typr.parse = function(buff) {
    var bin = Typr._bin;
    var data = new Uint8Array(buff);
    var tag = bin.readASCII(data, 0, 4);
    if (tag == "ttcf") {
      var offset = 4;
      bin.readUshort(data, offset);
      offset += 2;
      bin.readUshort(data, offset);
      offset += 2;
      var numF = bin.readUint(data, offset);
      offset += 4;
      var fnts = [];
      for (var i = 0; i < numF; i++) {
        var foff = bin.readUint(data, offset);
        offset += 4;
        fnts.push(Typr._readFont(data, foff));
      }
      return fnts;
    } else
      return [Typr._readFont(data, 0)];
  };
  Typr._readFont = function(data, offset) {
    var bin = Typr._bin;
    var ooff = offset;
    bin.readFixed(data, offset);
    offset += 4;
    var numTables = bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    var tags = [
      "cmap",
      "head",
      "hhea",
      "maxp",
      "hmtx",
      "name",
      "OS/2",
      "post",
      //"cvt",
      //"fpgm",
      "loca",
      "glyf",
      "kern",
      //"prep"
      //"gasp"
      "CFF ",
      "GPOS",
      "GSUB",
      "SVG "
      //"VORG",
    ];
    var obj = { _data: data, _offset: ooff };
    var tabs = {};
    for (var i = 0; i < numTables; i++) {
      var tag = bin.readASCII(data, offset, 4);
      offset += 4;
      bin.readUint(data, offset);
      offset += 4;
      var toffset = bin.readUint(data, offset);
      offset += 4;
      var length = bin.readUint(data, offset);
      offset += 4;
      tabs[tag] = { offset: toffset, length };
    }
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (tabs[t])
        obj[t.trim()] = Typr[t.trim()].parse(data, tabs[t].offset, tabs[t].length, obj);
    }
    return obj;
  };
  Typr._tabOffset = function(data, tab, foff) {
    var bin = Typr._bin;
    var numTables = bin.readUshort(data, foff + 4);
    var offset = foff + 12;
    for (var i = 0; i < numTables; i++) {
      var tag = bin.readASCII(data, offset, 4);
      offset += 4;
      bin.readUint(data, offset);
      offset += 4;
      var toffset = bin.readUint(data, offset);
      offset += 4;
      bin.readUint(data, offset);
      offset += 4;
      if (tag == tab)
        return toffset;
    }
    return 0;
  };
  Typr._bin = {
    readFixed: function(data, o) {
      return (data[o] << 8 | data[o + 1]) + (data[o + 2] << 8 | data[o + 3]) / (256 * 256 + 4);
    },
    readF2dot14: function(data, o) {
      var num = Typr._bin.readShort(data, o);
      return num / 16384;
    },
    readInt: function(buff, p) {
      return Typr._bin._view(buff).getInt32(p);
    },
    readInt8: function(buff, p) {
      return Typr._bin._view(buff).getInt8(p);
    },
    readShort: function(buff, p) {
      return Typr._bin._view(buff).getInt16(p);
    },
    readUshort: function(buff, p) {
      return Typr._bin._view(buff).getUint16(p);
    },
    readUshorts: function(buff, p, len) {
      var arr = [];
      for (var i = 0; i < len; i++)
        arr.push(Typr._bin.readUshort(buff, p + i * 2));
      return arr;
    },
    readUint: function(buff, p) {
      return Typr._bin._view(buff).getUint32(p);
    },
    readUint64: function(buff, p) {
      return Typr._bin.readUint(buff, p) * (4294967295 + 1) + Typr._bin.readUint(buff, p + 4);
    },
    readASCII: function(buff, p, l) {
      var s = "";
      for (var i = 0; i < l; i++)
        s += String.fromCharCode(buff[p + i]);
      return s;
    },
    readUnicode: function(buff, p, l) {
      var s = "";
      for (var i = 0; i < l; i++) {
        var c = buff[p++] << 8 | buff[p++];
        s += String.fromCharCode(c);
      }
      return s;
    },
    _tdec: typeof window !== "undefined" && window["TextDecoder"] ? new window["TextDecoder"]() : null,
    readUTF8: function(buff, p, l) {
      var tdec = Typr._bin._tdec;
      if (tdec && p == 0 && l == buff.length)
        return tdec["decode"](buff);
      return Typr._bin.readASCII(buff, p, l);
    },
    readBytes: function(buff, p, l) {
      var arr = [];
      for (var i = 0; i < l; i++)
        arr.push(buff[p + i]);
      return arr;
    },
    readASCIIArray: function(buff, p, l) {
      var s = [];
      for (var i = 0; i < l; i++)
        s.push(String.fromCharCode(buff[p + i]));
      return s;
    },
    _view: function(buff) {
      return buff._dataView || (buff._dataView = buff.buffer ? new DataView(buff.buffer, buff.byteOffset, buff.byteLength) : new DataView(new Uint8Array(buff).buffer));
    }
  };
  Typr._lctf = {};
  Typr._lctf.parse = function(data, offset, length, font, subt) {
    var bin = Typr._bin;
    var obj = {};
    var offset0 = offset;
    bin.readFixed(data, offset);
    offset += 4;
    var offScriptList = bin.readUshort(data, offset);
    offset += 2;
    var offFeatureList = bin.readUshort(data, offset);
    offset += 2;
    var offLookupList = bin.readUshort(data, offset);
    offset += 2;
    obj.scriptList = Typr._lctf.readScriptList(data, offset0 + offScriptList);
    obj.featureList = Typr._lctf.readFeatureList(data, offset0 + offFeatureList);
    obj.lookupList = Typr._lctf.readLookupList(data, offset0 + offLookupList, subt);
    return obj;
  };
  Typr._lctf.readLookupList = function(data, offset, subt) {
    var bin = Typr._bin;
    var offset0 = offset;
    var obj = [];
    var count = bin.readUshort(data, offset);
    offset += 2;
    for (var i = 0; i < count; i++) {
      var noff = bin.readUshort(data, offset);
      offset += 2;
      var lut = Typr._lctf.readLookupTable(data, offset0 + noff, subt);
      obj.push(lut);
    }
    return obj;
  };
  Typr._lctf.readLookupTable = function(data, offset, subt) {
    var bin = Typr._bin;
    var offset0 = offset;
    var obj = { tabs: [] };
    obj.ltype = bin.readUshort(data, offset);
    offset += 2;
    obj.flag = bin.readUshort(data, offset);
    offset += 2;
    var cnt = bin.readUshort(data, offset);
    offset += 2;
    var ltype = obj.ltype;
    for (var i = 0; i < cnt; i++) {
      var noff = bin.readUshort(data, offset);
      offset += 2;
      var tab = subt(data, ltype, offset0 + noff, obj);
      obj.tabs.push(tab);
    }
    return obj;
  };
  Typr._lctf.numOfOnes = function(n) {
    var num = 0;
    for (var i = 0; i < 32; i++)
      if ((n >>> i & 1) != 0)
        num++;
    return num;
  };
  Typr._lctf.readClassDef = function(data, offset) {
    var bin = Typr._bin;
    var obj = [];
    var format = bin.readUshort(data, offset);
    offset += 2;
    if (format == 1) {
      var startGlyph = bin.readUshort(data, offset);
      offset += 2;
      var glyphCount = bin.readUshort(data, offset);
      offset += 2;
      for (var i = 0; i < glyphCount; i++) {
        obj.push(startGlyph + i);
        obj.push(startGlyph + i);
        obj.push(bin.readUshort(data, offset));
        offset += 2;
      }
    }
    if (format == 2) {
      var count = bin.readUshort(data, offset);
      offset += 2;
      for (var i = 0; i < count; i++) {
        obj.push(bin.readUshort(data, offset));
        offset += 2;
        obj.push(bin.readUshort(data, offset));
        offset += 2;
        obj.push(bin.readUshort(data, offset));
        offset += 2;
      }
    }
    return obj;
  };
  Typr._lctf.getInterval = function(tab, val) {
    for (var i = 0; i < tab.length; i += 3) {
      var start = tab[i], end = tab[i + 1];
      tab[i + 2];
      if (start <= val && val <= end)
        return i;
    }
    return -1;
  };
  Typr._lctf.readCoverage = function(data, offset) {
    var bin = Typr._bin;
    var cvg = {};
    cvg.fmt = bin.readUshort(data, offset);
    offset += 2;
    var count = bin.readUshort(data, offset);
    offset += 2;
    if (cvg.fmt == 1)
      cvg.tab = bin.readUshorts(data, offset, count);
    if (cvg.fmt == 2)
      cvg.tab = bin.readUshorts(data, offset, count * 3);
    return cvg;
  };
  Typr._lctf.coverageIndex = function(cvg, val) {
    var tab = cvg.tab;
    if (cvg.fmt == 1)
      return tab.indexOf(val);
    if (cvg.fmt == 2) {
      var ind = Typr._lctf.getInterval(tab, val);
      if (ind != -1)
        return tab[ind + 2] + (val - tab[ind]);
    }
    return -1;
  };
  Typr._lctf.readFeatureList = function(data, offset) {
    var bin = Typr._bin;
    var offset0 = offset;
    var obj = [];
    var count = bin.readUshort(data, offset);
    offset += 2;
    for (var i = 0; i < count; i++) {
      var tag = bin.readASCII(data, offset, 4);
      offset += 4;
      var noff = bin.readUshort(data, offset);
      offset += 2;
      var feat = Typr._lctf.readFeatureTable(data, offset0 + noff);
      feat.tag = tag.trim();
      obj.push(feat);
    }
    return obj;
  };
  Typr._lctf.readFeatureTable = function(data, offset) {
    var bin = Typr._bin;
    var offset0 = offset;
    var feat = {};
    var featureParams = bin.readUshort(data, offset);
    offset += 2;
    if (featureParams > 0) {
      feat.featureParams = offset0 + featureParams;
    }
    var lookupCount = bin.readUshort(data, offset);
    offset += 2;
    feat.tab = [];
    for (var i = 0; i < lookupCount; i++)
      feat.tab.push(bin.readUshort(data, offset + 2 * i));
    return feat;
  };
  Typr._lctf.readScriptList = function(data, offset) {
    var bin = Typr._bin;
    var offset0 = offset;
    var obj = {};
    var count = bin.readUshort(data, offset);
    offset += 2;
    for (var i = 0; i < count; i++) {
      var tag = bin.readASCII(data, offset, 4);
      offset += 4;
      var noff = bin.readUshort(data, offset);
      offset += 2;
      obj[tag.trim()] = Typr._lctf.readScriptTable(data, offset0 + noff);
    }
    return obj;
  };
  Typr._lctf.readScriptTable = function(data, offset) {
    var bin = Typr._bin;
    var offset0 = offset;
    var obj = {};
    var defLangSysOff = bin.readUshort(data, offset);
    offset += 2;
    if (defLangSysOff > 0) {
      obj["default"] = Typr._lctf.readLangSysTable(data, offset0 + defLangSysOff);
    }
    var langSysCount = bin.readUshort(data, offset);
    offset += 2;
    for (var i = 0; i < langSysCount; i++) {
      var tag = bin.readASCII(data, offset, 4);
      offset += 4;
      var langSysOff = bin.readUshort(data, offset);
      offset += 2;
      obj[tag.trim()] = Typr._lctf.readLangSysTable(data, offset0 + langSysOff);
    }
    return obj;
  };
  Typr._lctf.readLangSysTable = function(data, offset) {
    var bin = Typr._bin;
    var obj = {};
    bin.readUshort(data, offset);
    offset += 2;
    obj.reqFeature = bin.readUshort(data, offset);
    offset += 2;
    var featureCount = bin.readUshort(data, offset);
    offset += 2;
    obj.features = bin.readUshorts(data, offset, featureCount);
    return obj;
  };
  Typr.CFF = {};
  Typr.CFF.parse = function(data, offset, length) {
    var bin = Typr._bin;
    data = new Uint8Array(data.buffer, offset, length);
    offset = 0;
    data[offset];
    offset++;
    data[offset];
    offset++;
    data[offset];
    offset++;
    data[offset];
    offset++;
    var ninds = [];
    offset = Typr.CFF.readIndex(data, offset, ninds);
    var names2 = [];
    for (var i = 0; i < ninds.length - 1; i++)
      names2.push(bin.readASCII(data, offset + ninds[i], ninds[i + 1] - ninds[i]));
    offset += ninds[ninds.length - 1];
    var tdinds = [];
    offset = Typr.CFF.readIndex(data, offset, tdinds);
    var topDicts = [];
    for (var i = 0; i < tdinds.length - 1; i++)
      topDicts.push(Typr.CFF.readDict(data, offset + tdinds[i], offset + tdinds[i + 1]));
    offset += tdinds[tdinds.length - 1];
    var topdict = topDicts[0];
    var sinds = [];
    offset = Typr.CFF.readIndex(data, offset, sinds);
    var strings = [];
    for (var i = 0; i < sinds.length - 1; i++)
      strings.push(bin.readASCII(data, offset + sinds[i], sinds[i + 1] - sinds[i]));
    offset += sinds[sinds.length - 1];
    Typr.CFF.readSubrs(data, offset, topdict);
    if (topdict.CharStrings) {
      offset = topdict.CharStrings;
      var sinds = [];
      offset = Typr.CFF.readIndex(data, offset, sinds);
      var cstr = [];
      for (var i = 0; i < sinds.length - 1; i++)
        cstr.push(bin.readBytes(data, offset + sinds[i], sinds[i + 1] - sinds[i]));
      topdict.CharStrings = cstr;
    }
    if (topdict.ROS) {
      offset = topdict.FDArray;
      var fdind = [];
      offset = Typr.CFF.readIndex(data, offset, fdind);
      topdict.FDArray = [];
      for (var i = 0; i < fdind.length - 1; i++) {
        var dict = Typr.CFF.readDict(data, offset + fdind[i], offset + fdind[i + 1]);
        Typr.CFF._readFDict(data, dict, strings);
        topdict.FDArray.push(dict);
      }
      offset += fdind[fdind.length - 1];
      offset = topdict.FDSelect;
      topdict.FDSelect = [];
      var fmt = data[offset];
      offset++;
      if (fmt == 3) {
        var rns = bin.readUshort(data, offset);
        offset += 2;
        for (var i = 0; i < rns + 1; i++) {
          topdict.FDSelect.push(bin.readUshort(data, offset), data[offset + 2]);
          offset += 3;
        }
      } else
        throw fmt;
    }
    if (topdict.Encoding)
      topdict.Encoding = Typr.CFF.readEncoding(data, topdict.Encoding, topdict.CharStrings.length);
    if (topdict.charset)
      topdict.charset = Typr.CFF.readCharset(data, topdict.charset, topdict.CharStrings.length);
    Typr.CFF._readFDict(data, topdict, strings);
    return topdict;
  };
  Typr.CFF._readFDict = function(data, dict, ss) {
    var offset;
    if (dict.Private) {
      offset = dict.Private[1];
      dict.Private = Typr.CFF.readDict(data, offset, offset + dict.Private[0]);
      if (dict.Private.Subrs)
        Typr.CFF.readSubrs(data, offset + dict.Private.Subrs, dict.Private);
    }
    for (var p in dict)
      if (["FamilyName", "FontName", "FullName", "Notice", "version", "Copyright"].indexOf(p) != -1)
        dict[p] = ss[dict[p] - 426 + 35];
  };
  Typr.CFF.readSubrs = function(data, offset, obj) {
    var bin = Typr._bin;
    var gsubinds = [];
    offset = Typr.CFF.readIndex(data, offset, gsubinds);
    var bias, nSubrs = gsubinds.length;
    if (nSubrs < 1240)
      bias = 107;
    else if (nSubrs < 33900)
      bias = 1131;
    else
      bias = 32768;
    obj.Bias = bias;
    obj.Subrs = [];
    for (var i = 0; i < gsubinds.length - 1; i++)
      obj.Subrs.push(bin.readBytes(data, offset + gsubinds[i], gsubinds[i + 1] - gsubinds[i]));
  };
  Typr.CFF.tableSE = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    16,
    17,
    18,
    19,
    20,
    21,
    22,
    23,
    24,
    25,
    26,
    27,
    28,
    29,
    30,
    31,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    64,
    65,
    66,
    67,
    68,
    69,
    70,
    71,
    72,
    73,
    74,
    75,
    76,
    77,
    78,
    79,
    80,
    81,
    82,
    83,
    84,
    85,
    86,
    87,
    88,
    89,
    90,
    91,
    92,
    93,
    94,
    95,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    107,
    108,
    109,
    110,
    0,
    111,
    112,
    113,
    114,
    0,
    115,
    116,
    117,
    118,
    119,
    120,
    121,
    122,
    0,
    123,
    0,
    124,
    125,
    126,
    127,
    128,
    129,
    130,
    131,
    0,
    132,
    133,
    0,
    134,
    135,
    136,
    137,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    138,
    0,
    139,
    0,
    0,
    0,
    0,
    140,
    141,
    142,
    143,
    0,
    0,
    0,
    0,
    0,
    144,
    0,
    0,
    0,
    145,
    0,
    0,
    146,
    147,
    148,
    149,
    0,
    0,
    0,
    0
  ];
  Typr.CFF.glyphByUnicode = function(cff, code) {
    for (var i = 0; i < cff.charset.length; i++)
      if (cff.charset[i] == code)
        return i;
    return -1;
  };
  Typr.CFF.glyphBySE = function(cff, charcode) {
    if (charcode < 0 || charcode > 255)
      return -1;
    return Typr.CFF.glyphByUnicode(cff, Typr.CFF.tableSE[charcode]);
  };
  Typr.CFF.readEncoding = function(data, offset, num) {
    Typr._bin;
    var array = [".notdef"];
    var format = data[offset];
    offset++;
    if (format == 0) {
      var nCodes = data[offset];
      offset++;
      for (var i = 0; i < nCodes; i++)
        array.push(data[offset + i]);
    } else
      throw "error: unknown encoding format: " + format;
    return array;
  };
  Typr.CFF.readCharset = function(data, offset, num) {
    var bin = Typr._bin;
    var charset = [".notdef"];
    var format = data[offset];
    offset++;
    if (format == 0) {
      for (var i = 0; i < num; i++) {
        var first = bin.readUshort(data, offset);
        offset += 2;
        charset.push(first);
      }
    } else if (format == 1 || format == 2) {
      while (charset.length < num) {
        var first = bin.readUshort(data, offset);
        offset += 2;
        var nLeft = 0;
        if (format == 1) {
          nLeft = data[offset];
          offset++;
        } else {
          nLeft = bin.readUshort(data, offset);
          offset += 2;
        }
        for (var i = 0; i <= nLeft; i++) {
          charset.push(first);
          first++;
        }
      }
    } else
      throw "error: format: " + format;
    return charset;
  };
  Typr.CFF.readIndex = function(data, offset, inds) {
    var bin = Typr._bin;
    var count = bin.readUshort(data, offset) + 1;
    offset += 2;
    var offsize = data[offset];
    offset++;
    if (offsize == 1)
      for (var i = 0; i < count; i++)
        inds.push(data[offset + i]);
    else if (offsize == 2)
      for (var i = 0; i < count; i++)
        inds.push(bin.readUshort(data, offset + i * 2));
    else if (offsize == 3)
      for (var i = 0; i < count; i++)
        inds.push(bin.readUint(data, offset + i * 3 - 1) & 16777215);
    else if (count != 1)
      throw "unsupported offset size: " + offsize + ", count: " + count;
    offset += count * offsize;
    return offset - 1;
  };
  Typr.CFF.getCharString = function(data, offset, o) {
    var bin = Typr._bin;
    var b0 = data[offset], b1 = data[offset + 1];
    data[offset + 2];
    data[offset + 3];
    data[offset + 4];
    var vs = 1;
    var op = null, val = null;
    if (b0 <= 20) {
      op = b0;
      vs = 1;
    }
    if (b0 == 12) {
      op = b0 * 100 + b1;
      vs = 2;
    }
    if (21 <= b0 && b0 <= 27) {
      op = b0;
      vs = 1;
    }
    if (b0 == 28) {
      val = bin.readShort(data, offset + 1);
      vs = 3;
    }
    if (29 <= b0 && b0 <= 31) {
      op = b0;
      vs = 1;
    }
    if (32 <= b0 && b0 <= 246) {
      val = b0 - 139;
      vs = 1;
    }
    if (247 <= b0 && b0 <= 250) {
      val = (b0 - 247) * 256 + b1 + 108;
      vs = 2;
    }
    if (251 <= b0 && b0 <= 254) {
      val = -(b0 - 251) * 256 - b1 - 108;
      vs = 2;
    }
    if (b0 == 255) {
      val = bin.readInt(data, offset + 1) / 65535;
      vs = 5;
    }
    o.val = val != null ? val : "o" + op;
    o.size = vs;
  };
  Typr.CFF.readCharString = function(data, offset, length) {
    var end = offset + length;
    var bin = Typr._bin;
    var arr = [];
    while (offset < end) {
      var b0 = data[offset], b1 = data[offset + 1];
      data[offset + 2];
      data[offset + 3];
      data[offset + 4];
      var vs = 1;
      var op = null, val = null;
      if (b0 <= 20) {
        op = b0;
        vs = 1;
      }
      if (b0 == 12) {
        op = b0 * 100 + b1;
        vs = 2;
      }
      if (b0 == 19 || b0 == 20) {
        op = b0;
        vs = 2;
      }
      if (21 <= b0 && b0 <= 27) {
        op = b0;
        vs = 1;
      }
      if (b0 == 28) {
        val = bin.readShort(data, offset + 1);
        vs = 3;
      }
      if (29 <= b0 && b0 <= 31) {
        op = b0;
        vs = 1;
      }
      if (32 <= b0 && b0 <= 246) {
        val = b0 - 139;
        vs = 1;
      }
      if (247 <= b0 && b0 <= 250) {
        val = (b0 - 247) * 256 + b1 + 108;
        vs = 2;
      }
      if (251 <= b0 && b0 <= 254) {
        val = -(b0 - 251) * 256 - b1 - 108;
        vs = 2;
      }
      if (b0 == 255) {
        val = bin.readInt(data, offset + 1) / 65535;
        vs = 5;
      }
      arr.push(val != null ? val : "o" + op);
      offset += vs;
    }
    return arr;
  };
  Typr.CFF.readDict = function(data, offset, end) {
    var bin = Typr._bin;
    var dict = {};
    var carr = [];
    while (offset < end) {
      var b0 = data[offset], b1 = data[offset + 1];
      data[offset + 2];
      data[offset + 3];
      data[offset + 4];
      var vs = 1;
      var key = null, val = null;
      if (b0 == 28) {
        val = bin.readShort(data, offset + 1);
        vs = 3;
      }
      if (b0 == 29) {
        val = bin.readInt(data, offset + 1);
        vs = 5;
      }
      if (32 <= b0 && b0 <= 246) {
        val = b0 - 139;
        vs = 1;
      }
      if (247 <= b0 && b0 <= 250) {
        val = (b0 - 247) * 256 + b1 + 108;
        vs = 2;
      }
      if (251 <= b0 && b0 <= 254) {
        val = -(b0 - 251) * 256 - b1 - 108;
        vs = 2;
      }
      if (b0 == 255) {
        val = bin.readInt(data, offset + 1) / 65535;
        vs = 5;
        throw "unknown number";
      }
      if (b0 == 30) {
        var nibs = [];
        vs = 1;
        while (true) {
          var b = data[offset + vs];
          vs++;
          var nib0 = b >> 4, nib1 = b & 15;
          if (nib0 != 15)
            nibs.push(nib0);
          if (nib1 != 15)
            nibs.push(nib1);
          if (nib1 == 15)
            break;
        }
        var s = "";
        var chars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, ".", "e", "e-", "reserved", "-", "endOfNumber"];
        for (var i = 0; i < nibs.length; i++)
          s += chars[nibs[i]];
        val = parseFloat(s);
      }
      if (b0 <= 21) {
        var keys = [
          "version",
          "Notice",
          "FullName",
          "FamilyName",
          "Weight",
          "FontBBox",
          "BlueValues",
          "OtherBlues",
          "FamilyBlues",
          "FamilyOtherBlues",
          "StdHW",
          "StdVW",
          "escape",
          "UniqueID",
          "XUID",
          "charset",
          "Encoding",
          "CharStrings",
          "Private",
          "Subrs",
          "defaultWidthX",
          "nominalWidthX"
        ];
        key = keys[b0];
        vs = 1;
        if (b0 == 12) {
          var keys = [
            "Copyright",
            "isFixedPitch",
            "ItalicAngle",
            "UnderlinePosition",
            "UnderlineThickness",
            "PaintType",
            "CharstringType",
            "FontMatrix",
            "StrokeWidth",
            "BlueScale",
            "BlueShift",
            "BlueFuzz",
            "StemSnapH",
            "StemSnapV",
            "ForceBold",
            0,
            0,
            "LanguageGroup",
            "ExpansionFactor",
            "initialRandomSeed",
            "SyntheticBase",
            "PostScript",
            "BaseFontName",
            "BaseFontBlend",
            0,
            0,
            0,
            0,
            0,
            0,
            "ROS",
            "CIDFontVersion",
            "CIDFontRevision",
            "CIDFontType",
            "CIDCount",
            "UIDBase",
            "FDArray",
            "FDSelect",
            "FontName"
          ];
          key = keys[b1];
          vs = 2;
        }
      }
      if (key != null) {
        dict[key] = carr.length == 1 ? carr[0] : carr;
        carr = [];
      } else
        carr.push(val);
      offset += vs;
    }
    return dict;
  };
  Typr.cmap = {};
  Typr.cmap.parse = function(data, offset, length) {
    data = new Uint8Array(data.buffer, offset, length);
    offset = 0;
    var bin = Typr._bin;
    var obj = {};
    bin.readUshort(data, offset);
    offset += 2;
    var numTables = bin.readUshort(data, offset);
    offset += 2;
    var offs = [];
    obj.tables = [];
    for (var i = 0; i < numTables; i++) {
      var platformID = bin.readUshort(data, offset);
      offset += 2;
      var encodingID = bin.readUshort(data, offset);
      offset += 2;
      var noffset = bin.readUint(data, offset);
      offset += 4;
      var id = "p" + platformID + "e" + encodingID;
      var tind = offs.indexOf(noffset);
      if (tind == -1) {
        tind = obj.tables.length;
        var subt;
        offs.push(noffset);
        var format = bin.readUshort(data, noffset);
        if (format == 0)
          subt = Typr.cmap.parse0(data, noffset);
        else if (format == 4)
          subt = Typr.cmap.parse4(data, noffset);
        else if (format == 6)
          subt = Typr.cmap.parse6(data, noffset);
        else if (format == 12)
          subt = Typr.cmap.parse12(data, noffset);
        else
          console.warn("unknown format: " + format, platformID, encodingID, noffset);
        obj.tables.push(subt);
      }
      if (obj[id] != null)
        throw "multiple tables for one platform+encoding";
      obj[id] = tind;
    }
    return obj;
  };
  Typr.cmap.parse0 = function(data, offset) {
    var bin = Typr._bin;
    var obj = {};
    obj.format = bin.readUshort(data, offset);
    offset += 2;
    var len = bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    obj.map = [];
    for (var i = 0; i < len - 6; i++)
      obj.map.push(data[offset + i]);
    return obj;
  };
  Typr.cmap.parse4 = function(data, offset) {
    var bin = Typr._bin;
    var offset0 = offset;
    var obj = {};
    obj.format = bin.readUshort(data, offset);
    offset += 2;
    var length = bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    var segCountX2 = bin.readUshort(data, offset);
    offset += 2;
    var segCount = segCountX2 / 2;
    obj.searchRange = bin.readUshort(data, offset);
    offset += 2;
    obj.entrySelector = bin.readUshort(data, offset);
    offset += 2;
    obj.rangeShift = bin.readUshort(data, offset);
    offset += 2;
    obj.endCount = bin.readUshorts(data, offset, segCount);
    offset += segCount * 2;
    offset += 2;
    obj.startCount = bin.readUshorts(data, offset, segCount);
    offset += segCount * 2;
    obj.idDelta = [];
    for (var i = 0; i < segCount; i++) {
      obj.idDelta.push(bin.readShort(data, offset));
      offset += 2;
    }
    obj.idRangeOffset = bin.readUshorts(data, offset, segCount);
    offset += segCount * 2;
    obj.glyphIdArray = [];
    while (offset < offset0 + length) {
      obj.glyphIdArray.push(bin.readUshort(data, offset));
      offset += 2;
    }
    return obj;
  };
  Typr.cmap.parse6 = function(data, offset) {
    var bin = Typr._bin;
    var obj = {};
    obj.format = bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    obj.firstCode = bin.readUshort(data, offset);
    offset += 2;
    var entryCount = bin.readUshort(data, offset);
    offset += 2;
    obj.glyphIdArray = [];
    for (var i = 0; i < entryCount; i++) {
      obj.glyphIdArray.push(bin.readUshort(data, offset));
      offset += 2;
    }
    return obj;
  };
  Typr.cmap.parse12 = function(data, offset) {
    var bin = Typr._bin;
    var obj = {};
    obj.format = bin.readUshort(data, offset);
    offset += 2;
    offset += 2;
    bin.readUint(data, offset);
    offset += 4;
    bin.readUint(data, offset);
    offset += 4;
    var nGroups = bin.readUint(data, offset);
    offset += 4;
    obj.groups = [];
    for (var i = 0; i < nGroups; i++) {
      var off = offset + i * 12;
      var startCharCode = bin.readUint(data, off + 0);
      var endCharCode = bin.readUint(data, off + 4);
      var startGlyphID = bin.readUint(data, off + 8);
      obj.groups.push([startCharCode, endCharCode, startGlyphID]);
    }
    return obj;
  };
  Typr.glyf = {};
  Typr.glyf.parse = function(data, offset, length, font) {
    var obj = [];
    for (var g = 0; g < font.maxp.numGlyphs; g++)
      obj.push(null);
    return obj;
  };
  Typr.glyf._parseGlyf = function(font, g) {
    var bin = Typr._bin;
    var data = font._data;
    var offset = Typr._tabOffset(data, "glyf", font._offset) + font.loca[g];
    if (font.loca[g] == font.loca[g + 1])
      return null;
    var gl = {};
    gl.noc = bin.readShort(data, offset);
    offset += 2;
    gl.xMin = bin.readShort(data, offset);
    offset += 2;
    gl.yMin = bin.readShort(data, offset);
    offset += 2;
    gl.xMax = bin.readShort(data, offset);
    offset += 2;
    gl.yMax = bin.readShort(data, offset);
    offset += 2;
    if (gl.xMin >= gl.xMax || gl.yMin >= gl.yMax)
      return null;
    if (gl.noc > 0) {
      gl.endPts = [];
      for (var i = 0; i < gl.noc; i++) {
        gl.endPts.push(bin.readUshort(data, offset));
        offset += 2;
      }
      var instructionLength = bin.readUshort(data, offset);
      offset += 2;
      if (data.length - offset < instructionLength)
        return null;
      gl.instructions = bin.readBytes(data, offset, instructionLength);
      offset += instructionLength;
      var crdnum = gl.endPts[gl.noc - 1] + 1;
      gl.flags = [];
      for (var i = 0; i < crdnum; i++) {
        var flag = data[offset];
        offset++;
        gl.flags.push(flag);
        if ((flag & 8) != 0) {
          var rep = data[offset];
          offset++;
          for (var j = 0; j < rep; j++) {
            gl.flags.push(flag);
            i++;
          }
        }
      }
      gl.xs = [];
      for (var i = 0; i < crdnum; i++) {
        var i8 = (gl.flags[i] & 2) != 0, same = (gl.flags[i] & 16) != 0;
        if (i8) {
          gl.xs.push(same ? data[offset] : -data[offset]);
          offset++;
        } else {
          if (same)
            gl.xs.push(0);
          else {
            gl.xs.push(bin.readShort(data, offset));
            offset += 2;
          }
        }
      }
      gl.ys = [];
      for (var i = 0; i < crdnum; i++) {
        var i8 = (gl.flags[i] & 4) != 0, same = (gl.flags[i] & 32) != 0;
        if (i8) {
          gl.ys.push(same ? data[offset] : -data[offset]);
          offset++;
        } else {
          if (same)
            gl.ys.push(0);
          else {
            gl.ys.push(bin.readShort(data, offset));
            offset += 2;
          }
        }
      }
      var x = 0, y = 0;
      for (var i = 0; i < crdnum; i++) {
        x += gl.xs[i];
        y += gl.ys[i];
        gl.xs[i] = x;
        gl.ys[i] = y;
      }
    } else {
      var ARG_1_AND_2_ARE_WORDS = 1 << 0;
      var ARGS_ARE_XY_VALUES = 1 << 1;
      var WE_HAVE_A_SCALE = 1 << 3;
      var MORE_COMPONENTS = 1 << 5;
      var WE_HAVE_AN_X_AND_Y_SCALE = 1 << 6;
      var WE_HAVE_A_TWO_BY_TWO = 1 << 7;
      var WE_HAVE_INSTRUCTIONS = 1 << 8;
      gl.parts = [];
      var flags;
      do {
        flags = bin.readUshort(data, offset);
        offset += 2;
        var part = { m: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, p1: -1, p2: -1 };
        gl.parts.push(part);
        part.glyphIndex = bin.readUshort(data, offset);
        offset += 2;
        if (flags & ARG_1_AND_2_ARE_WORDS) {
          var arg1 = bin.readShort(data, offset);
          offset += 2;
          var arg2 = bin.readShort(data, offset);
          offset += 2;
        } else {
          var arg1 = bin.readInt8(data, offset);
          offset++;
          var arg2 = bin.readInt8(data, offset);
          offset++;
        }
        if (flags & ARGS_ARE_XY_VALUES) {
          part.m.tx = arg1;
          part.m.ty = arg2;
        } else {
          part.p1 = arg1;
          part.p2 = arg2;
        }
        if (flags & WE_HAVE_A_SCALE) {
          part.m.a = part.m.d = bin.readF2dot14(data, offset);
          offset += 2;
        } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
          part.m.a = bin.readF2dot14(data, offset);
          offset += 2;
          part.m.d = bin.readF2dot14(data, offset);
          offset += 2;
        } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
          part.m.a = bin.readF2dot14(data, offset);
          offset += 2;
          part.m.b = bin.readF2dot14(data, offset);
          offset += 2;
          part.m.c = bin.readF2dot14(data, offset);
          offset += 2;
          part.m.d = bin.readF2dot14(data, offset);
          offset += 2;
        }
      } while (flags & MORE_COMPONENTS);
      if (flags & WE_HAVE_INSTRUCTIONS) {
        var numInstr = bin.readUshort(data, offset);
        offset += 2;
        gl.instr = [];
        for (var i = 0; i < numInstr; i++) {
          gl.instr.push(data[offset]);
          offset++;
        }
      }
    }
    return gl;
  };
  Typr.GPOS = {};
  Typr.GPOS.parse = function(data, offset, length, font) {
    return Typr._lctf.parse(data, offset, length, font, Typr.GPOS.subt);
  };
  Typr.GPOS.subt = function(data, ltype, offset, ltable) {
    var bin = Typr._bin, offset0 = offset, tab = {};
    tab.fmt = bin.readUshort(data, offset);
    offset += 2;
    if (ltype == 1 || ltype == 2 || ltype == 3 || ltype == 7 || ltype == 8 && tab.fmt <= 2) {
      var covOff = bin.readUshort(data, offset);
      offset += 2;
      tab.coverage = Typr._lctf.readCoverage(data, covOff + offset0);
    }
    if (ltype == 1 && tab.fmt == 1) {
      var valFmt1 = bin.readUshort(data, offset);
      offset += 2;
      var ones1 = Typr._lctf.numOfOnes(valFmt1);
      if (valFmt1 != 0)
        tab.pos = Typr.GPOS.readValueRecord(data, offset, valFmt1);
    } else if (ltype == 2 && tab.fmt >= 1 && tab.fmt <= 2) {
      var valFmt1 = bin.readUshort(data, offset);
      offset += 2;
      var valFmt2 = bin.readUshort(data, offset);
      offset += 2;
      var ones1 = Typr._lctf.numOfOnes(valFmt1);
      var ones2 = Typr._lctf.numOfOnes(valFmt2);
      if (tab.fmt == 1) {
        tab.pairsets = [];
        var psc = bin.readUshort(data, offset);
        offset += 2;
        for (var i = 0; i < psc; i++) {
          var psoff = offset0 + bin.readUshort(data, offset);
          offset += 2;
          var pvc = bin.readUshort(data, psoff);
          psoff += 2;
          var arr = [];
          for (var j = 0; j < pvc; j++) {
            var gid2 = bin.readUshort(data, psoff);
            psoff += 2;
            var value1, value2;
            if (valFmt1 != 0) {
              value1 = Typr.GPOS.readValueRecord(data, psoff, valFmt1);
              psoff += ones1 * 2;
            }
            if (valFmt2 != 0) {
              value2 = Typr.GPOS.readValueRecord(data, psoff, valFmt2);
              psoff += ones2 * 2;
            }
            arr.push({ gid2, val1: value1, val2: value2 });
          }
          tab.pairsets.push(arr);
        }
      }
      if (tab.fmt == 2) {
        var classDef1 = bin.readUshort(data, offset);
        offset += 2;
        var classDef2 = bin.readUshort(data, offset);
        offset += 2;
        var class1Count = bin.readUshort(data, offset);
        offset += 2;
        var class2Count = bin.readUshort(data, offset);
        offset += 2;
        tab.classDef1 = Typr._lctf.readClassDef(data, offset0 + classDef1);
        tab.classDef2 = Typr._lctf.readClassDef(data, offset0 + classDef2);
        tab.matrix = [];
        for (var i = 0; i < class1Count; i++) {
          var row = [];
          for (var j = 0; j < class2Count; j++) {
            var value1 = null, value2 = null;
            if (valFmt1 != 0) {
              value1 = Typr.GPOS.readValueRecord(data, offset, valFmt1);
              offset += ones1 * 2;
            }
            if (valFmt2 != 0) {
              value2 = Typr.GPOS.readValueRecord(data, offset, valFmt2);
              offset += ones2 * 2;
            }
            row.push({ val1: value1, val2: value2 });
          }
          tab.matrix.push(row);
        }
      }
    } else if (ltype == 9 && tab.fmt == 1) {
      var extType = bin.readUshort(data, offset);
      offset += 2;
      var extOffset = bin.readUint(data, offset);
      offset += 4;
      if (ltable.ltype == 9) {
        ltable.ltype = extType;
      } else if (ltable.ltype != extType) {
        throw "invalid extension substitution";
      }
      return Typr.GPOS.subt(data, ltable.ltype, offset0 + extOffset);
    } else
      console.warn("unsupported GPOS table LookupType", ltype, "format", tab.fmt);
    return tab;
  };
  Typr.GPOS.readValueRecord = function(data, offset, valFmt) {
    var bin = Typr._bin;
    var arr = [];
    arr.push(valFmt & 1 ? bin.readShort(data, offset) : 0);
    offset += valFmt & 1 ? 2 : 0;
    arr.push(valFmt & 2 ? bin.readShort(data, offset) : 0);
    offset += valFmt & 2 ? 2 : 0;
    arr.push(valFmt & 4 ? bin.readShort(data, offset) : 0);
    offset += valFmt & 4 ? 2 : 0;
    arr.push(valFmt & 8 ? bin.readShort(data, offset) : 0);
    offset += valFmt & 8 ? 2 : 0;
    return arr;
  };
  Typr.GSUB = {};
  Typr.GSUB.parse = function(data, offset, length, font) {
    return Typr._lctf.parse(data, offset, length, font, Typr.GSUB.subt);
  };
  Typr.GSUB.subt = function(data, ltype, offset, ltable) {
    var bin = Typr._bin, offset0 = offset, tab = {};
    tab.fmt = bin.readUshort(data, offset);
    offset += 2;
    if (ltype != 1 && ltype != 4 && ltype != 5 && ltype != 6)
      return null;
    if (ltype == 1 || ltype == 4 || ltype == 5 && tab.fmt <= 2 || ltype == 6 && tab.fmt <= 2) {
      var covOff = bin.readUshort(data, offset);
      offset += 2;
      tab.coverage = Typr._lctf.readCoverage(data, offset0 + covOff);
    }
    if (ltype == 1 && tab.fmt >= 1 && tab.fmt <= 2) {
      if (tab.fmt == 1) {
        tab.delta = bin.readShort(data, offset);
        offset += 2;
      } else if (tab.fmt == 2) {
        var cnt = bin.readUshort(data, offset);
        offset += 2;
        tab.newg = bin.readUshorts(data, offset, cnt);
        offset += tab.newg.length * 2;
      }
    } else if (ltype == 4) {
      tab.vals = [];
      var cnt = bin.readUshort(data, offset);
      offset += 2;
      for (var i = 0; i < cnt; i++) {
        var loff = bin.readUshort(data, offset);
        offset += 2;
        tab.vals.push(Typr.GSUB.readLigatureSet(data, offset0 + loff));
      }
    } else if (ltype == 5 && tab.fmt == 2) {
      if (tab.fmt == 2) {
        var cDefOffset = bin.readUshort(data, offset);
        offset += 2;
        tab.cDef = Typr._lctf.readClassDef(data, offset0 + cDefOffset);
        tab.scset = [];
        var subClassSetCount = bin.readUshort(data, offset);
        offset += 2;
        for (var i = 0; i < subClassSetCount; i++) {
          var scsOff = bin.readUshort(data, offset);
          offset += 2;
          tab.scset.push(scsOff == 0 ? null : Typr.GSUB.readSubClassSet(data, offset0 + scsOff));
        }
      }
    } else if (ltype == 6 && tab.fmt == 3) {
      if (tab.fmt == 3) {
        for (var i = 0; i < 3; i++) {
          var cnt = bin.readUshort(data, offset);
          offset += 2;
          var cvgs = [];
          for (var j = 0; j < cnt; j++)
            cvgs.push(Typr._lctf.readCoverage(data, offset0 + bin.readUshort(data, offset + j * 2)));
          offset += cnt * 2;
          if (i == 0)
            tab.backCvg = cvgs;
          if (i == 1)
            tab.inptCvg = cvgs;
          if (i == 2)
            tab.ahedCvg = cvgs;
        }
        var cnt = bin.readUshort(data, offset);
        offset += 2;
        tab.lookupRec = Typr.GSUB.readSubstLookupRecords(data, offset, cnt);
      }
    } else if (ltype == 7 && tab.fmt == 1) {
      var extType = bin.readUshort(data, offset);
      offset += 2;
      var extOffset = bin.readUint(data, offset);
      offset += 4;
      if (ltable.ltype == 9) {
        ltable.ltype = extType;
      } else if (ltable.ltype != extType) {
        throw "invalid extension substitution";
      }
      return Typr.GSUB.subt(data, ltable.ltype, offset0 + extOffset);
    } else
      console.warn("unsupported GSUB table LookupType", ltype, "format", tab.fmt);
    return tab;
  };
  Typr.GSUB.readSubClassSet = function(data, offset) {
    var rUs = Typr._bin.readUshort, offset0 = offset, lset = [];
    var cnt = rUs(data, offset);
    offset += 2;
    for (var i = 0; i < cnt; i++) {
      var loff = rUs(data, offset);
      offset += 2;
      lset.push(Typr.GSUB.readSubClassRule(data, offset0 + loff));
    }
    return lset;
  };
  Typr.GSUB.readSubClassRule = function(data, offset) {
    var rUs = Typr._bin.readUshort, rule = {};
    var gcount = rUs(data, offset);
    offset += 2;
    var scount = rUs(data, offset);
    offset += 2;
    rule.input = [];
    for (var i = 0; i < gcount - 1; i++) {
      rule.input.push(rUs(data, offset));
      offset += 2;
    }
    rule.substLookupRecords = Typr.GSUB.readSubstLookupRecords(data, offset, scount);
    return rule;
  };
  Typr.GSUB.readSubstLookupRecords = function(data, offset, cnt) {
    var rUs = Typr._bin.readUshort;
    var out = [];
    for (var i = 0; i < cnt; i++) {
      out.push(rUs(data, offset), rUs(data, offset + 2));
      offset += 4;
    }
    return out;
  };
  Typr.GSUB.readChainSubClassSet = function(data, offset) {
    var bin = Typr._bin, offset0 = offset, lset = [];
    var cnt = bin.readUshort(data, offset);
    offset += 2;
    for (var i = 0; i < cnt; i++) {
      var loff = bin.readUshort(data, offset);
      offset += 2;
      lset.push(Typr.GSUB.readChainSubClassRule(data, offset0 + loff));
    }
    return lset;
  };
  Typr.GSUB.readChainSubClassRule = function(data, offset) {
    var bin = Typr._bin, rule = {};
    var pps = ["backtrack", "input", "lookahead"];
    for (var pi = 0; pi < pps.length; pi++) {
      var cnt = bin.readUshort(data, offset);
      offset += 2;
      if (pi == 1)
        cnt--;
      rule[pps[pi]] = bin.readUshorts(data, offset, cnt);
      offset += rule[pps[pi]].length * 2;
    }
    var cnt = bin.readUshort(data, offset);
    offset += 2;
    rule.subst = bin.readUshorts(data, offset, cnt * 2);
    offset += rule.subst.length * 2;
    return rule;
  };
  Typr.GSUB.readLigatureSet = function(data, offset) {
    var bin = Typr._bin, offset0 = offset, lset = [];
    var lcnt = bin.readUshort(data, offset);
    offset += 2;
    for (var j = 0; j < lcnt; j++) {
      var loff = bin.readUshort(data, offset);
      offset += 2;
      lset.push(Typr.GSUB.readLigature(data, offset0 + loff));
    }
    return lset;
  };
  Typr.GSUB.readLigature = function(data, offset) {
    var bin = Typr._bin, lig = { chain: [] };
    lig.nglyph = bin.readUshort(data, offset);
    offset += 2;
    var ccnt = bin.readUshort(data, offset);
    offset += 2;
    for (var k = 0; k < ccnt - 1; k++) {
      lig.chain.push(bin.readUshort(data, offset));
      offset += 2;
    }
    return lig;
  };
  Typr.head = {};
  Typr.head.parse = function(data, offset, length) {
    var bin = Typr._bin;
    var obj = {};
    bin.readFixed(data, offset);
    offset += 4;
    obj.fontRevision = bin.readFixed(data, offset);
    offset += 4;
    bin.readUint(data, offset);
    offset += 4;
    bin.readUint(data, offset);
    offset += 4;
    obj.flags = bin.readUshort(data, offset);
    offset += 2;
    obj.unitsPerEm = bin.readUshort(data, offset);
    offset += 2;
    obj.created = bin.readUint64(data, offset);
    offset += 8;
    obj.modified = bin.readUint64(data, offset);
    offset += 8;
    obj.xMin = bin.readShort(data, offset);
    offset += 2;
    obj.yMin = bin.readShort(data, offset);
    offset += 2;
    obj.xMax = bin.readShort(data, offset);
    offset += 2;
    obj.yMax = bin.readShort(data, offset);
    offset += 2;
    obj.macStyle = bin.readUshort(data, offset);
    offset += 2;
    obj.lowestRecPPEM = bin.readUshort(data, offset);
    offset += 2;
    obj.fontDirectionHint = bin.readShort(data, offset);
    offset += 2;
    obj.indexToLocFormat = bin.readShort(data, offset);
    offset += 2;
    obj.glyphDataFormat = bin.readShort(data, offset);
    offset += 2;
    return obj;
  };
  Typr.hhea = {};
  Typr.hhea.parse = function(data, offset, length) {
    var bin = Typr._bin;
    var obj = {};
    bin.readFixed(data, offset);
    offset += 4;
    obj.ascender = bin.readShort(data, offset);
    offset += 2;
    obj.descender = bin.readShort(data, offset);
    offset += 2;
    obj.lineGap = bin.readShort(data, offset);
    offset += 2;
    obj.advanceWidthMax = bin.readUshort(data, offset);
    offset += 2;
    obj.minLeftSideBearing = bin.readShort(data, offset);
    offset += 2;
    obj.minRightSideBearing = bin.readShort(data, offset);
    offset += 2;
    obj.xMaxExtent = bin.readShort(data, offset);
    offset += 2;
    obj.caretSlopeRise = bin.readShort(data, offset);
    offset += 2;
    obj.caretSlopeRun = bin.readShort(data, offset);
    offset += 2;
    obj.caretOffset = bin.readShort(data, offset);
    offset += 2;
    offset += 4 * 2;
    obj.metricDataFormat = bin.readShort(data, offset);
    offset += 2;
    obj.numberOfHMetrics = bin.readUshort(data, offset);
    offset += 2;
    return obj;
  };
  Typr.hmtx = {};
  Typr.hmtx.parse = function(data, offset, length, font) {
    var bin = Typr._bin;
    var obj = {};
    obj.aWidth = [];
    obj.lsBearing = [];
    var aw = 0, lsb = 0;
    for (var i = 0; i < font.maxp.numGlyphs; i++) {
      if (i < font.hhea.numberOfHMetrics) {
        aw = bin.readUshort(data, offset);
        offset += 2;
        lsb = bin.readShort(data, offset);
        offset += 2;
      }
      obj.aWidth.push(aw);
      obj.lsBearing.push(lsb);
    }
    return obj;
  };
  Typr.kern = {};
  Typr.kern.parse = function(data, offset, length, font) {
    var bin = Typr._bin;
    var version = bin.readUshort(data, offset);
    offset += 2;
    if (version == 1)
      return Typr.kern.parseV1(data, offset - 2, length, font);
    var nTables = bin.readUshort(data, offset);
    offset += 2;
    var map2 = { glyph1: [], rval: [] };
    for (var i = 0; i < nTables; i++) {
      offset += 2;
      var length = bin.readUshort(data, offset);
      offset += 2;
      var coverage = bin.readUshort(data, offset);
      offset += 2;
      var format = coverage >>> 8;
      format &= 15;
      if (format == 0)
        offset = Typr.kern.readFormat0(data, offset, map2);
      else
        throw "unknown kern table format: " + format;
    }
    return map2;
  };
  Typr.kern.parseV1 = function(data, offset, length, font) {
    var bin = Typr._bin;
    bin.readFixed(data, offset);
    offset += 4;
    var nTables = bin.readUint(data, offset);
    offset += 4;
    var map2 = { glyph1: [], rval: [] };
    for (var i = 0; i < nTables; i++) {
      bin.readUint(data, offset);
      offset += 4;
      var coverage = bin.readUshort(data, offset);
      offset += 2;
      bin.readUshort(data, offset);
      offset += 2;
      var format = coverage >>> 8;
      format &= 15;
      if (format == 0)
        offset = Typr.kern.readFormat0(data, offset, map2);
      else
        throw "unknown kern table format: " + format;
    }
    return map2;
  };
  Typr.kern.readFormat0 = function(data, offset, map2) {
    var bin = Typr._bin;
    var pleft = -1;
    var nPairs = bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    for (var j = 0; j < nPairs; j++) {
      var left = bin.readUshort(data, offset);
      offset += 2;
      var right = bin.readUshort(data, offset);
      offset += 2;
      var value = bin.readShort(data, offset);
      offset += 2;
      if (left != pleft) {
        map2.glyph1.push(left);
        map2.rval.push({ glyph2: [], vals: [] });
      }
      var rval = map2.rval[map2.rval.length - 1];
      rval.glyph2.push(right);
      rval.vals.push(value);
      pleft = left;
    }
    return offset;
  };
  Typr.loca = {};
  Typr.loca.parse = function(data, offset, length, font) {
    var bin = Typr._bin;
    var obj = [];
    var ver = font.head.indexToLocFormat;
    var len = font.maxp.numGlyphs + 1;
    if (ver == 0)
      for (var i = 0; i < len; i++)
        obj.push(bin.readUshort(data, offset + (i << 1)) << 1);
    if (ver == 1)
      for (var i = 0; i < len; i++)
        obj.push(bin.readUint(data, offset + (i << 2)));
    return obj;
  };
  Typr.maxp = {};
  Typr.maxp.parse = function(data, offset, length) {
    var bin = Typr._bin;
    var obj = {};
    var ver = bin.readUint(data, offset);
    offset += 4;
    obj.numGlyphs = bin.readUshort(data, offset);
    offset += 2;
    if (ver == 65536) {
      obj.maxPoints = bin.readUshort(data, offset);
      offset += 2;
      obj.maxContours = bin.readUshort(data, offset);
      offset += 2;
      obj.maxCompositePoints = bin.readUshort(data, offset);
      offset += 2;
      obj.maxCompositeContours = bin.readUshort(data, offset);
      offset += 2;
      obj.maxZones = bin.readUshort(data, offset);
      offset += 2;
      obj.maxTwilightPoints = bin.readUshort(data, offset);
      offset += 2;
      obj.maxStorage = bin.readUshort(data, offset);
      offset += 2;
      obj.maxFunctionDefs = bin.readUshort(data, offset);
      offset += 2;
      obj.maxInstructionDefs = bin.readUshort(data, offset);
      offset += 2;
      obj.maxStackElements = bin.readUshort(data, offset);
      offset += 2;
      obj.maxSizeOfInstructions = bin.readUshort(data, offset);
      offset += 2;
      obj.maxComponentElements = bin.readUshort(data, offset);
      offset += 2;
      obj.maxComponentDepth = bin.readUshort(data, offset);
      offset += 2;
    }
    return obj;
  };
  Typr.name = {};
  Typr.name.parse = function(data, offset, length) {
    var bin = Typr._bin;
    var obj = {};
    bin.readUshort(data, offset);
    offset += 2;
    var count = bin.readUshort(data, offset);
    offset += 2;
    bin.readUshort(data, offset);
    offset += 2;
    var names2 = [
      "copyright",
      "fontFamily",
      "fontSubfamily",
      "ID",
      "fullName",
      "version",
      "postScriptName",
      "trademark",
      "manufacturer",
      "designer",
      "description",
      "urlVendor",
      "urlDesigner",
      "licence",
      "licenceURL",
      "---",
      "typoFamilyName",
      "typoSubfamilyName",
      "compatibleFull",
      "sampleText",
      "postScriptCID",
      "wwsFamilyName",
      "wwsSubfamilyName",
      "lightPalette",
      "darkPalette"
    ];
    var offset0 = offset;
    for (var i = 0; i < count; i++) {
      var platformID = bin.readUshort(data, offset);
      offset += 2;
      var encodingID = bin.readUshort(data, offset);
      offset += 2;
      var languageID = bin.readUshort(data, offset);
      offset += 2;
      var nameID = bin.readUshort(data, offset);
      offset += 2;
      var slen = bin.readUshort(data, offset);
      offset += 2;
      var noffset = bin.readUshort(data, offset);
      offset += 2;
      var cname = names2[nameID];
      var soff = offset0 + count * 12 + noffset;
      var str;
      if (platformID == 0)
        str = bin.readUnicode(data, soff, slen / 2);
      else if (platformID == 3 && encodingID == 0)
        str = bin.readUnicode(data, soff, slen / 2);
      else if (encodingID == 0)
        str = bin.readASCII(data, soff, slen);
      else if (encodingID == 1)
        str = bin.readUnicode(data, soff, slen / 2);
      else if (encodingID == 3)
        str = bin.readUnicode(data, soff, slen / 2);
      else if (platformID == 1) {
        str = bin.readASCII(data, soff, slen);
        console.warn("reading unknown MAC encoding " + encodingID + " as ASCII");
      } else
        throw "unknown encoding " + encodingID + ", platformID: " + platformID;
      var tid = "p" + platformID + "," + languageID.toString(16);
      if (obj[tid] == null)
        obj[tid] = {};
      obj[tid][cname !== void 0 ? cname : nameID] = str;
      obj[tid]._lang = languageID;
    }
    for (var p in obj)
      if (obj[p].postScriptName != null && obj[p]._lang == 1033)
        return obj[p];
    for (var p in obj)
      if (obj[p].postScriptName != null && obj[p]._lang == 0)
        return obj[p];
    for (var p in obj)
      if (obj[p].postScriptName != null && obj[p]._lang == 3084)
        return obj[p];
    for (var p in obj)
      if (obj[p].postScriptName != null)
        return obj[p];
    var tname;
    for (var p in obj) {
      tname = p;
      break;
    }
    console.warn("returning name table with languageID " + obj[tname]._lang);
    return obj[tname];
  };
  Typr["OS/2"] = {};
  Typr["OS/2"].parse = function(data, offset, length) {
    var bin = Typr._bin;
    var ver = bin.readUshort(data, offset);
    offset += 2;
    var obj = {};
    if (ver == 0)
      Typr["OS/2"].version0(data, offset, obj);
    else if (ver == 1)
      Typr["OS/2"].version1(data, offset, obj);
    else if (ver == 2 || ver == 3 || ver == 4)
      Typr["OS/2"].version2(data, offset, obj);
    else if (ver == 5)
      Typr["OS/2"].version5(data, offset, obj);
    else
      throw "unknown OS/2 table version: " + ver;
    return obj;
  };
  Typr["OS/2"].version0 = function(data, offset, obj) {
    var bin = Typr._bin;
    obj.xAvgCharWidth = bin.readShort(data, offset);
    offset += 2;
    obj.usWeightClass = bin.readUshort(data, offset);
    offset += 2;
    obj.usWidthClass = bin.readUshort(data, offset);
    offset += 2;
    obj.fsType = bin.readUshort(data, offset);
    offset += 2;
    obj.ySubscriptXSize = bin.readShort(data, offset);
    offset += 2;
    obj.ySubscriptYSize = bin.readShort(data, offset);
    offset += 2;
    obj.ySubscriptXOffset = bin.readShort(data, offset);
    offset += 2;
    obj.ySubscriptYOffset = bin.readShort(data, offset);
    offset += 2;
    obj.ySuperscriptXSize = bin.readShort(data, offset);
    offset += 2;
    obj.ySuperscriptYSize = bin.readShort(data, offset);
    offset += 2;
    obj.ySuperscriptXOffset = bin.readShort(data, offset);
    offset += 2;
    obj.ySuperscriptYOffset = bin.readShort(data, offset);
    offset += 2;
    obj.yStrikeoutSize = bin.readShort(data, offset);
    offset += 2;
    obj.yStrikeoutPosition = bin.readShort(data, offset);
    offset += 2;
    obj.sFamilyClass = bin.readShort(data, offset);
    offset += 2;
    obj.panose = bin.readBytes(data, offset, 10);
    offset += 10;
    obj.ulUnicodeRange1 = bin.readUint(data, offset);
    offset += 4;
    obj.ulUnicodeRange2 = bin.readUint(data, offset);
    offset += 4;
    obj.ulUnicodeRange3 = bin.readUint(data, offset);
    offset += 4;
    obj.ulUnicodeRange4 = bin.readUint(data, offset);
    offset += 4;
    obj.achVendID = [bin.readInt8(data, offset), bin.readInt8(data, offset + 1), bin.readInt8(data, offset + 2), bin.readInt8(data, offset + 3)];
    offset += 4;
    obj.fsSelection = bin.readUshort(data, offset);
    offset += 2;
    obj.usFirstCharIndex = bin.readUshort(data, offset);
    offset += 2;
    obj.usLastCharIndex = bin.readUshort(data, offset);
    offset += 2;
    obj.sTypoAscender = bin.readShort(data, offset);
    offset += 2;
    obj.sTypoDescender = bin.readShort(data, offset);
    offset += 2;
    obj.sTypoLineGap = bin.readShort(data, offset);
    offset += 2;
    obj.usWinAscent = bin.readUshort(data, offset);
    offset += 2;
    obj.usWinDescent = bin.readUshort(data, offset);
    offset += 2;
    return offset;
  };
  Typr["OS/2"].version1 = function(data, offset, obj) {
    var bin = Typr._bin;
    offset = Typr["OS/2"].version0(data, offset, obj);
    obj.ulCodePageRange1 = bin.readUint(data, offset);
    offset += 4;
    obj.ulCodePageRange2 = bin.readUint(data, offset);
    offset += 4;
    return offset;
  };
  Typr["OS/2"].version2 = function(data, offset, obj) {
    var bin = Typr._bin;
    offset = Typr["OS/2"].version1(data, offset, obj);
    obj.sxHeight = bin.readShort(data, offset);
    offset += 2;
    obj.sCapHeight = bin.readShort(data, offset);
    offset += 2;
    obj.usDefault = bin.readUshort(data, offset);
    offset += 2;
    obj.usBreak = bin.readUshort(data, offset);
    offset += 2;
    obj.usMaxContext = bin.readUshort(data, offset);
    offset += 2;
    return offset;
  };
  Typr["OS/2"].version5 = function(data, offset, obj) {
    var bin = Typr._bin;
    offset = Typr["OS/2"].version2(data, offset, obj);
    obj.usLowerOpticalPointSize = bin.readUshort(data, offset);
    offset += 2;
    obj.usUpperOpticalPointSize = bin.readUshort(data, offset);
    offset += 2;
    return offset;
  };
  Typr.post = {};
  Typr.post.parse = function(data, offset, length) {
    var bin = Typr._bin;
    var obj = {};
    obj.version = bin.readFixed(data, offset);
    offset += 4;
    obj.italicAngle = bin.readFixed(data, offset);
    offset += 4;
    obj.underlinePosition = bin.readShort(data, offset);
    offset += 2;
    obj.underlineThickness = bin.readShort(data, offset);
    offset += 2;
    return obj;
  };
  Typr.SVG = {};
  Typr.SVG.parse = function(data, offset, length) {
    var bin = Typr._bin;
    var obj = { entries: [] };
    var offset0 = offset;
    bin.readUshort(data, offset);
    offset += 2;
    var svgDocIndexOffset = bin.readUint(data, offset);
    offset += 4;
    bin.readUint(data, offset);
    offset += 4;
    offset = svgDocIndexOffset + offset0;
    var numEntries = bin.readUshort(data, offset);
    offset += 2;
    for (var i = 0; i < numEntries; i++) {
      var startGlyphID = bin.readUshort(data, offset);
      offset += 2;
      var endGlyphID = bin.readUshort(data, offset);
      offset += 2;
      var svgDocOffset = bin.readUint(data, offset);
      offset += 4;
      var svgDocLength = bin.readUint(data, offset);
      offset += 4;
      var sbuf = new Uint8Array(data.buffer, offset0 + svgDocOffset + svgDocIndexOffset, svgDocLength);
      var svg = bin.readUTF8(sbuf, 0, sbuf.length);
      for (var f = startGlyphID; f <= endGlyphID; f++) {
        obj.entries[f] = svg;
      }
    }
    return obj;
  };
  Typr.SVG.toPath = function(str) {
    var pth = { cmds: [], crds: [] };
    if (str == null)
      return pth;
    var prsr = new DOMParser();
    var doc = prsr["parseFromString"](str, "image/svg+xml");
    var svg = doc.firstChild;
    while (svg.tagName != "svg")
      svg = svg.nextSibling;
    var vb = svg.getAttribute("viewBox");
    if (vb)
      vb = vb.trim().split(" ").map(parseFloat);
    else
      vb = [0, 0, 1e3, 1e3];
    Typr.SVG._toPath(svg.children, pth);
    for (var i = 0; i < pth.crds.length; i += 2) {
      var x = pth.crds[i], y = pth.crds[i + 1];
      x -= vb[0];
      y -= vb[1];
      y = -y;
      pth.crds[i] = x;
      pth.crds[i + 1] = y;
    }
    return pth;
  };
  Typr.SVG._toPath = function(nds, pth, fill) {
    for (var ni = 0; ni < nds.length; ni++) {
      var nd = nds[ni], tn = nd.tagName;
      var cfl = nd.getAttribute("fill");
      if (cfl == null)
        cfl = fill;
      if (tn == "g")
        Typr.SVG._toPath(nd.children, pth, cfl);
      else if (tn == "path") {
        pth.cmds.push(cfl ? cfl : "#000000");
        var d = nd.getAttribute("d");
        var toks = Typr.SVG._tokens(d);
        Typr.SVG._toksToPath(toks, pth);
        pth.cmds.push("X");
      } else if (tn == "defs") ;
      else
        console.warn(tn, nd);
    }
  };
  Typr.SVG._tokens = function(d) {
    var ts = [], off = 0, rn = false, cn = "";
    while (off < d.length) {
      var cc = d.charCodeAt(off), ch = d.charAt(off);
      off++;
      var isNum = 48 <= cc && cc <= 57 || ch == "." || ch == "-";
      if (rn) {
        if (ch == "-") {
          ts.push(parseFloat(cn));
          cn = ch;
        } else if (isNum)
          cn += ch;
        else {
          ts.push(parseFloat(cn));
          if (ch != "," && ch != " ")
            ts.push(ch);
          rn = false;
        }
      } else {
        if (isNum) {
          cn = ch;
          rn = true;
        } else if (ch != "," && ch != " ")
          ts.push(ch);
      }
    }
    if (rn)
      ts.push(parseFloat(cn));
    return ts;
  };
  Typr.SVG._toksToPath = function(ts, pth) {
    var i = 0, x = 0, y = 0, ox = 0, oy = 0;
    var pc = { "M": 2, "L": 2, "H": 1, "V": 1, "S": 4, "C": 6 };
    var cmds = pth.cmds, crds = pth.crds;
    while (i < ts.length) {
      var cmd = ts[i];
      i++;
      if (cmd == "z") {
        cmds.push("Z");
        x = ox;
        y = oy;
      } else {
        var cmu = cmd.toUpperCase();
        var ps = pc[cmu], reps = Typr.SVG._reps(ts, i, ps);
        for (var j = 0; j < reps; j++) {
          var xi = 0, yi = 0;
          if (cmd != cmu) {
            xi = x;
            yi = y;
          }
          if (cmu == "M") {
            x = xi + ts[i++];
            y = yi + ts[i++];
            cmds.push("M");
            crds.push(x, y);
            ox = x;
            oy = y;
          } else if (cmu == "L") {
            x = xi + ts[i++];
            y = yi + ts[i++];
            cmds.push("L");
            crds.push(x, y);
          } else if (cmu == "H") {
            x = xi + ts[i++];
            cmds.push("L");
            crds.push(x, y);
          } else if (cmu == "V") {
            y = yi + ts[i++];
            cmds.push("L");
            crds.push(x, y);
          } else if (cmu == "C") {
            var x1 = xi + ts[i++], y1 = yi + ts[i++], x2 = xi + ts[i++], y2 = yi + ts[i++], x3 = xi + ts[i++], y3 = yi + ts[i++];
            cmds.push("C");
            crds.push(x1, y1, x2, y2, x3, y3);
            x = x3;
            y = y3;
          } else if (cmu == "S") {
            var co = Math.max(crds.length - 4, 0);
            var x1 = x + x - crds[co], y1 = y + y - crds[co + 1];
            var x2 = xi + ts[i++], y2 = yi + ts[i++], x3 = xi + ts[i++], y3 = yi + ts[i++];
            cmds.push("C");
            crds.push(x1, y1, x2, y2, x3, y3);
            x = x3;
            y = y3;
          } else
            console.warn("Unknown SVG command " + cmd);
        }
      }
    }
  };
  Typr.SVG._reps = function(ts, off, ps) {
    var i = off;
    while (i < ts.length) {
      if (typeof ts[i] == "string")
        break;
      i += ps;
    }
    return (i - off) / ps;
  };
  if (Typr == null)
    Typr = {};
  if (Typr.U == null)
    Typr.U = {};
  Typr.U.codeToGlyph = function(font, code) {
    var cmap = font.cmap;
    for (var _i = 0, _a = [cmap.p0e4, cmap.p3e1, cmap.p3e10, cmap.p0e3, cmap.p1e0]; _i < _a.length; _i++) {
      var tind = _a[_i];
      if (tind == null)
        continue;
      var tab = cmap.tables[tind];
      if (tab.format == 0) {
        if (code >= tab.map.length)
          continue;
        return tab.map[code];
      } else if (tab.format == 4) {
        var sind = -1;
        for (var i = 0; i < tab.endCount.length; i++) {
          if (code <= tab.endCount[i]) {
            sind = i;
            break;
          }
        }
        if (sind == -1)
          continue;
        if (tab.startCount[sind] > code)
          continue;
        var gli = 0;
        if (tab.idRangeOffset[sind] != 0) {
          gli = tab.glyphIdArray[code - tab.startCount[sind] + (tab.idRangeOffset[sind] >> 1) - (tab.idRangeOffset.length - sind)];
        } else {
          gli = code + tab.idDelta[sind];
        }
        return gli & 65535;
      } else if (tab.format == 12) {
        if (code > tab.groups[tab.groups.length - 1][1])
          continue;
        for (var i = 0; i < tab.groups.length; i++) {
          var grp = tab.groups[i];
          if (grp[0] <= code && code <= grp[1])
            return grp[2] + (code - grp[0]);
        }
        continue;
      } else {
        throw "unknown cmap table format " + tab.format;
      }
    }
    return 0;
  };
  Typr.U.glyphToPath = function(font, gid) {
    var path = { cmds: [], crds: [] };
    if (font.SVG && font.SVG.entries[gid]) {
      var p = font.SVG.entries[gid];
      if (p == null)
        return path;
      if (typeof p == "string") {
        p = Typr.SVG.toPath(p);
        font.SVG.entries[gid] = p;
      }
      return p;
    } else if (font.CFF) {
      var state = { x: 0, y: 0, stack: [], nStems: 0, haveWidth: false, width: font.CFF.Private ? font.CFF.Private.defaultWidthX : 0, open: false };
      var cff = font.CFF, pdct = font.CFF.Private;
      if (cff.ROS) {
        var gi = 0;
        while (cff.FDSelect[gi + 2] <= gid)
          gi += 2;
        pdct = cff.FDArray[cff.FDSelect[gi + 1]].Private;
      }
      Typr.U._drawCFF(font.CFF.CharStrings[gid], state, cff, pdct, path);
    } else if (font.glyf) {
      Typr.U._drawGlyf(gid, font, path);
    }
    return path;
  };
  Typr.U._drawGlyf = function(gid, font, path) {
    var gl = font.glyf[gid];
    if (gl == null)
      gl = font.glyf[gid] = Typr.glyf._parseGlyf(font, gid);
    if (gl != null) {
      if (gl.noc > -1) {
        Typr.U._simpleGlyph(gl, path);
      } else {
        Typr.U._compoGlyph(gl, font, path);
      }
    }
  };
  Typr.U._simpleGlyph = function(gl, p) {
    for (var c = 0; c < gl.noc; c++) {
      var i0 = c == 0 ? 0 : gl.endPts[c - 1] + 1;
      var il = gl.endPts[c];
      for (var i = i0; i <= il; i++) {
        var pr = i == i0 ? il : i - 1;
        var nx = i == il ? i0 : i + 1;
        var onCurve = gl.flags[i] & 1;
        var prOnCurve = gl.flags[pr] & 1;
        var nxOnCurve = gl.flags[nx] & 1;
        var x = gl.xs[i], y = gl.ys[i];
        if (i == i0) {
          if (onCurve) {
            if (prOnCurve) {
              Typr.U.P.moveTo(p, gl.xs[pr], gl.ys[pr]);
            } else {
              Typr.U.P.moveTo(p, x, y);
              continue;
            }
          } else {
            if (prOnCurve) {
              Typr.U.P.moveTo(p, gl.xs[pr], gl.ys[pr]);
            } else {
              Typr.U.P.moveTo(p, (gl.xs[pr] + x) / 2, (gl.ys[pr] + y) / 2);
            }
          }
        }
        if (onCurve) {
          if (prOnCurve)
            Typr.U.P.lineTo(p, x, y);
        } else {
          if (nxOnCurve) {
            Typr.U.P.qcurveTo(p, x, y, gl.xs[nx], gl.ys[nx]);
          } else {
            Typr.U.P.qcurveTo(p, x, y, (x + gl.xs[nx]) / 2, (y + gl.ys[nx]) / 2);
          }
        }
      }
      Typr.U.P.closePath(p);
    }
  };
  Typr.U._compoGlyph = function(gl, font, p) {
    for (var j = 0; j < gl.parts.length; j++) {
      var path = { cmds: [], crds: [] };
      var prt = gl.parts[j];
      Typr.U._drawGlyf(prt.glyphIndex, font, path);
      var m = prt.m;
      for (var i = 0; i < path.crds.length; i += 2) {
        var x = path.crds[i], y = path.crds[i + 1];
        p.crds.push(x * m.a + y * m.b + m.tx);
        p.crds.push(x * m.c + y * m.d + m.ty);
      }
      for (var i = 0; i < path.cmds.length; i++) {
        p.cmds.push(path.cmds[i]);
      }
    }
  };
  Typr.U._getGlyphClass = function(g, cd) {
    var intr = Typr._lctf.getInterval(cd, g);
    return intr == -1 ? 0 : cd[intr + 2];
  };
  Typr.U.getPairAdjustment = function(font, g1, g2) {
    var hasGPOSkern = false;
    if (font.GPOS) {
      var gpos = font["GPOS"];
      var llist = gpos.lookupList, flist = gpos.featureList;
      var tused = [];
      for (var i = 0; i < flist.length; i++) {
        var fl = flist[i];
        if (fl.tag != "kern")
          continue;
        hasGPOSkern = true;
        for (var ti = 0; ti < fl.tab.length; ti++) {
          if (tused[fl.tab[ti]])
            continue;
          tused[fl.tab[ti]] = true;
          var tab = llist[fl.tab[ti]];
          for (var j = 0; j < tab.tabs.length; j++) {
            if (tab.tabs[j] == null)
              continue;
            var ltab = tab.tabs[j], ind;
            if (ltab.coverage) {
              ind = Typr._lctf.coverageIndex(ltab.coverage, g1);
              if (ind == -1)
                continue;
            }
            if (tab.ltype == 1) ;
            else if (tab.ltype == 2) {
              var adj = null;
              if (ltab.fmt == 1) {
                var right = ltab.pairsets[ind];
                for (var i = 0; i < right.length; i++) {
                  if (right[i].gid2 == g2)
                    adj = right[i];
                }
              } else if (ltab.fmt == 2) {
                var c1 = Typr.U._getGlyphClass(g1, ltab.classDef1);
                var c2 = Typr.U._getGlyphClass(g2, ltab.classDef2);
                adj = ltab.matrix[c1][c2];
              }
              if (adj) {
                var offset = 0;
                if (adj.val1 && adj.val1[2])
                  offset += adj.val1[2];
                if (adj.val2 && adj.val2[0])
                  offset += adj.val2[0];
                return offset;
              }
            }
          }
        }
      }
    }
    if (font.kern && !hasGPOSkern) {
      var ind1 = font.kern.glyph1.indexOf(g1);
      if (ind1 != -1) {
        var ind2 = font.kern.rval[ind1].glyph2.indexOf(g2);
        if (ind2 != -1)
          return font.kern.rval[ind1].vals[ind2];
      }
    }
    return 0;
  };
  Typr.U.stringToGlyphs = function(font, str) {
    var gls = [];
    for (var i = 0; i < str.length; i++) {
      var cc = str.codePointAt(i);
      if (cc > 65535)
        i++;
      gls.push(Typr.U.codeToGlyph(font, cc));
    }
    for (var i = 0; i < str.length; i++) {
      var cc = str.codePointAt(i);
      if (cc == 2367) {
        var t = gls[i - 1];
        gls[i - 1] = gls[i];
        gls[i] = t;
      }
      if (cc > 65535)
        i++;
    }
    var gsub = font["GSUB"];
    if (gsub == null)
      return gls;
    var llist = gsub.lookupList, flist = gsub.featureList;
    var cligs = [
      "rlig",
      "liga",
      "mset",
      "isol",
      "init",
      "fina",
      "medi",
      "half",
      "pres",
      "blws"
      /* Tibetan fonts like Himalaya.ttf */
    ];
    var tused = [];
    for (var fi = 0; fi < flist.length; fi++) {
      var fl = flist[fi];
      if (cligs.indexOf(fl.tag) == -1)
        continue;
      for (var ti = 0; ti < fl.tab.length; ti++) {
        if (tused[fl.tab[ti]])
          continue;
        tused[fl.tab[ti]] = true;
        var tab = llist[fl.tab[ti]];
        for (var ci = 0; ci < gls.length; ci++) {
          var feat = Typr.U._getWPfeature(str, ci);
          if ("isol,init,fina,medi".indexOf(fl.tag) != -1 && fl.tag != feat)
            continue;
          Typr.U._applySubs(gls, ci, tab, llist);
        }
      }
    }
    return gls;
  };
  Typr.U._getWPfeature = function(str, ci) {
    var wsep = '\n	" ,.:;!?()  ،';
    var R = "آأؤإاةدذرزوٱٲٳٵٶٷڈډڊڋڌڍڎڏڐڑڒړڔڕږڗژڙۀۃۄۅۆۇۈۉۊۋۍۏےۓەۮۯܐܕܖܗܘܙܞܨܪܬܯݍݙݚݛݫݬݱݳݴݸݹࡀࡆࡇࡉࡔࡧࡩࡪࢪࢫࢬࢮࢱࢲࢹૅેૉ૊૎૏ૐ૑૒૝ૡ૤૯஁ஃ஄அஉ஌எஏ஑னப஫஬";
    var L = "ꡲ્૗";
    var slft = ci == 0 || wsep.indexOf(str[ci - 1]) != -1;
    var srgt = ci == str.length - 1 || wsep.indexOf(str[ci + 1]) != -1;
    if (!slft && R.indexOf(str[ci - 1]) != -1)
      slft = true;
    if (!srgt && R.indexOf(str[ci]) != -1)
      srgt = true;
    if (!srgt && L.indexOf(str[ci + 1]) != -1)
      srgt = true;
    if (!slft && L.indexOf(str[ci]) != -1)
      slft = true;
    var feat = null;
    if (slft) {
      feat = srgt ? "isol" : "init";
    } else {
      feat = srgt ? "fina" : "medi";
    }
    return feat;
  };
  Typr.U._applySubs = function(gls, ci, tab, llist) {
    var rlim = gls.length - ci - 1;
    for (var j = 0; j < tab.tabs.length; j++) {
      if (tab.tabs[j] == null)
        continue;
      var ltab = tab.tabs[j], ind;
      if (ltab.coverage) {
        ind = Typr._lctf.coverageIndex(ltab.coverage, gls[ci]);
        if (ind == -1)
          continue;
      }
      if (tab.ltype == 1) {
        gls[ci];
        if (ltab.fmt == 1)
          gls[ci] = gls[ci] + ltab.delta;
        else
          gls[ci] = ltab.newg[ind];
      } else if (tab.ltype == 4) {
        var vals = ltab.vals[ind];
        for (var k = 0; k < vals.length; k++) {
          var lig = vals[k], rl = lig.chain.length;
          if (rl > rlim)
            continue;
          var good = true, em1 = 0;
          for (var l = 0; l < rl; l++) {
            while (gls[ci + em1 + (1 + l)] == -1)
              em1++;
            if (lig.chain[l] != gls[ci + em1 + (1 + l)])
              good = false;
          }
          if (!good)
            continue;
          gls[ci] = lig.nglyph;
          for (var l = 0; l < rl + em1; l++)
            gls[ci + l + 1] = -1;
          break;
        }
      } else if (tab.ltype == 5 && ltab.fmt == 2) {
        var cind = Typr._lctf.getInterval(ltab.cDef, gls[ci]);
        var cls = ltab.cDef[cind + 2], scs = ltab.scset[cls];
        for (var i = 0; i < scs.length; i++) {
          var sc = scs[i], inp = sc.input;
          if (inp.length > rlim)
            continue;
          var good = true;
          for (var l = 0; l < inp.length; l++) {
            var cind2 = Typr._lctf.getInterval(ltab.cDef, gls[ci + 1 + l]);
            if (cind == -1 && ltab.cDef[cind2 + 2] != inp[l]) {
              good = false;
              break;
            }
          }
          if (!good)
            continue;
          var lrs = sc.substLookupRecords;
          for (var k = 0; k < lrs.length; k += 2) {
            lrs[k];
            lrs[k + 1];
          }
        }
      } else if (tab.ltype == 6 && ltab.fmt == 3) {
        if (!Typr.U._glsCovered(gls, ltab.backCvg, ci - ltab.backCvg.length))
          continue;
        if (!Typr.U._glsCovered(gls, ltab.inptCvg, ci))
          continue;
        if (!Typr.U._glsCovered(gls, ltab.ahedCvg, ci + ltab.inptCvg.length))
          continue;
        var lr = ltab.lookupRec;
        for (var i = 0; i < lr.length; i += 2) {
          var cind = lr[i], tab2 = llist[lr[i + 1]];
          Typr.U._applySubs(gls, ci + cind, tab2, llist);
        }
      }
    }
  };
  Typr.U._glsCovered = function(gls, cvgs, ci) {
    for (var i = 0; i < cvgs.length; i++) {
      var ind = Typr._lctf.coverageIndex(cvgs[i], gls[ci + i]);
      if (ind == -1)
        return false;
    }
    return true;
  };
  Typr.U.glyphsToPath = function(font, gls, clr) {
    var tpath = { cmds: [], crds: [] };
    var x = 0;
    for (var i = 0; i < gls.length; i++) {
      var gid = gls[i];
      if (gid == -1)
        continue;
      var gid2 = i < gls.length - 1 && gls[i + 1] != -1 ? gls[i + 1] : 0;
      var path = Typr.U.glyphToPath(font, gid);
      for (var j = 0; j < path.crds.length; j += 2) {
        tpath.crds.push(path.crds[j] + x);
        tpath.crds.push(path.crds[j + 1]);
      }
      if (clr)
        tpath.cmds.push(clr);
      for (var j = 0; j < path.cmds.length; j++)
        tpath.cmds.push(path.cmds[j]);
      if (clr)
        tpath.cmds.push("X");
      x += font.hmtx.aWidth[gid];
      if (i < gls.length - 1)
        x += Typr.U.getPairAdjustment(font, gid, gid2);
    }
    return tpath;
  };
  Typr.U.pathToSVG = function(path, prec) {
    if (prec == null)
      prec = 5;
    var out = [], co = 0, lmap = { "M": 2, "L": 2, "Q": 4, "C": 6 };
    for (var i = 0; i < path.cmds.length; i++) {
      var cmd = path.cmds[i], cn = co + (lmap[cmd] ? lmap[cmd] : 0);
      out.push(cmd);
      while (co < cn) {
        var c = path.crds[co++];
        out.push(parseFloat(c.toFixed(prec)) + (co == cn ? "" : " "));
      }
    }
    return out.join("");
  };
  Typr.U.pathToContext = function(path, ctx) {
    var c = 0, crds = path.crds;
    for (var j = 0; j < path.cmds.length; j++) {
      var cmd = path.cmds[j];
      if (cmd == "M") {
        ctx.moveTo(crds[c], crds[c + 1]);
        c += 2;
      } else if (cmd == "L") {
        ctx.lineTo(crds[c], crds[c + 1]);
        c += 2;
      } else if (cmd == "C") {
        ctx.bezierCurveTo(crds[c], crds[c + 1], crds[c + 2], crds[c + 3], crds[c + 4], crds[c + 5]);
        c += 6;
      } else if (cmd == "Q") {
        ctx.quadraticCurveTo(crds[c], crds[c + 1], crds[c + 2], crds[c + 3]);
        c += 4;
      } else if (cmd.charAt(0) == "#") {
        ctx.beginPath();
        ctx.fillStyle = cmd;
      } else if (cmd == "Z") {
        ctx.closePath();
      } else if (cmd == "X") {
        ctx.fill();
      }
    }
  };
  Typr.U.P = {};
  Typr.U.P.moveTo = function(p, x, y) {
    p.cmds.push("M");
    p.crds.push(x, y);
  };
  Typr.U.P.lineTo = function(p, x, y) {
    p.cmds.push("L");
    p.crds.push(x, y);
  };
  Typr.U.P.curveTo = function(p, a, b, c, d, e, f) {
    p.cmds.push("C");
    p.crds.push(a, b, c, d, e, f);
  };
  Typr.U.P.qcurveTo = function(p, a, b, c, d) {
    p.cmds.push("Q");
    p.crds.push(a, b, c, d);
  };
  Typr.U.P.closePath = function(p) {
    p.cmds.push("Z");
  };
  Typr.U._drawCFF = function(cmds, state, font, pdct, p) {
    var stack = state.stack;
    var nStems = state.nStems, haveWidth = state.haveWidth, width = state.width, open = state.open;
    var i = 0;
    var x = state.x, y = state.y, c1x = 0, c1y = 0, c2x = 0, c2y = 0, c3x = 0, c3y = 0, c4x = 0, c4y = 0, jpx = 0, jpy = 0;
    var o = { val: 0, size: 0 };
    while (i < cmds.length) {
      Typr.CFF.getCharString(cmds, i, o);
      var v = o.val;
      i += o.size;
      if (v == "o1" || v == "o18") {
        var hasWidthArg;
        hasWidthArg = stack.length % 2 !== 0;
        if (hasWidthArg && !haveWidth) {
          width = stack.shift() + pdct.nominalWidthX;
        }
        nStems += stack.length >> 1;
        stack.length = 0;
        haveWidth = true;
      } else if (v == "o3" || v == "o23") {
        var hasWidthArg;
        hasWidthArg = stack.length % 2 !== 0;
        if (hasWidthArg && !haveWidth) {
          width = stack.shift() + pdct.nominalWidthX;
        }
        nStems += stack.length >> 1;
        stack.length = 0;
        haveWidth = true;
      } else if (v == "o4") {
        if (stack.length > 1 && !haveWidth) {
          width = stack.shift() + pdct.nominalWidthX;
          haveWidth = true;
        }
        if (open)
          Typr.U.P.closePath(p);
        y += stack.pop();
        Typr.U.P.moveTo(p, x, y);
        open = true;
      } else if (v == "o5") {
        while (stack.length > 0) {
          x += stack.shift();
          y += stack.shift();
          Typr.U.P.lineTo(p, x, y);
        }
      } else if (v == "o6" || v == "o7") {
        var count = stack.length;
        var isX = v == "o6";
        for (var j = 0; j < count; j++) {
          var sval = stack.shift();
          if (isX) {
            x += sval;
          } else {
            y += sval;
          }
          isX = !isX;
          Typr.U.P.lineTo(p, x, y);
        }
      } else if (v == "o8" || v == "o24") {
        var count = stack.length;
        var index = 0;
        while (index + 6 <= count) {
          c1x = x + stack.shift();
          c1y = y + stack.shift();
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          x = c2x + stack.shift();
          y = c2y + stack.shift();
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
          index += 6;
        }
        if (v == "o24") {
          x += stack.shift();
          y += stack.shift();
          Typr.U.P.lineTo(p, x, y);
        }
      } else if (v == "o11") {
        break;
      } else if (v == "o1234" || v == "o1235" || v == "o1236" || v == "o1237") {
        if (v == "o1234") {
          c1x = x + stack.shift();
          c1y = y;
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          jpx = c2x + stack.shift();
          jpy = c2y;
          c3x = jpx + stack.shift();
          c3y = c2y;
          c4x = c3x + stack.shift();
          c4y = y;
          x = c4x + stack.shift();
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
          Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
        }
        if (v == "o1235") {
          c1x = x + stack.shift();
          c1y = y + stack.shift();
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          jpx = c2x + stack.shift();
          jpy = c2y + stack.shift();
          c3x = jpx + stack.shift();
          c3y = jpy + stack.shift();
          c4x = c3x + stack.shift();
          c4y = c3y + stack.shift();
          x = c4x + stack.shift();
          y = c4y + stack.shift();
          stack.shift();
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
          Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
        }
        if (v == "o1236") {
          c1x = x + stack.shift();
          c1y = y + stack.shift();
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          jpx = c2x + stack.shift();
          jpy = c2y;
          c3x = jpx + stack.shift();
          c3y = c2y;
          c4x = c3x + stack.shift();
          c4y = c3y + stack.shift();
          x = c4x + stack.shift();
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
          Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
        }
        if (v == "o1237") {
          c1x = x + stack.shift();
          c1y = y + stack.shift();
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          jpx = c2x + stack.shift();
          jpy = c2y + stack.shift();
          c3x = jpx + stack.shift();
          c3y = jpy + stack.shift();
          c4x = c3x + stack.shift();
          c4y = c3y + stack.shift();
          if (Math.abs(c4x - x) > Math.abs(c4y - y)) {
            x = c4x + stack.shift();
          } else {
            y = c4y + stack.shift();
          }
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
          Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
        }
      } else if (v == "o14") {
        if (stack.length > 0 && !haveWidth) {
          width = stack.shift() + font.nominalWidthX;
          haveWidth = true;
        }
        if (stack.length == 4) {
          var adx = stack.shift();
          var ady = stack.shift();
          var bchar = stack.shift();
          var achar = stack.shift();
          var bind2 = Typr.CFF.glyphBySE(font, bchar);
          var aind = Typr.CFF.glyphBySE(font, achar);
          Typr.U._drawCFF(font.CharStrings[bind2], state, font, pdct, p);
          state.x = adx;
          state.y = ady;
          Typr.U._drawCFF(font.CharStrings[aind], state, font, pdct, p);
        }
        if (open) {
          Typr.U.P.closePath(p);
          open = false;
        }
      } else if (v == "o19" || v == "o20") {
        var hasWidthArg;
        hasWidthArg = stack.length % 2 !== 0;
        if (hasWidthArg && !haveWidth) {
          width = stack.shift() + pdct.nominalWidthX;
        }
        nStems += stack.length >> 1;
        stack.length = 0;
        haveWidth = true;
        i += nStems + 7 >> 3;
      } else if (v == "o21") {
        if (stack.length > 2 && !haveWidth) {
          width = stack.shift() + pdct.nominalWidthX;
          haveWidth = true;
        }
        y += stack.pop();
        x += stack.pop();
        if (open)
          Typr.U.P.closePath(p);
        Typr.U.P.moveTo(p, x, y);
        open = true;
      } else if (v == "o22") {
        if (stack.length > 1 && !haveWidth) {
          width = stack.shift() + pdct.nominalWidthX;
          haveWidth = true;
        }
        x += stack.pop();
        if (open)
          Typr.U.P.closePath(p);
        Typr.U.P.moveTo(p, x, y);
        open = true;
      } else if (v == "o25") {
        while (stack.length > 6) {
          x += stack.shift();
          y += stack.shift();
          Typr.U.P.lineTo(p, x, y);
        }
        c1x = x + stack.shift();
        c1y = y + stack.shift();
        c2x = c1x + stack.shift();
        c2y = c1y + stack.shift();
        x = c2x + stack.shift();
        y = c2y + stack.shift();
        Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
      } else if (v == "o26") {
        if (stack.length % 2) {
          x += stack.shift();
        }
        while (stack.length > 0) {
          c1x = x;
          c1y = y + stack.shift();
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          x = c2x;
          y = c2y + stack.shift();
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
        }
      } else if (v == "o27") {
        if (stack.length % 2) {
          y += stack.shift();
        }
        while (stack.length > 0) {
          c1x = x + stack.shift();
          c1y = y;
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          x = c2x + stack.shift();
          y = c2y;
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
        }
      } else if (v == "o10" || v == "o29") {
        var obj = v == "o10" ? pdct : font;
        if (stack.length == 0) {
          console.warn("error: empty stack");
        } else {
          var ind = stack.pop();
          var subr = obj.Subrs[ind + obj.Bias];
          state.x = x;
          state.y = y;
          state.nStems = nStems;
          state.haveWidth = haveWidth;
          state.width = width;
          state.open = open;
          Typr.U._drawCFF(subr, state, font, pdct, p);
          x = state.x;
          y = state.y;
          nStems = state.nStems;
          haveWidth = state.haveWidth;
          width = state.width;
          open = state.open;
        }
      } else if (v == "o30" || v == "o31") {
        var count, count1 = stack.length;
        var index = 0;
        var alternate = v == "o31";
        count = count1 & ~2;
        index += count1 - count;
        while (index < count) {
          if (alternate) {
            c1x = x + stack.shift();
            c1y = y;
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            y = c2y + stack.shift();
            if (count - index == 5) {
              x = c2x + stack.shift();
              index++;
            } else {
              x = c2x;
            }
            alternate = false;
          } else {
            c1x = x;
            c1y = y + stack.shift();
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            x = c2x + stack.shift();
            if (count - index == 5) {
              y = c2y + stack.shift();
              index++;
            } else {
              y = c2y;
            }
            alternate = true;
          }
          Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
          index += 4;
        }
      } else if ((v + "").charAt(0) == "o") {
        console.warn("Unknown operation: " + v, cmds);
        throw v;
      } else
        stack.push(v);
    }
    state.x = x;
    state.y = y;
    state.nStems = nStems;
    state.haveWidth = haveWidth;
    state.width = width;
    state.open = open;
  };
  Typr$1.Typr = Typr;

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
    const urlParams = new URLSearchParams(location.search);
    CONFIG.courseId = CONFIG.courseId || urlParams.get('courseId') || urlParams.get('courseid');
    CONFIG.clazzId = CONFIG.clazzId || urlParams.get('clazzid') || urlParams.get('clazzId');
    CONFIG.cpi = CONFIG.cpi || urlParams.get('cpi');

    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : null;
    };
    CONFIG.courseId = CONFIG.courseId || getVal('courseId') || getVal('curCourseId');
    CONFIG.clazzId = CONFIG.clazzId || getVal('clazzId');
    CONFIG.cpi = CONFIG.cpi || getVal('cpi');
  }

  /** 从页面提取课程名称（用于导出文件夹命名） */
  function getCourseName() {
    // 尝试多种方式获取课程名
    // 1. 页面中 courseName 变量
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const m = s.textContent?.match(/courseName["\s:]+["']([^"']+)["']/);
      if (m) return m[1];
    }
    // 2. 页面标题（可能包含课程名）
    const title = document.title.replace('学生学习页面', '').trim();
    if (title && title.length < 30) return title;
    // 3. 课程目录中第一个章节的 title 属性
    const firstChapter = document.querySelector('.posCatalog_title');
    if (firstChapter) {
      const t = firstChapter.getAttribute('title') || firstChapter.textContent;
      if (t && t.length < 30) return t.trim();
    }
    // 4. 兜底
    return '课程_' + (CONFIG.courseId || 'unknown');
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

      // 🔓 解码 cxSecret 字体混淆
      // cxSecret 解码改为异步 (在 fetchQuizHtml 后的流程中处理)

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
          text: text, // cxSecret 解码在外部统一处理
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
  //  生成完整功能 HTML（练习 + 错题本 + 导入去重）
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
    const questionsJson = JSON.stringify(allQuestions).replace(/<\//g, '<\\/');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>章节测验 · 练习 + 错题本</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f5f6fa;--card:#fff;--text:#2d3436;--text2:#636e72;--primary:#6c5ce7;--primary-l:#a29bfe;--suc:#00b894;--dng:#d63031;--warn:#fdcb6e;--bdr:#dfe6e9;--sh:0 2px 12px rgba(0,0,0,.08);--r:12px;--t:.2s}
body.dark{--bg:#1a1a2e;--card:#16213e;--text:#eee;--text2:#a4b0be;--bdr:#2d3436;--sh:0 2px 12px rgba(0,0,0,.3)}
body{font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6;transition:background var(--t),color var(--t)}
.tab-bar{display:flex;background:var(--card);border-bottom:2px solid var(--bdr);position:sticky;top:0;z-index:100;box-shadow:var(--sh)}
.tab-btn{flex:1;padding:14px;text-align:center;font-size:15px;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--text2);transition:all var(--t);position:relative}
.tab-btn:hover{color:var(--primary)}
.tab-btn.active{color:var(--primary)}
.tab-btn.active::after{content:'';position:absolute;bottom:-2px;left:10%;width:80%;height:3px;background:var(--primary);border-radius:3px}
.tab-content{display:none}
.tab-content.active{display:block}
.topbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--bdr)}
.topbar .title{font-size:18px;font-weight:700;color:var(--primary)}
.topbar .stats{font-size:13px;color:var(--text2)}
.topbar .controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.topbar button,.topbar select{padding:6px 14px;border:1px solid var(--bdr);border-radius:8px;background:var(--card);color:var(--text);cursor:pointer;font-size:13px;transition:all var(--t)}
.topbar button:hover{border-color:var(--primary);color:var(--primary)}
.topbar button.active{background:var(--primary);color:#fff;border-color:var(--primary)}
.topbar select{min-width:130px}
.progress-bar{width:100%;height:4px;background:var(--bdr);border-radius:2px;overflow:hidden}
.progress-bar .fill{height:100%;background:var(--primary);transition:width .3s}
.main{padding:24px 20px 80px;max-width:860px;margin:0 auto}
.q-card{background:var(--card);border-radius:var(--r);padding:28px 30px;box-shadow:var(--sh);margin-bottom:20px;transition:all var(--t)}
.q-card.correct{border-left:4px solid var(--suc)}
.q-card.wrong{border-left:4px solid var(--dng)}
.q-hdr{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.q-bdg{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.q-bdg.sg{background:#e8f5e9;color:#2e7d32}
.q-bdg.mu{background:#fff3e0;color:#e65100}
.q-bdg.jd{background:#e3f2fd;color:#1565c0}
.q-bdg.sh{background:#fce4ec;color:#c62828}
.q-bdg.fl{background:#f3e5f5;color:#6a1b9a}
.q-meta{font-size:12px;color:var(--text2)}
.q-text{font-size:16px;line-height:1.8;margin-bottom:20px;white-space:pre-wrap;word-break:break-word}
.opts{display:flex;flex-direction:column;gap:10px}
.opt{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border:2px solid var(--bdr);border-radius:10px;cursor:pointer;transition:all var(--t);font-size:15px;line-height:1.5}
.opt:hover{border-color:var(--primary-l);background:rgba(108,92,231,.04)}
.opt.sel{border-color:var(--primary);background:rgba(108,92,231,.08)}
.opt.ca{border-color:var(--suc)!important;background:rgba(0,184,148,.08)!important}
.opt.wa{border-color:var(--dng)!important;background:rgba(214,48,49,.08)!important}
.opt .ol{font-weight:700;font-size:14px;min-width:24px;color:var(--primary)}
.opt .ot{flex:1}
.ans-sec{margin-top:20px;display:none}
.ans-sec.show{display:block}
.ans-box{padding:16px 20px;border-radius:10px;background:rgba(0,184,148,.06);border:1px solid var(--suc)}
.ans-box .al{font-weight:700;color:var(--suc);margin-bottom:6px}
.ans-box .at{font-size:15px;white-space:pre-wrap;word-break:break-word;color:var(--text)}
.act-bar{display:flex;justify-content:center;align-items:center;gap:16px;margin-top:20px;flex-wrap:wrap}
.act-bar button{padding:10px 28px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;border:none;transition:all var(--t);display:flex;align-items:center;gap:6px}
.btn-p{background:var(--primary);color:#fff}
.btn-p:hover{opacity:.85;transform:translateY(-1px)}
.btn-o{background:transparent;border:2px solid var(--primary)!important;color:var(--primary)}
.btn-o:hover{background:var(--primary);color:#fff}
.btn-s{background:var(--suc);color:#fff}
.btn-d{background:transparent;border:2px solid var(--dng)!important;color:var(--dng)}
.key-h{font-size:11px;opacity:.6;margin-left:4px}
.wrong-list{padding:20px;max-width:860px;margin:0 auto}
.wrong-item{background:var(--card);border-radius:var(--r);padding:20px 24px;box-shadow:var(--sh);margin-bottom:16px;border-left:4px solid var(--dng);cursor:pointer;transition:all var(--t)}
.wrong-item:hover{transform:translateX(4px)}
.wrong-item .wi-q{font-size:15px;font-weight:600;margin-bottom:6px;color:var(--text)}
.wrong-item .wi-meta{font-size:12px;color:var(--text2)}
.wrong-item .wi-ans{margin-top:8px;font-size:13px;color:var(--suc)}
.wrong-empty{text-align:center;padding:60px 20px;color:var(--text2);font-size:16px}
.import-zone{max-width:600px;margin:30px auto;padding:20px}
.import-drop{border:3px dashed var(--bdr);border-radius:var(--r);padding:60px 30px;text-align:center;transition:all var(--t);cursor:pointer}
.import-drop:hover,.import-drop.dragover{border-color:var(--primary);background:rgba(108,92,231,.04)}
.import-drop .ic{font-size:48px;margin-bottom:16px}
.import-drop .it{font-size:16px;color:var(--text2);margin-bottom:8px}
.import-drop .is{font-size:13px;color:var(--text2);opacity:.7}
.import-result{margin-top:20px;padding:16px 20px;border-radius:var(--r);display:none}
.import-result.show{display:block}
.import-result.ok{background:rgba(0,184,148,.08);border:1px solid var(--suc);color:var(--suc)}
.import-result.err{background:rgba(214,48,49,.08);border:1px solid var(--dng);color:var(--dng)}
.import-result .ir-count{font-size:24px;font-weight:700;margin-bottom:4px}
.import-result .ir-detail{font-size:14px;opacity:.9}
.import-stats{margin-top:16px;padding:16px 20px;background:var(--card);border-radius:var(--r);box-shadow:var(--sh);display:flex;justify-content:space-around;flex-wrap:wrap;gap:12px}
.import-stats .is-item{text-align:center}
.import-stats .is-num{font-size:28px;font-weight:700;color:var(--primary)}
.import-stats .is-label{font-size:13px;color:var(--text2);margin-top:4px}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999;padding:10px 24px;border-radius:20px;font-size:14px;color:#fff;background:#2d3436;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
@media(max-width:600px){.main{padding:16px 10px 60px}.q-card{padding:20px 16px}.topbar{padding:10px 12px}.topbar .title{font-size:15px}}
</style>
</head>
<body>

<div class="tab-bar" id="tabBar">
  <button class="tab-btn active" data-tab="practice">📝 练习模式</button>
  <button class="tab-btn" data-tab="wrong">❌ 错题本</button>
  <button class="tab-btn" data-tab="import">📥 导入题目</button>
</div>

<div class="tab-content active" id="tabPractice">
  <div class="topbar">
    <span class="title">📝 练习</span>
    <span class="stats" id="stats">加载中...</span>
    <div class="controls">
      <select id="chapterFilter"><option value="all">📂 全部章节</option></select>
      <select id="typeFilter"><option value="all">📋 全部题型</option>
        <option value="\u5355\u9009\u9898">单选题</option><option value="\u591a\u9009\u9898">多选题</option>
        <option value="\u5224\u65ad\u9898">判断题</option><option value="\u7b80\u7b54\u9898">简答题</option>
        <option value="\u586b\u7a7a\u9898">填空题</option>
      </select>
      <button id="btnRandom" title="随机打乱">🔀 随机</button>
      <button id="btnReset" title="重置进度">🔄 重置</button>
      <button id="btnDark" title="夜间模式">🌓</button>
    </div>
  </div>
  <div class="progress-bar"><div class="fill" id="progressFill" style="width:0%"></div></div>
  <div class="main" id="main"></div>
</div>

<div class="tab-content" id="tabWrong">
  <div class="topbar">
    <span class="title">❌ 错题本</span>
    <span class="stats" id="wrongStats">加载中...</span>
    <div class="controls">
      <button id="btnPracticeWrong" style="padding:6px 14px;font-size:13px;border:none;border-radius:8px;background:var(--primary);color:#fff;cursor:pointer">📝 练习错题</button>
      <button id="btnClearWrong" style="padding:6px 14px;font-size:13px;border:2px solid var(--dng);border-radius:8px;background:transparent;color:var(--dng);cursor:pointer">🗑 清空错题</button>
      <button id="btnWrongBack" style="display:none;padding:6px 14px;font-size:13px;cursor:pointer;border:1px solid var(--bdr);border-radius:8px;background:var(--card);color:var(--text)">← 返回</button>
    </div>
  </div>
  <div class="main" id="wrongMain" style="padding-top:16px"></div>
</div>

<div class="tab-content" id="tabImport">
  <div class="import-zone">
    <div class="import-stats" id="importStats">
      <div class="is-item"><div class="is-num" id="isTotal">0</div><div class="is-label">总题目</div></div>
      <div class="is-item"><div class="is-num" id="isWrong">0</div><div class="is-label">错题数</div></div>
      <div class="is-item"><div class="is-num" id="isCorrect">0</div><div class="is-label">答对数</div></div>
      <div class="is-item"><div class="is-num" id="isChapters">0</div><div class="is-label">章节数</div></div>
    </div>
    <div class="import-drop" id="importDrop">
      <div class="ic">📥</div>
      <div class="it">拖放 JSON 文件到此处，或点击选择</div>
      <div class="is">支持 chaoxing-quiz-export 导出的 JSON 格式</div>
    </div>
    <input type="file" id="importFileInput" accept=".json" style="display:none">
    <div class="import-result" id="importResult">
      <div class="ir-count" id="irCount"></div>
      <div class="ir-detail" id="irDetail"></div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  var QUIZ_DATA = ${quizDataJson};
  var EMBEDDED_QUESTIONS = ${questionsJson};

  var ALL_QUESTIONS = EMBEDDED_QUESTIONS.slice();
  var currentIndex = 0;
  var filteredQuestions = ALL_QUESTIONS.slice();
  var correctCount = parseInt(localStorage.getItem('cx_practice_correct') || '0');
  var totalCount = parseInt(localStorage.getItem('cx_practice_total') || '0');
  var answeredMap = JSON.parse(localStorage.getItem('cx_practice_answered') || '{}');
  var wrongMap = JSON.parse(localStorage.getItem('cx_wrong_map') || '{}');
  var wrongPracticeMode = false;
  var wrongPracticeQuestions = [];
  var wrongSelected = null, wrongJudged = false;
  var selectedOption = null, judged = false;

  function $(id){return document.getElementById(id)}
  var $main=$('main'),$stats=$('stats'),$progress=$('progressFill');
  var $cf=$('chapterFilter'),$tf=$('typeFilter'),$br=$('btnRandom'),$brs=$('btnReset'),$bd=$('btnDark'),$tt=$('toast');
  var $wm=$('wrongMain'),$ws=$('wrongStats'),$bpw=$('btnPracticeWrong'),$bcw=$('btnClearWrong'),$bwb=$('btnWrongBack');
  var $id=$('importDrop'),$ifi=$('importFileInput'),$ir=$('importResult'),$irc=$('irCount'),$ird=$('irDetail');
  var $ist=$('isTotal'),$isw=$('isWrong'),$isc=$('isCorrect'),$isch=$('isChapters');

  document.querySelectorAll('.tab-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active')});
      document.querySelectorAll('.tab-content').forEach(function(c){c.classList.remove('active')});
      this.classList.add('active');
      $(this.dataset.tab==='practice'?'tabPractice':this.dataset.tab==='wrong'?'tabWrong':'tabImport').classList.add('active');
      if(this.dataset.tab==='practice'){wrongPracticeMode=false;applyFilters();render()}
      if(this.dataset.tab==='wrong')renderWrongList();
      if(this.dataset.tab==='import')updateImportStats();
    });
  });

  function init(){
    var chapters=[],chSet={};
    ALL_QUESTIONS.forEach(function(q){var ch=q.chapterTitle||q.quizTitle;if(ch&&!chSet[ch]){chSet[ch]=true;chapters.push(ch)}});
    chapters.forEach(function(ch){if(ch){var o=document.createElement('option');o.value=ch;o.textContent=ch;$cf.appendChild(o)}});
    if(localStorage.getItem('cx_practice_dark')==='1')document.body.classList.add('dark');
    var si=parseInt(localStorage.getItem('cx_practice_index')||'0');
    if(si>0&&si<ALL_QUESTIONS.length)currentIndex=si;
    applyFilters();render();updateImportStats();
  }

  function applyFilters(){
    var cv=$cf.value,tv=$tf.value;
    filteredQuestions=ALL_QUESTIONS.filter(function(q){
      if(cv!=='all'&&q.chapterTitle!==cv&&q.quizTitle!==cv)return false;
      if(tv!=='all'&&!q.type.includes(tv))return false;
      return true;
    });
    if(filteredQuestions.length===0)filteredQuestions=ALL_QUESTIONS.slice();
    if(currentIndex>=filteredQuestions.length)currentIndex=0;
  }

  function render(){
    if(filteredQuestions.length===0){$main.innerHTML='<div class="q-card" style="text-align:center;padding:60px"><p style="font-size:18px;color:var(--text2)">🎉 没有匹配的题目</p></div>';return}
    var q=filteredQuestions[currentIndex];if(!q)return;selectedOption=null;judged=false;
    $progress.style.width=((currentIndex+1)/filteredQuestions.length*100)+'%';updateStats();
    var bc='sh';if(q.type.includes('\u5355\u9009'))bc='sg';else if(q.type.includes('\u591a\u9009'))bc='mu';else if(q.type.includes('\u5224\u65ad'))bc='jd';else if(q.type.includes('\u586b\u7a7a'))bc='fl';
    var hOpt=q.options&&q.options.length>0;
    var h='<div class="q-card" id="qcard"><div class="q-hdr"><span class="q-bdg '+bc+'">'+esc(q.type)+'</span><span class="q-meta">#'+(currentIndex+1)+'/'+filteredQuestions.length+' · '+esc(q.chapterTitle||q.quizTitle2||'')+'</span>'+(wrongMap[q.id]?'<span class="q-bdg" style="background:#ffeaa7;color:#d63031;font-size:11px">❌ 错题</span>':'')+'</div><div class="q-text">'+esc(q.question)+'</div>';
    if(hOpt){h+='<div class="opts" id="opts">';q.options.forEach(function(opt,i){h+='<div class="opt" data-idx="'+i+'" onclick="__selOpt('+i+')"><span class="ol">'+esc(opt.label)+'</span><span class="ot">'+esc(opt.text)+'</span></div>'});h+='</div>'}
    h+='<div class="ans-sec" id="ansSec"><div class="ans-box"><div class="al">💡 答案</div><div class="at">'+esc(q.answerText||q.answer||'(无答案)')+'</div></div></div>';
    h+='<div class="act-bar"><button class="btn-o" onclick="__prevQ()">◀ 上一题<span class="key-h">←</span></button><button class="btn-p" id="btnRev" onclick="__revAns()">👁 显示答案<span class="key-h">Space</span></button><button class="btn-o" onclick="__nextQ()">下一题 ▶<span class="key-h">→</span></button></div></div>';
    $main.innerHTML=h;localStorage.setItem('cx_practice_index',currentIndex);
  }

  function updateStats(){var wc=0;for(var k in wrongMap)wc++;$stats.textContent=(currentIndex+1)+'/'+filteredQuestions.length+' | ✅'+correctCount+' | 📊'+totalCount+' | ❌'+wc}

  window.__selOpt=__selOpt;window.__revAns=__revAns;window.__prevQ=__prevQ;window.__nextQ=__nextQ;
  function __selOpt(idx){if(wrongJudged||judged)return;var q=filteredQuestions[currentIndex];if(!q||!q.options)return;selectedOption=idx;document.querySelectorAll('.opt').forEach(function(el,i){el.classList.toggle('sel',i===idx)})}
  function __revAns(){var q=filteredQuestions[currentIndex];if(!q)return;judged=true;var sec=$('ansSec');if(sec)sec.classList.add('show');var btn=$('btnRev');if(btn){btn.textContent='✅ 已显示';btn.className='btn-s'}
    if(q.options&&q.options.length>0&&selectedOption!==null){document.querySelectorAll('.opt').forEach(function(el,i){var lbl=q.options[i].label;if(q.answer&&q.answer.includes(lbl))el.classList.add('ca');else if(i===selectedOption&&!(q.answer&&q.answer.includes(lbl)))el.classList.add('wa')})
      var selLabel=q.options[selectedOption]?q.options[selectedOption].label:'';var isCorrect=q.answer&&q.answer.includes(selLabel);
      if(!answeredMap[q.id]){answeredMap[q.id]=true;if(isCorrect)correctCount++;totalCount++;localStorage.setItem('cx_practice_correct',correctCount);localStorage.setItem('cx_practice_total',totalCount);localStorage.setItem('cx_practice_answered',JSON.stringify(answeredMap))}
      if(!isCorrect){addWrongQuestion(q)}else{removeWrongQuestion(q.id)}
      var card=$('qcard');if(card)card.classList.add(isCorrect?'correct':'wrong')
    }else if(!(q.options&&q.options.length>0)){if(!answeredMap[q.id]){answeredMap[q.id]=true;totalCount++;localStorage.setItem('cx_practice_total',totalCount);localStorage.setItem('cx_practice_answered',JSON.stringify(answeredMap))}}
    updateStats()
  }
  function __prevQ(){currentIndex=currentIndex>0?currentIndex-1:filteredQuestions.length-1;render()}
  function __nextQ(){currentIndex=currentIndex<filteredQuestions.length-1?currentIndex+1:0;render()}

  function addWrongQuestion(q){if(!wrongMap[q.id]){wrongMap[q.id]={id:q.id,type:q.type,question:q.question,options:q.options,answer:q.answer,answerText:q.answerText,chapterTitle:q.chapterTitle,quizTitle:q.quizTitle,quizTitle2:q.quizTitle2,count:1,wrongDate:new Date().toISOString()}}else{wrongMap[q.id].count++}saveWrongMap()}
  function removeWrongQuestion(qId){if(wrongMap[qId]){delete wrongMap[qId];saveWrongMap()}}
  function saveWrongMap(){localStorage.setItem('cx_wrong_map',JSON.stringify(wrongMap))}

  function renderWrongList(){
    var wrongArr=[];for(var k in wrongMap)wrongArr.push(wrongMap[k]);
    if(wrongPracticeMode&&wrongPracticeQuestions.length>0){renderWrongPractice();return}
    wrongPracticeMode=false;$bwb.style.display='none';$bpw.style.display=wrongArr.length>0?'':'none';
    $ws.textContent='\u5171 '+wrongArr.length+' \u9053\u9519\u9898';
    if(wrongArr.length===0){$wm.innerHTML='<div class="wrong-empty">🎉 暂无错题</div>';return}
    var h='<div class="wrong-list">';
    wrongArr.forEach(function(wq){var p=wq.question;if(p.length>80)p=p.slice(0,80)+'…';h+='<div class="wrong-item" data-id="'+esc(wq.id)+'"><div class="wi-q">'+esc(p)+'</div><div class="wi-meta">'+esc(wq.type)+' · '+esc(wq.chapterTitle||wq.quizTitle||'')+' · 错 '+wq.count+' 次</div><div class="wi-ans">✅ 答案：'+esc(wq.answerText||wq.answer||'(无答案)')+'</div></div>'});
    h+='</div>';$wm.innerHTML=h;
    document.querySelectorAll('.wrong-item').forEach(function(el){el.addEventListener('click',function(){var qid=this.dataset.id,found=false;for(var i=0;i<ALL_QUESTIONS.length;i++){if(ALL_QUESTIONS[i].id===qid){currentIndex=i;found=true;break}}if(found){applyFilters();document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active')});document.querySelectorAll('.tab-content').forEach(function(c){c.classList.remove('active')});document.querySelector('[data-tab="practice"]').classList.add('active');$('tabPractice').classList.add('active');render();toast('📌 已跳转到错题')}else{toast('⚠️ 该题不在题库中')}})});
  }

  function renderWrongPractice(){
    $bwb.style.display='';$bpw.style.display='none';
    $ws.textContent='错题练习 '+(currentIndex+1)+'/'+wrongPracticeQuestions.length;
    if(wrongPracticeQuestions.length===0){$wm.innerHTML='<div class="wrong-empty">🎉 错题已全部掌握</div>';wrongPracticeMode=false;return}
    var q=wrongPracticeQuestions[currentIndex];if(!q)return;
    var bc='sh';if(q.type.includes('\u5355\u9009'))bc='sg';else if(q.type.includes('\u591a\u9009'))bc='mu';else if(q.type.includes('\u5224\u65ad'))bc='jd';else if(q.type.includes('\u586b\u7a7a'))bc='fl';
    var hOpt=q.options&&q.options.length>0;
    var h='<div class="q-card" id="wqcard"><div class="q-hdr"><span class="q-bdg '+bc+'">'+esc(q.type)+'</span><span class="q-meta">'+(currentIndex+1)+'/'+wrongPracticeQuestions.length+' · 错 '+(q.count||1)+' 次</span></div><div class="q-text">'+esc(q.question)+'</div>';
    if(hOpt){h+='<div class="opts" id="wopts">';q.options.forEach(function(opt,i){h+='<div class="opt" data-idx="'+i+'" onclick="__wSelOpt('+i+')"><span class="ol">'+esc(opt.label)+'</span><span class="ot">'+esc(opt.text)+'</span></div>'});h+='</div>'}
    h+='<div class="ans-sec" id="wAnsSec"><div class="ans-box"><div class="al">💡 答案</div><div class="at">'+esc(q.answerText||q.answer||'(无答案)')+'</div></div></div>';
    h+='<div class="act-bar"><button class="btn-o" onclick="__wPrev()">◀ 上一题</button><button class="btn-p" id="btnWRev" onclick="__wRev()">👁 显示答案</button><button class="btn-o" onclick="__wNext()">下一题 ▶</button></div></div>';
    $wm.innerHTML=h;wrongSelected=null;wrongJudged=false;
  }

  window.__wSelOpt=__wSelOpt;window.__wRev=__wRev;window.__wPrev=__wPrev;window.__wNext=__wNext;
  function __wSelOpt(idx){if(wrongJudged)return;wrongSelected=idx;document.querySelectorAll('.opt').forEach(function(el,i){el.classList.toggle('sel',i===idx)})}
  function __wRev(){var q=wrongPracticeQuestions[currentIndex];if(!q)return;wrongJudged=true;var sec=$('wAnsSec');if(sec)sec.classList.add('show');var btn=$('btnWRev');if(btn){btn.textContent='✅ 已显示';btn.className='btn-s'}
    if(q.options&&q.options.length>0&&wrongSelected!==null){document.querySelectorAll('.opt').forEach(function(el,i){var lbl=q.options[i].label;if(q.answer&&q.answer.includes(lbl))el.classList.add('ca');else if(i===wrongSelected&&!(q.answer&&q.answer.includes(lbl)))el.classList.add('wa')})
      var selLabel=q.options[wrongSelected]?q.options[wrongSelected].label:'';var isCorrect=q.answer&&q.answer.includes(selLabel);
      var card=$('wqcard');if(card)card.classList.add(isCorrect?'correct':'wrong');
      if(isCorrect){removeWrongQuestion(q.id);toast('✅ 已掌握！已从错题本移除')}else{toast('❌ 继续加油')}
    }updateStats()}
  function __wPrev(){currentIndex=currentIndex>0?currentIndex-1:wrongPracticeQuestions.length-1;renderWrongPractice()}
  function __wNext(){currentIndex=currentIndex<wrongPracticeQuestions.length-1?currentIndex+1:0;renderWrongPractice()}

  $bpw.addEventListener('click',function(){var wa=[];for(var k in wrongMap)wa.push(wrongMap[k]);if(wa.length===0){toast('🎉 暂无错题');return}
    wrongPracticeMode=true;wrongPracticeQuestions=[];wa.forEach(function(wq){for(var i=0;i<ALL_QUESTIONS.length;i++){if(ALL_QUESTIONS[i].id===wq.id){wrongPracticeQuestions.push(Object.assign({},ALL_QUESTIONS[i],{count:wq.count}));break}}})
    if(wrongPracticeQuestions.length===0){toast('⚠️ 错题数据不完整');return}
    currentIndex=0;renderWrongPractice()
  });
  $bwb.addEventListener('click',function(){wrongPracticeMode=false;currentIndex=0;renderWrongList()});
  $bcw.addEventListener('click',function(){if(confirm('\u786e\u5b9a\u6e05\u7a7a\u6240\u6709\u9519\u9898\u8bb0\u5f55\u5417\uff1f')){wrongMap={};localStorage.removeItem('cx_wrong_map');renderWrongList();updateStats();updateImportStats();toast('🗑 清空错题本')}});

  function updateImportStats(){
    var chs={};ALL_QUESTIONS.forEach(function(q){var ch=q.chapterTitle||q.quizTitle;if(ch)chs[ch]=true});
    var wc=0;for(var k in wrongMap)wc++;
    $ist.textContent=ALL_QUESTIONS.length;$isw.textContent=wc;$isc.textContent=correctCount;$isch.textContent=Object.keys(chs).length;
  }

  $id.addEventListener('click',function(){$ifi.click()});
  $id.addEventListener('dragover',function(e){e.preventDefault();this.classList.add('dragover')});
  $id.addEventListener('dragleave',function(){this.classList.remove('dragover')});
  $id.addEventListener('drop',function(e){e.preventDefault();this.classList.remove('dragover');if(e.dataTransfer.files.length>0)processFile(e.dataTransfer.files[0])});
  $ifi.addEventListener('change',function(){if(this.files.length>0)processFile(this.files[0]);this.value=''});

  function processFile(file){
    if(!file.name.endsWith('.json')){showResult(false,'仅支持 JSON 文件');return}
    var reader=new FileReader();
    reader.onload=function(e){try{var data=JSON.parse(e.target.result);var imported=extractQ(data);if(imported.length===0){showResult(false,'未解析出题目');return};var r=dedup(imported);showResult(true,r)}catch(err){showResult(false,'JSON解析失败: '+err.message)}};
    reader.readAsText(file,'UTF-8');
  }

  function extractQ(data){
    var qs=[];
    if(data.quizzes&&Array.isArray(data.quizzes)){data.quizzes.forEach(function(qz){if(qz.questions&&Array.isArray(qz.questions)){qz.questions.forEach(function(q){qs.push(Object.assign({},q,{chapterTitle:qz.chapterTitle||qz.quizTitle||q.chapterTitle,quizTitle:qz.quizTitle||'',quizTitle2:qz.quizTitle||''}))})}})}
    else if(Array.isArray(data)){data.forEach(function(q){qs.push(Object.assign({},q,{chapterTitle:q.chapterTitle||q.quizTitle||'',quizTitle:q.quizTitle||'',quizTitle2:q.quizTitle||''}))})}
    else if(data.questions&&Array.isArray(data.questions)){data.questions.forEach(function(q){qs.push(Object.assign({},q,{chapterTitle:q.chapterTitle||data.title||'',quizTitle:q.quizTitle||'',quizTitle2:q.quizTitle||''}))})}
    qs.forEach(function(q,i){if(!q.id)q.id='imp_'+i+'_'+hash(q.question+(q.answer||''))});
    return qs;
  }

  function hash(s){var h=0;for(var i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0}return Math.abs(h).toString(36)}

  function dedup(imported){
    var existIds={},existTexts={},newC=0,dupC=0;
    ALL_QUESTIONS.forEach(function(q){existIds[q.id]=true;existTexts[q.question.trim()+'|'+(q.answer||'')]=true});
    imported.forEach(function(q){if(existIds[q.id]||existTexts[q.question.trim()+'|'+(q.answer||'')]){dupC++}else{q.globalIndex=ALL_QUESTIONS.length;ALL_QUESTIONS.push(q);existIds[q.id]=true;existTexts[q.question.trim()+'|'+(q.answer||'')]=true;newC++}});
    var chapters=[],chSet={};ALL_QUESTIONS.forEach(function(q){var ch=q.chapterTitle||q.quizTitle;if(ch&&!chSet[ch]){chSet[ch]=true;chapters.push(ch)}});
    $cf.innerHTML='<option value="all">📂 全部章节</option>';
    chapters.forEach(function(ch){if(ch){var o=document.createElement('option');o.value=ch;o.textContent=ch;$cf.appendChild(o)}});
    applyFilters();updateImportStats();
    return{newCount:newC,dupCount:dupC,total:ALL_QUESTIONS.length};
  }

  function showResult(ok,r){
    $ir.className='import-result show '+(ok?'ok':'err');
    if(ok){$irc.textContent='✅ 导入完成';$ird.textContent='新增 '+r.newCount+' 题，去重 '+r.dupCount+' 题，共 '+r.total+' 题';toast('📥 导入 '+r.newCount+' 题');currentIndex=0;setTimeout(function(){document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active')});document.querySelectorAll('.tab-content').forEach(function(c){c.classList.remove('active')});document.querySelector('[data-tab="practice"]').classList.add('active');$('tabPractice').classList.add('active');render()},1200)}
    else{$irc.textContent='❌ 导入失败';$ird.textContent=r}
  }

  $cf.addEventListener('change',function(){currentIndex=0;applyFilters();render()});
  $tf.addEventListener('change',function(){currentIndex=0;applyFilters();render()});
  $br.addEventListener('click',function(){$br.classList.toggle('active');if($br.classList.contains('active')){for(var i=filteredQuestions.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=filteredQuestions[i];filteredQuestions[i]=filteredQuestions[j];filteredQuestions[j]=t}currentIndex=0;toast('🔀 已随机打乱')}else{applyFilters();currentIndex=0;toast('↩ 已恢复顺序')}render()});
  $brs.addEventListener('click',function(){if(confirm('\u786e\u5b9a\u91cd\u7f6e\u6240\u6709\u7ec3\u4e60\u8fdb\u5ea6\u5417\uff1f')){correctCount=0;totalCount=0;currentIndex=0;localStorage.removeItem('cx_practice_correct');localStorage.removeItem('cx_practice_total');localStorage.removeItem('cx_practice_answered');localStorage.removeItem('cx_practice_index');for(var k in answeredMap)delete answeredMap[k];toast('🔄 已重置');render()}});
  $bd.addEventListener('click',function(){document.body.classList.toggle('dark');localStorage.setItem('cx_practice_dark',document.body.classList.contains('dark')?'1':'0')});

  document.addEventListener('keydown',function(e){if(e.target.tagName==='SELECT'||e.target.tagName==='INPUT')return;if(!$('tabPractice').classList.contains('active'))return;switch(e.key){case'ArrowLeft':e.preventDefault();__prevQ();break;case'ArrowRight':e.preventDefault();__nextQ();break;case' ':e.preventDefault();__revAns();break;case'1':case'2':case'3':case'4':case'5':case'6':var idx=parseInt(e.key)-1;if(filteredQuestions[currentIndex]&&filteredQuestions[currentIndex].options&&idx<filteredQuestions[currentIndex].options.length)__selOpt(idx);break}});

  function esc(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  function toast(msg){$tt.textContent=msg;$tt.classList.add('show');clearTimeout($tt._t);$tt._t=setTimeout(function(){$tt.classList.remove('show')},2000)}

  init();
})();
</script>
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
        <button class="cx-btn primary" id="cxExportAll">📦 一键导出 (JSON+HTML 错题本+导入)</button>
        <button class="cx-btn secondary" id="cxDownloadPractice">📝 重新下载练习HTML</button>
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

    let lastExportData = null;
    let lastFolderName = null;

    // 导出所有（JSON + HTML 一起下载到同名文件夹）
    document.getElementById('cxExportAll').addEventListener('click', async () => {
      const btn = document.getElementById('cxExportAll');
      btn.disabled = true;
      btn.textContent = '⏳ 正在抓取...';
      lastExportData = await exportAllQuizzes();
      btn.disabled = false;
      btn.textContent = '🚀 导出所有章节测验';

      if (lastExportData) {
        const courseName = getCourseName();
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const safeName = courseName.replace(/[\/\\:*?"<>|]/g, '_');
        lastFolderName = safeName + '_' + dateStr;

        // 下载合并 JSON（文件名前缀统一，在下载目录中自然归组）
        const prefix = lastFolderName + '_';
        const totalJson = JSON.stringify(lastExportData, null, 2);
        const jsonBlob = new Blob([totalJson], { type: 'application/json' });
        const jsonUrl = URL.createObjectURL(jsonBlob);
        GM_download({ url: jsonUrl, name: prefix + '章节测验_全部题目.json', saveAs: false });
        setTimeout(() => URL.revokeObjectURL(jsonUrl), 1000);
        log('📄 已保存: ' + prefix + '章节测验_全部题目.json');

        // 下载练习 HTML
        const html = generatePracticeHTML(lastExportData.quizzes);
        const htmlBlob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const htmlUrl = URL.createObjectURL(htmlBlob);
        GM_download({ url: htmlUrl, name: prefix + '章节测验_循环练习.html', saveAs: false });
        setTimeout(() => URL.revokeObjectURL(htmlUrl), 1000);
        log('📝 已保存: ' + prefix + '章节测验_循环练习.html');
        log('✅ 全部完成！两个文件以 ' + prefix + ' 开头，在下载目录中排在一起');
      }
    });

    // 下载练习HTML（单独按钮，用于重新生成）
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
      a.download = (lastFolderName || '章节测验') + '/章节测验_循环练习.html';
      a.click();
      URL.revokeObjectURL(url);
      log('📝 练习HTML已下载: ' + (lastFolderName || '章节测验') + '_章节测验_循环练习.html');
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
            // 解码 cxSecret 字体混淆
            const decodeTable = await cxDecoder.buildTable(cxDecoder.extractFont(quizHtml));
            if (decodeTable) {
              questions.forEach(q => {
                q.question = decodeCxSecretSync(q.question, decodeTable);
                q.options = q.options.map(o => ({ ...o, text: decodeCxSecretSync(o.text, decodeTable) }));
              });
            }
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
  //  入口
  // ═══════════════════════════════════════════════════════════
  function init() {
    console.log('[CX Export] 脚本初始化，readyState=' + document.readyState);

    function tryCreatePanel() {
      if (document.body) {
        console.log('[CX Export] body 就绪，创建面板...');
        try {
          createPanel();
          console.log('[CX Export] 面板创建成功');
        } catch (e) {
          console.error('[CX Export] 面板创建失败:', e);
        }
      } else {
        console.warn('[CX Export] body 未就绪，100ms 后重试...');
        setTimeout(tryCreatePanel, 100);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(tryCreatePanel, 800));
    } else {
      setTimeout(tryCreatePanel, 800);
    }
  }

  init();
})();
