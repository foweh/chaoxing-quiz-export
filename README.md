# 超星学习通 - 章节测验导出工具

> ⚠️ **免责声明**

## 法律与责任声明

**本项目仅供个人学习和技术研究使用，严禁用于任何商业目的或违反平台服务条款的行为。**

1. **版权声明**：本工具不包含任何超星学习通（Chaoxing）的版权内容。用户通过本工具处理的课程数据，其版权归超星或课程提供方所有。用户应自行确保对导出内容的处理符合相关法律法规和平台服务条款。

2. **侵权免责**：本项目的作者/贡献者不对用户使用本工具所产生的任何行为承担法律责任。用户使用本工具即视为同意：所有因使用本工具导致的版权侵权、账号封禁、法律纠纷等风险，均由用户自行承担。

3. **第三方代码**：本项目部分组件提取自第三方开源脚本（`typr-cxsecret.js` 源自 ABC超星学习通助手），仅用于字体解析的技术实现，非商业利用。如有版权异议请联系删除。

4. **教育目的**：本工具的设计初衷是帮助学生更高效地复习课程内容。请仅导出你自己有权访问的课程数据，并仅用于个人学习，不得传播或售卖。

5. **无担保**：本软件按"原样"提供，不提供任何明示或暗示的担保。作者不对因使用本软件造成的任何损失负责。

---

## 功能

- **油猴脚本** `chaoxing-quiz-export.user.js` — 在超星课程页面一键导出所有章节测验
  - 自动遍历所有章节 → 抓取测验题目
  - 动态解码 cxSecret 字体混淆（内嵌 Typr.js + 远程哈希表）
  - 导出合并 JSON + 独立循环练习 HTML
  - 支持单选/多选/判断/填空/简答

- **Node.js 脚本** `extract_quiz.js` — 离线解析保存的测验 HTML
  - 自动检测并解码 cxSecret 字体
  - 输出结构化 JSON

- **解码器** `cxsecret-decoder.js` — 通用 cxSecret 字体解码
  - 依赖 `typr-cxsecret.js`（Typr 字体引擎）

## 使用

### 油猴脚本（推荐）
1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 `chaoxing-quiz-export.user.js` → 复制全部内容 → Tampermonkey 新建脚本 → 粘贴 → 保存
3. 打开超星课程页面 → 右下角「📦 测验导出」面板 → 点击导出

### Node.js（离线解析）
```bash
node extract_quiz.js 学生学习页面_files/work.html
```

## 文件结构

```
chaoxing-quiz-export.user.js   # 油猴脚本（主力）
extract_quiz.js                # Node.js 离线解析
cxsecret-decoder.js            # cxSecret 字体解码器
typr-cxsecret.js               # Typr TrueType 解析引擎（提取自第三方）
```

## License

MIT — 详见 [LICENSE](LICENSE)
