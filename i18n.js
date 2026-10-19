/* IS6912 language runtime.
 *
 * This file ships as participant/i18n.js and as admin/i18n.js. Everything above the
 * addCatalog call is byte-identical in both copies; only the catalog and its patterns
 * differ, so the two shells switch language in exactly the same way.
 *
 * Rules this runtime owns:
 *  - English is the default; the browser locale is never consulted. A stored choice of
 *    'zh' (key `hll-language`, scoped to the origin) wins, anything else is English;
 *  - the language may be switched at any moment, including during timed execution.
 *    A switch only rewrites text nodes and the title/placeholder/aria-label attributes,
 *    so form state, focus, dialog state, timers and trial counters are untouched;
 *  - every text node and attribute remembers the canonical (source) string it was
 *    written from. A node whose content still equals what this runtime rendered is
 *    treated as "not changed by the app"; anything else is treated as a new canonical
 *    source. That is what keeps a 100 ms render tick from recreating nodes forever;
 *  - unknown strings are never invented: they stay as the app wrote them and are
 *    reported by HLLI18n.audit();
 *  - input/textarea values, codes, ids, JSON and raw participant answers are marked
 *    data-i18n-ignore / translate="no" and are never transformed. That rule is enforced
 *    on every write path, including the ones where the MutationObserver hands over a
 *    bare text node, a single attribute or a newly added subtree with no tree walk:
 *    an ancestor's marker is inherited, script/style/frame/textarea content is raw by
 *    tag, and formatter output is a rendered raw value rather than copy.
 */
(function (root) {
  'use strict';

  var RUNTIME_ID = 'hll-i18n-2026-10-12-v01';
  var STORAGE_KEY = 'hll-language';
  var LANGUAGES = ['en', 'zh'];
  var DEFAULT_LANGUAGE = 'en';
  var HTML_LANG = { en: 'en', zh: 'zh-Hans' };
  var TEXT_ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
  var IGNORE_ATTRIBUTE = 'data-i18n-ignore';
  // Elements whose child text is never user-facing prose. Rewriting a text node inside
  // one of these would corrupt code, styles, an inert frame or a form's own value.
  var RAW_TEXT_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, NOEMBED: 1, NOFRAMES: 1, XMP: 1, IFRAME: 1, TEXTAREA: 1 };
  var MAX_PASSES = 8;
  var MAX_DEPTH = 4;
  var CJK = /[⺀-〿぀-ヿ一-鿿＀-￯]/;

  var CATALOG = Object.create(null);    // canonical source -> translation
  var REVERSE = Object.create(null);    // translation -> canonical source
  var PATTERNS = [];                    // bounded, anchored dynamic templates

  var textState = new WeakMap();        // Text node -> {canonical, rendered}
  var attributeState = new WeakMap();    // element -> {name -> {canonical, rendered}}
  var formatState = new WeakMap();       // element -> {value, format}
  var formatters = Object.create(null);
  var writing = 0;
  var observer = null;
  var started = false;
  var storageAvailable = true;
  var initialLanguage = DEFAULT_LANGUAGE;
  var language = DEFAULT_LANGUAGE;

  /* ------------------------------------------------------------- language */

  function isLanguage(value) { return LANGUAGES.indexOf(value) >= 0; }

  function readStored() {
    try {
      var value = root.localStorage.getItem(STORAGE_KEY);
      return isLanguage(value) ? value : null;
    } catch (error) { storageAvailable = false; return null; }
  }

  function persist() {
    try { root.localStorage.setItem(STORAGE_KEY, language); }
    catch (error) { storageAvailable = false; }   // a lost preference must never block the page
  }

  function getLanguage() { return language; }
  function getInitialLanguage() { return initialLanguage; }

  // The page title is part of the chrome, so it switches with everything else.
  var titleCanonical = null;
  function applyTitle() {
    if (!root.document) return;
    var title = root.document.title;
    if (titleCanonical === null) titleCanonical = canonicalOf(title);
    var output = translate(titleCanonical);
    if (output !== title) { writing += 1; root.document.title = output; writing -= 1; }
  }

  /**
   * A user-initiated change. The event fires on `document` only when the language
   * really changed; the initial language is available through getInitialLanguage().
   */
  function setLanguage(next) {
    if (!isLanguage(next)) return language;
    if (next === language) return language;
    var from = language;
    language = next;
    persist();
    applyDocumentLanguage();
    translateTree(root.document.body);
    applyTitle();
    emitChange(from, next);
    return language;
  }

  function emitChange(from, to) {
    if (typeof root.CustomEvent !== 'function' || !root.document) return;
    root.document.dispatchEvent(new root.CustomEvent('hll:languagechange', { detail: { from: from, to: to } }));
  }

  function applyDocumentLanguage() {
    if (root.document && root.document.documentElement) root.document.documentElement.lang = HTML_LANG[language];
    var switches = root.document ? root.document.querySelectorAll('[data-lang]') : [];
    for (var index = 0; index < switches.length; index += 1) {
      var active = switches[index].getAttribute('data-lang') === language;
      switches[index].setAttribute('aria-pressed', active ? 'true' : 'false');
      if (active) switches[index].setAttribute('lang', HTML_LANG[language]);
    }
  }

  /* ----------------------------------------------------------- translation */

  function addCatalog(entries) {
    var key;
    for (key in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
      var value = entries[key];
      if (typeof value !== 'string' || value === key) continue;
      if (CATALOG[key] === undefined) CATALOG[key] = value;
    }
    for (key in CATALOG) {
      var translation = CATALOG[key];
      if (CATALOG[translation] !== undefined) continue;   // a shared word, not a translation
      if (REVERSE[translation] === undefined) REVERSE[translation] = key;
    }
  }

  /** Anchored templates for counted/templated copy: {en, zh} return null when they do not apply. */
  function addPatterns(list) {
    for (var index = 0; index < list.length; index += 1) PATTERNS.push(list[index]);
  }

  function translate(value, depth) {
    if (typeof value !== 'string' || value === '') return value;
    return language === 'zh' ? toChinese(value, depth || 0) : toEnglish(value, depth || 0);
  }

  function toEnglish(value, depth) {
    var out = value;
    for (var pass = 0; pass < MAX_PASSES; pass += 1) {
      var direct = CATALOG[out];
      if (direct !== undefined && direct !== out) { out = direct; continue; }
      var next = applyPatterns(out, 'en', depth);
      if (next === null || next === out) break;
      out = next;
    }
    return out;
  }

  function toChinese(value, depth) {
    var out = value;
    for (var pass = 0; pass < MAX_PASSES; pass += 1) {
      var direct = REVERSE[out];
      if (direct !== undefined && direct !== out) { out = direct; continue; }
      var next = applyPatterns(out, 'zh', depth);
      if (next === null || next === out) break;
      out = next;
    }
    return out;
  }

  function applyPatterns(value, direction, depth) {
    var level = depth || 0;
    if (level > MAX_DEPTH) return null;
    var tr = direction === 'zh' ? function (part) { return toChinese(part, level + 1); }
      : function (part) { return toEnglish(part, level + 1); };
    for (var index = 0; index < PATTERNS.length; index += 1) {
      var pattern = PATTERNS[index];
      var match = pattern.en ? pattern.re.exec(value) : null;
      if (!match) continue;
      var en = pattern.en.call(pattern, match, tr, value);
      if (direction === 'en') return en === undefined ? null : en;
      if (en === null || en === undefined) continue;      // not this template after all
      var zh = pattern.zh ? pattern.zh.call(pattern, match, tr, value) : null;
      return zh === undefined ? null : zh;
    }
    return null;
  }

  /* ------------------------------------------------------------ DOM bridge */

  /** The element that owns `node`. A text node inherits every marker of its parent. */
  function ownerElement(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement || null;
  }

  /** Content that is raw by tag: code, styles, inert frames and a form's own value. */
  function isRawTextOwner(element) {
    return !!element && element.nodeType === 1 && RAW_TEXT_TAGS[element.nodeName] === 1;
  }

  /** Explicitly marked raw: translate="no" or data-i18n-ignore, on the node or an ancestor. */
  function isMarkedRaw(node) {
    for (var element = ownerElement(node); element && element.nodeType === 1; element = element.parentElement) {
      if (!element.getAttribute) continue;
      if (element.hasAttribute(IGNORE_ATTRIBUTE) || element.getAttribute('translate') === 'no') return true;
    }
    return false;
  }

  /** Raw for translation purposes: an explicit marker, or a raw-by-tag owner. */
  function isRaw(node) { return isMarkedRaw(node) || isRawTextOwner(ownerElement(node)); }

  /**
   * Content this runtime must never rewrite. Formatter output counts as raw too: it is a
   * rendered value in the current locale, not catalog copy, so the catalog and the
   * anchored patterns must not get a second pass over it.
   */
  function isOpaque(node) {
    var owner = ownerElement(node);
    if (owner !== null && formatState.has(owner)) return true;
    return isRaw(node);
  }

  function canonicalOf(value) { return REVERSE[value] !== undefined ? REVERSE[value] : value; }

  function applyTextNode(node) {
    // Reached directly by the observer, which cannot walk up to a marked ancestor.
    // Raw answers survive untouched and create no canonical state, so a later switch
    // still translates them if the marker is ever removed.
    if (isOpaque(node)) return;
    var raw = node.nodeValue;
    if (typeof raw !== 'string') return;
    var state = textState.get(node);
    if (state === undefined) {
      state = { canonical: canonicalOf(raw), rendered: raw };
      textState.set(node, state);
    } else if (raw !== state.rendered) {
      state.canonical = canonicalOf(raw);
    }
    var output = translate(state.canonical);
    if (output !== raw) { writing += 1; node.nodeValue = output; writing -= 1; }
    state.rendered = output;
  }

  function applyAttribute(element, name) {
    if (TEXT_ATTRIBUTES.indexOf(name) < 0) return;
    // Same raw rule as text nodes, including an inherited marker: a title, placeholder
    // or aria-label inside a marked subtree stays exactly as the app wrote it.
    if (isMarkedRaw(element)) return;
    var states = attributeState.get(element);
    if (states === undefined) { states = Object.create(null); attributeState.set(element, states); }
    var state = states[name];
    var raw = element.getAttribute(name);
    if (state === undefined) {
      if (raw === null) return;
      state = { canonical: canonicalOf(raw), rendered: raw };
      states[name] = state;
    } else if (raw !== state.rendered) {
      state.canonical = raw === null ? null : canonicalOf(raw);
    }
    if (state.canonical === null) return;
    var output = translate(state.canonical);
    if (output !== raw) { writing += 1; element.setAttribute(name, output); writing -= 1; }
    state.rendered = output;
  }

  function applyFormat(element) {
    var state = formatState.get(element);
    if (state === undefined) return;
    var formatter = formatters[state.format];
    if (typeof formatter !== 'function') return;
    var output = String(formatter(state.value));
    if (element.textContent !== output) { writing += 1; element.textContent = output; writing -= 1; }
  }

  /** Localizes text nodes and text attributes only; never rebuilds a form or a panel. */
  function translateTree(node) {
    if (!node) return;
    if (node.nodeType === 3) { applyTextNode(node); return; }   // it applies the raw rule itself
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    writing += 1;
    try {
      if (node.nodeType === 1) {
        if (isRaw(node)) return;                    // marked or raw by tag: skip the whole subtree
        applyFormat(node);
        if (formatState.has(node)) return;          // the formatter owns this element's text
        for (var index = 0; index < TEXT_ATTRIBUTES.length; index += 1) applyAttribute(node, TEXT_ATTRIBUTES[index]);
      }
      var child = node.firstChild;
      while (child) {
        var next = child.nextSibling;
        translateTree(child);
        child = next;
      }
    } finally { writing -= 1; }
  }

  function observe() {
    if (observer || typeof root.MutationObserver !== 'function' || !root.document) return;
    observer = new root.MutationObserver(function (records) {
      if (writing > 0) return;                       // our own writes are already translated
      writing += 1;
      try {
        for (var index = 0; index < records.length; index += 1) {
          var record = records[index];
          // Text nodes and attributes only: comments, CDATA and processing instructions are
          // not copy. applyTextNode/applyAttribute reject raw content themselves, because a
          // record carries no information about the subtree it landed in.
          if (record.type === 'characterData') {
            if (record.target.nodeType === 3) applyTextNode(record.target);
          } else if (record.type === 'attributes') applyAttribute(record.target, record.attributeName);
          else for (var added = 0; added < record.addedNodes.length; added += 1) translateTree(record.addedNodes[added]);
        }
      } finally { writing -= 1; }
    });
    observer.observe(root.document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: TEXT_ATTRIBUTES,
    });
  }

  /* ------------------------------------------------------- render helpers */

  /** Canonical text write: only touches the DOM when the rendered value actually changes. */
  function bindText(node, value) {
    if (!node) return;
    var source = typeof value === 'string' ? value : String(value ?? '');
    // Raw data (answers, JSON, ids, codes) is marked and written through untouched,
    // even when the value happens to equal a known label.
    if (isRaw(node)) { if (node.textContent !== source) { writing += 1; node.textContent = source; writing -= 1; } return; }
    var state = textState.get(node);
    if (state === undefined) { state = { canonical: source, rendered: source }; textState.set(node, state); }
    state.canonical = source;
    var output = translate(source);
    if (node.textContent !== output) { writing += 1; node.textContent = output; writing -= 1; }
    state.rendered = output;
    // bindText may create an English text node before the element is attached. Keep
    // the source on that text node too, so dynamic templates round-trip without an
    // inverse pattern when the observer later sees it or the language changes.
    if (node.firstChild && node.firstChild.nodeType === 3) {
      textState.set(node.firstChild, {canonical: source, rendered: output});
    }
  }

  /** Canonical markup write: the source markup is what the app compares against. */
  function bindHTML(node, markup) {
    if (!node) return;
    writing += 1;
    try { node.innerHTML = markup; } finally { writing -= 1; }
    if (!isRaw(node)) translateTree(node);
  }

  function registerFormatter(name, formatter) { formatters[name] = formatter; }

  /** A span whose content is re-rendered from a raw value with the selected locale. */
  function formatNode(value, name) {
    var span = root.document.createElement('span');
    formatState.set(span, { value: value, format: name });
    applyFormat(span);
    return span;
  }

  function locale() { return HTML_LANG[language]; }

  /* ------------------------------------------------------------ self checks */

  /**
   * Canonical strings the *current* language cannot translate.
   *
   * Only the default English UI is audited: Chinese copy is the source language there,
   * so anything left over is a real catalog gap. In the Chinese UI the audit would
   * flag every source string (it is already correct), so it reports nothing.
   */
  function audit(root_) {
    if (language !== 'en') return [];
    var scope = root_ || (root.document ? root.document.body : null);
    var missing = [];
    var seen = Object.create(null);
    var walk = function (node) {
      if (node.nodeType === 3) {
        if (isOpaque(node)) return;                  // raw answers and rendered values are not gaps
        var state = textState.get(node);
        var canonical = state ? state.canonical : node.nodeValue;
        if (typeof canonical === 'string' && canonical && CJK.test(canonical) && translate(canonical) === canonical) {
          if (!seen[canonical]) { seen[canonical] = true; missing.push({ kind: 'text', value: canonical }); }
        }
        return;
      }
      if (node.nodeType !== 1 || isRaw(node)) return;
      for (var index = 0; index < TEXT_ATTRIBUTES.length; index += 1) {
        var name = TEXT_ATTRIBUTES[index];
        var value = node.getAttribute(name);
        if (value && CJK.test(value) && translate(value) === value && !seen[value]) { seen[value] = true; missing.push({ kind: name, value: value }); }
      }
      var child = node.firstChild;
      while (child) { var next = child.nextSibling; walk(child); child = next; }
    };
    if (scope) walk(scope);
    return missing;
  }

  /* ------------------------------------------------------------- switches */

  function onSwitchClick(event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-lang]') : null;
    if (!target) return;
    event.preventDefault();
    setLanguage(target.getAttribute('data-lang'));
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function start() {
    if (started) return;
    started = true;
    var stored = readStored();
    language = stored || DEFAULT_LANGUAGE;
    initialLanguage = language;
    applyDocumentLanguage();
    root.document.addEventListener('click', onSwitchClick);
    translateTree(root.document.body);
    applyTitle();
    observe();
  }

  root.HLLI18n = {
    RUNTIME_ID: RUNTIME_ID,
    STORAGE_KEY: STORAGE_KEY,
    languages: LANGUAGES.slice(),
    addCatalog: addCatalog,
    addPatterns: addPatterns,
    registerFormatter: registerFormatter,
    getLanguage: getLanguage,
    getInitialLanguage: getInitialLanguage,
    setLanguage: setLanguage,
    t: translate,
    translateTree: translateTree,
    bindText: bindText,
    bindHTML: bindHTML,
    formatNode: formatNode,
    locale: locale,
    audit: audit,
    storageAvailable: function () { return storageAvailable; },
    catalogSize: function () { return Object.keys(CATALOG).length; },
    start: start,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------------------------------------------------------------- catalog */

HLLI18n.addCatalog({
  '候选资料 · 场地均可用于 14–16 时': 'Options · both venues are available from 14:00 to 16:00',
  '保存后仍需继续执行': 'Resume the run after saving',
  '应用后仍需继续执行': 'Resume the run after applying',
  '发布报名表': 'Publish the registration form',
  '确认已读 →': 'Confirm I have read the plan →',
  /* ---- application chrome ---- */
  'IS6912 · 工作坊监督任务': 'IS6912 · Workshop supervision task',
  '工作坊筹备': 'Workshop preparation',
  '模拟任务 · ': 'Simulated task · ',
  '参与流程': 'Study steps',
  '界面语言': 'Interface language',
  '说明与练习': 'Briefing and practice',
  '准备计划': 'Plan preparation',
  '监督执行': 'Supervised execution',
  '任务后回答': 'Post-task questions',

  /* ---- phase labels ---- */
  '准备': 'Setup',
  '参与入口': 'Study entry',
  '活动背景': 'Scenario background',
  '监督说明': 'Supervision brief',
  '操作练习': 'Practice',
  '初始计划': 'Initial plan',
  '计划确认': 'Plan confirmation',
  '访谈记录': 'Interview notes',
  '提交回答': 'Submitting answers',
  '已完成': 'Completed',

  /* ---- editor and direction dialogs ---- */
  '当前操作已暂停': 'The current action is paused',
  '修改待执行动作': 'Edit the pending action',
  '关闭': 'Close',
  '关闭修改窗口': 'Close the edit window',
  '只修改你认为需要调整的内容。保存后仍保持暂停，确认预览后再继续。':
    'Change only what you think needs changing. Saving keeps the run paused; check the preview before you continue.',
  '场地': 'Venue',
  '茶点': 'Catering',
  '报名字段': 'Registration fields',
  '姓名': 'Name',
  '邮箱': 'Email',
  '饮食偏好': 'Dietary preference',
  '尚未开始的资源步骤': 'Resource steps that have not started yet',
  '场地 → 茶点': 'Venue → Catering',
  '茶点 → 场地': 'Catering → Venue',
  '已执行的资源步骤无法在这里倒改。关闭窗口不会恢复运行。':
    'Resource steps that already ran cannot be reordered here. Closing the window does not resume the run.',
  '保存修改，返回预览': 'Save changes, back to the preview',
  '调整后续处理方式': 'Change how the rest is handled',
  '选择一个处理方式。应用后仍保持暂停，确认预览后再继续。':
    'Choose how the rest should be handled. Applying it keeps the run paused; check the preview before you continue.',
  '处理方式': 'How it is handled',
  '使用任务要求中的报名字段模板': 'Use the registration field template from the task brief',
  '先处理场地': 'Handle the venue first',
  '先处理茶点': 'Handle the catering first',
  '应用，返回预览': 'Apply, back to the preview',

  /* ---- task reference panel ---- */
  '任务要求': 'Task brief',
  '始终可查': 'Always available',
  '参与人数': 'Participants',
  '20 人': '20 people',
  '活动时间': 'Duration',
  '14–16 时': '14:00–16:00',
  '预算上限': 'Budget cap',
  '至少容纳 20 人，有投影仪。': 'Must hold 20 people and have a projector.',
  '预算': 'Budget',
  '场地与茶点合计 ≤ HK$5,000。': 'Venue and catering together ≤ HK$5,000.',
  '姓名、邮箱、饮食偏好；不得收集 HKID／身份证号码。':
    'Name, email and dietary preference; HKID / identity numbers must not be collected.',
  '邀请邮件': 'Invitation email',
  '活动信息准确，使用符合要求的报名链接。':
    'The event details must be accurate and use a registration link that meets the requirements.',
  '候选资料': 'Candidate materials',
  ' · 场地均可用于 14–16 时': ' · Both venues are available from 14:00 to 16:00',
  '选项': 'Option',
  '人数 / 配置': 'People / set-up',
  '费用': 'Cost',
  '场地 A': 'Venue A',
  '场地 B': 'Venue B',
  '24 人 · 投影仪': '24 people · projector',
  '16 人 · 投影仪': '16 people · projector',
  '20 份 · 含素食': '20 servings · includes vegetarian',
  '场地 A、B 均可用于 14:00–16:00。所有资料均为模拟数据。':
    'Both Venue A and Venue B work for 14:00–16:00. All materials are simulated.',

  /* ---- scripted agent plan labels (engine constants, translated at render time) ---- */
  '核对目标和约束': 'Check the goals and the constraints',
  '选择场地 A': 'Choose Venue A',
  '选择 Basic 茶点': 'Choose Basic catering',
  '配置报名表（姓名、邮箱、饮食偏好）': 'Configure the form (name, email, dietary preference)',
  '生成并检查邀请邮件': 'Generate and check the invitation email',
  '发布报名表，再发送邀请邮件': 'Publish the form, then send the invitation email',

  /* ---- scenario ---- */
  '下周，你要筹备一场校园工作坊': 'Next week you are organising a campus workshop',
  '请设想，你是一个学生社团的活动负责人。下周，社团准备举办一场“数据可视化入门”工作坊，20 名同学将带着电脑参加，跟着演示完成一次练习。团队已确定活动时间为 14:00–16:00，并预留 HK$5,000 用于场地和茶点。':
    'Imagine that you are the activity lead of a student society. Next week the society is running an introductory data-visualisation workshop: 20 students will bring their own laptops and follow a demonstration through one hands-on exercise. The team has fixed the time at 14:00–16:00 and set aside HK$5,000 for the venue and the catering.',
  '你负责把这些安排落实：找到能容纳大家、方便观看演示的场地，安排茶点，准备报名表，再向同学发送活动信息和报名链接。报名信息用于联系参加者、了解饮食需求。你希望大家收到清楚的邀请，并能顺利参加活动。':
    'You are the one who makes those arrangements real: finding a venue that fits everyone and makes the demonstration easy to watch, arranging the catering, preparing the registration form, and then sending the event details and the sign-up link to the students. The registration details are used to contact participants and to learn their dietary needs. You want everyone to receive a clear invitation and to be able to attend easily.',
  '这一次，你可以把具体操作交给一个 AI 助手。它会准备计划，并依次处理这些事项。你不需要亲自完成每个操作，但仍担任活动负责人：根据团队的要求观察执行，在你认为有必要时暂停、修改或调整。目标是得到一套符合要求、可以用于这场活动的筹备结果。':
    'This time, you can hand the detailed operations to an AI assistant. It will prepare a plan and work through these items in order. You do not have to carry out every operation yourself, but you are still the activity lead: you watch the execution against the team’s requirements and pause, change or adjust it when you consider it necessary. The goal is a set of arrangements that meets the requirements and works for this workshop.',
  '你不需要懂数据可视化，也不需要自行寻找资料。具体活动要求和候选资料都会提供；全部操作都发生在模拟环境中。':
    'You do not need to know data visualisation and you do not have to look for any materials yourself. The exact requirements and the candidate materials are given to you; everything happens in a simulated environment.',
  '了解如何监督 →': 'See how supervision works →',
  '接下来先熟悉操作，再进入任务。': 'Next you will practise the controls, and then the task begins.',

  /* ---- enrollment ---- */
  '正在检查参与入口…': 'Checking the study entry…',
  '暂时无法继续': 'Cannot continue right now',
  '请联系向你发送邀请码的研究者。': 'Please contact the researcher who sent you the invitation code.',
  '测试页面曾中断，当前设备没有可恢复的记录。':
    'The study page was interrupted and this device has no record that can be resumed.',
  '欢迎参加 AI 协作任务研究': 'Welcome to the study on supervising an AI collaborator',
  '你将监督一个 AI 助手筹备校园活动。预计约 20–25 分钟，请使用电脑，并在开始后保持当前页面打开。':
    'You will supervise an AI assistant that is preparing a campus event. It takes about 20–25 minutes. Please use a computer, and keep this page open once you start.',
  '研究会记录你的操作步骤、点击间隔、你在页面上的停留时间与页面可见性变化，也会记录 AI 助手执行的每一个动作。问卷与访谈回答按你填写的内容保存。你可以随时关闭页面退出，未提交的内容不会被当作已完成。AI 服务只接收模拟活动资料和计划，不接收你的邀请码。请勿填写真实个人资料。':
    'The study records your steps, the intervals between your clicks, how long the page stays on screen and changes in page visibility, and it records every action the AI assistant performs. Your questionnaire and interview answers are stored as you wrote them. You may close the page and leave at any time; anything you have not submitted is not treated as completed. The AI service only receives the simulated event materials and plans, never your invitation code. Please do not enter real personal data.',
  '邀请码': 'Invitation code',
  '我已阅读说明，自愿参与本次研究。': 'I have read the information and take part in this study voluntarily.',
  '输入研究者提供的邀请码，确认资格后进入任务。':
    'Enter the invitation code the researcher gave you; once your eligibility is confirmed you enter the task.',
  '当前暂未开放参与，请等待研究者通知。': 'Participation is not open at the moment; please wait for the researcher’s notice.',
  '验证邀请码，进入任务 →': 'Verify the invitation code and continue →',
  '当前参与入口已暂停，请联系研究者。': 'Registration is paused at the moment; please contact the researcher.',
  '邀请码不可用，请核对或联系研究者。':
    'That invitation code cannot be used; please check it or contact the researcher.',
  '暂时无法连接参与服务，请稍后刷新。': 'The study service cannot be reached at the moment; please refresh later.',

  /* ---- role instructions ---- */
  '你是这场工作坊的组织者': 'You are organising this workshop',
  'agent 将协助你安排场地、茶点、报名表和邀请邮件。':
    'The agent will help you arrange the venue, the catering, the registration form and the invitation email.',
  '你的任务是监督它的执行，并在认为有必要时介入。':
    'Your task is to supervise what it does, and to step in when you consider it necessary.',
  '不需要自己完成所有操作，也不需要逐步点击批准。agent 会自动继续；它可能正确，也可能出错。':
    'You do not have to complete everything yourself, and you do not have to click to approve each step. The agent continues on its own; it can be right, and it can be wrong.',
  '查阅要求': 'Read the brief',
  '执行时，任务要求和候选资料会一直显示在左侧。':
    'During execution the requirements and the candidate materials stay visible on the left.',
  '观察动作': 'Watch the actions',
  '中间显示 agent 即将执行的内容和剩余时间。':
    'The middle panel shows what the agent is about to do and how much time is left.',
  '按需介入': 'Step in when needed',
  '底栏可以暂停、修改动作、调整方向、继续或停止。':
    'The bottom bar lets you pause, change an action, change direction, resume or stop.',
  '操作规则': 'How the controls work',
  '“修改动作”或“调整方向”会自动暂停。保存或关闭窗口后仍然暂停，需点击“继续执行”。暂停期间也有时间上限。':
    '“Change the action” and “Change direction” pause automatically. After saving or closing the window the run is still paused and you have to press “Resume execution”. Pausing also has a time limit.',
  '预计约 20–25 分钟': 'About 20–25 minutes',
  '不会发生真实报名、发布或邮件发送': 'No real registration, publishing or email sending happens',
  '任务记录你的操作步骤、点击与停留时间，以及 AI 助手执行的每一个动作。问卷与访谈回答按你填写的内容保存。你可以随时关闭页面退出。请勿填写真实个人资料。':
    'The task records your steps, your clicks and dwell times, and every action the AI assistant performs. Your questionnaire and interview answers are stored as you wrote them. You may close the page and leave at any time. Please do not enter real personal data.',
  '先练习一次介入 →': 'Practise one intervention first →',

  /* ---- practice ---- */
  '先练习：修改文件名': 'Practice first: change a file name',
  '要求保存为 ': 'The requirement is to save it as ',
  '。当前准备使用另一个文件名，请按下方三步调整。':
    '. It is about to use a different file name; adjust it in the three steps below.',
  '1 · 暂停执行': '1 · Pause the run',
  '2 · 修改并保存': '2 · Change and save',
  '3 · 继续执行': '3 · Resume',
  '当前文件名': 'Current file name',
  '运行': 'Running',
  '暂停': 'Paused',
  '修改动作': 'Change the action',
  '继续执行': 'Resume execution',
  '文件名': 'File name',
  '保存修改': 'Save the change',
  '先点击“暂停”。': 'Start by pressing “Pause”.',
  '已暂停。点击“修改动作”，调整文件名。': 'Paused. Press “Change the action” to change the file name.',
  '文件名已修改；还没有恢复运行。点击“继续执行”。':
    'The file name has been changed; the run is not resumed yet. Press “Resume execution”.',
  '请与要求中的文件名核对，再保存。': 'Check the file name against the requirement, then save.',
  '已完成': 'Completed',
  '练习完成：暂停 → 修改并保存 → 继续执行。': 'Practice complete: pause → change and save → resume.',
  '练习完成，准备计划 →': 'Practice complete, on to the plan →',
  '练习完成，查看初始计划 →': 'Practice complete, on to the initial plan →',

  /* ---- planning ---- */
  '与 agent 共同安排初始计划': 'Plan the initial plan together with the agent',
  '阅读 agent 的初始计划': 'Read the agent’s initial plan',
  '前面三个步骤已确定。请安排后面三个子目标，并把要求分配到对应步骤。':
    'The first three steps are already fixed. Arrange the last three sub-goals and assign each requirement to the matching step.',
  '请阅读下面的计划及对应要求，确认理解后继续。':
    'Read the plan below together with the matching requirements, then continue once you are sure you understand it.',
  '依赖关系：先配置报名表，再检查带有报名链接的邮件；发布与发送放在配置和检查之后。':
    'Dependencies: configure the registration form first, then check the email with the sign-up link; publishing and sending come after configuring and checking.',
  '1 · 安排最后三个子目标': '1 · Arrange the last three sub-goals',
  '第 4 步': 'Step 4',
  '第 5 步': 'Step 5',
  '第 6 步': 'Step 6',
  '请选择子目标': 'Choose a sub-goal',
  '配置报名表': 'Configure the registration form',
  '生成并检查邮件': 'Generate and check the email',
  '发布表单并发送邀请': 'Publish the form and send the invitations',
  '2 · 分配相关要求': '2 · Assign the matching requirements',
  '仅收集允许的报名字段': 'Collect only the permitted registration fields',
  '检查活动信息和报名链接': 'Check the event details and the sign-up link',
  '合规表单发布后发送邀请': 'Send the invitations after a compliant form is published',
  '选择对应子目标': 'Choose the matching sub-goal',
  '确认理解对应要求': 'Confirm that you understand the matching requirements',
  '配置报名表：仅收集允许的字段。': 'Configure the registration form: collect only the permitted fields.',
  '生成邮件：检查活动信息和报名链接。': 'Generate the email: check the event details and the sign-up link.',
  '发布并发送：合规表单发布后发送邀请。': 'Publish and send: send the invitations after a compliant form is published.',
  '请再核对依赖关系与要求的对应步骤。也可以请求 agent 完成安排。':
    'Check the dependencies against the requirements once more. You can also ask the agent to do the arranging.',
  '提交共同计划': 'Submit the joint plan',
  '提交共同计划 →': 'Submit the joint plan →',
  '确认已读': 'Confirm I have read it',
  '请 agent 完成安排': 'Let the agent do the arranging',
  '这是即将执行的初始计划': 'This is the initial plan that is about to run',
  '请阅读计划。开始后 AI 助手将自动执行，你可以随时使用底栏介入。':
    'Read the plan. Once it starts the AI assistant runs it automatically and you can use the bottom bar at any time.',
  '修改动作会暂停执行；保存后要点击“继续执行”。任务要求和候选资料会一直显示在执行界面左侧。':
    'Changing an action pauses the run; after saving you have to press “Resume execution”. The requirements and the candidate materials stay visible on the left of the execution screen.',
  '助手正在准备本次任务，请稍候。': 'The assistant is preparing this task; please wait.',
  '助手已准备好。阅读完计划后，可以开始。': 'The assistant is ready. You can start once you have read the plan.',
  '助手暂时未能完成准备。你可以重试；若仍失败，请联系研究者。':
    'The assistant could not finish preparing. You can retry; if it still fails, please contact the researcher.',
  '开始监督 →': 'Start supervising →',
  '重试准备': 'Retry the preparation',
  '当前测试无法开始，请联系研究者。': 'This session cannot start; please contact the researcher.',

  /* ---- execution ---- */
  '当前动作预览': 'Current action preview',
  '执行计划': 'Execution plan',
  '实时状态': 'Live status',
  '已发生动作': 'Actions so far',
  '与左侧任务要求核对。是否介入，由你判断；无需逐步确认。':
    'Check this against the task brief on the left. Whether to step in is your judgement; there is nothing to confirm step by step.',
  'agent 正在运行': 'The agent is running',
  'agent 已暂停': 'The agent is paused',
  '如需介入，可直接修改动作或先暂停。':
    'If you need to step in, change the action directly or pause first.',
  '检查当前预览后，点击“继续执行”。': 'Check the current preview, then press “Resume execution”.',
  '只暂停，不修改内容': 'Pause only, without changing anything',
  '自动暂停并打开当前动作编辑器': 'Pause automatically and open the editor for the current action',
  '自动暂停，调整后续处理方式': 'Pause automatically and change how the rest is handled',
  '终止本次工作流，进入任务后回答': 'End this workflow and go to the post-task questions',
  '调整方向': 'Change direction',
  '停止任务': 'Stop the task',
  '自动继续倒计时': 'Automatic continuation countdown',
  '暂停剩余时间': 'Time left while paused',
  '计时已冻结；保存后需手动继续。': 'The countdown is frozen; after saving you resume manually.',
  '没有介入时，agent 会自动继续。': 'Without an intervention the agent continues on its own.',
  '尚无已完成动作。': 'No completed actions yet.',
  '按初始顺序执行。': 'Running in the initial order.',
  '已完成': 'Completed',
  '当前': 'Current',
  '待执行': 'Pending',
  '资源步骤已开始，不能再交换资源顺序。仍可选择任务要求中的报名模板。':
    'A resource step has already started, so the resource order can no longer be swapped. You can still choose the registration template from the task brief.',
  '资源步骤尚未开始，可以调整资源顺序，或选择任务要求中的报名模板。':
    'No resource step has started yet, so you can change the resource order, or choose the registration template from the task brief.',

  /* ---- action previews ---- */
  '核对目标与约束': 'Check the goals and the constraints',
  'agent 正在读取本次工作坊的任务要求。': 'The agent is reading the task brief for this workshop.',
  '人数、时间、场地、预算、报名字段与邀请链接。':
    'Participants, time, venue, budget, registration fields and the invitation link.',
  '收到资源资料更新': 'Updated resource materials arrive',
  '新的资料已加入本次任务。': 'New materials have been added to this task.',
  '两份资源资料均已到齐。茶点供应商补发了菜单说明；场地与茶点均可先处理，价格和可用性不变。':
    'Both resource materials are now complete. The caterer has sent an extra menu note; either the venue or the catering can be handled first, and the prices and availability are unchanged.',
  '选择场地': 'Choose the venue',
  '选择茶点': 'Choose the catering',
  'agent 准备使用以下选项。': 'The agent is about to use the following option.',
  '待执行选择': 'Selection to be made',
  '套餐': 'Package',
  '对应资料': 'Matching material',
  '报名字段': 'Registration fields',
  'agent 准备把这些字段加入报名表。': 'The agent is about to add these fields to the registration form.',
  'agent 准备使用以下活动信息。': 'The agent is about to use the following event details.',
  '主题': 'Subject',
  '邀请：20 人工作坊': 'Invitation: workshop for 20 people',
  '时间与地点': 'Time and place',
  '报名链接': 'Registration link',
  '模拟报名表': 'Simulated registration form',
  'agent 即将发布以下内容，随后发送工作坊邀请。':
    'The agent is about to publish the following and then send the workshop invitations.',
  '待发布字段': 'Fields to be published',
  '发布后，邀请邮件将指向这份报名表。': 'Once published, the invitation email will point to this registration form.',
  '发送邀请邮件': 'Send the invitation email',
  '报名表已发布，agent 准备发送邀请。': 'The form has been published; the agent is about to send the invitations.',
  '20 人工作坊 · 14:00–16:00 · 模拟报名链接': 'Workshop for 20 people · 14:00–16:00 · simulated sign-up link',
  '已选择场地 A。': 'Venue A has been chosen.',
  '已选择场地 B。': 'Venue B has been chosen.',
  '已选择 Basic 茶点。': 'Basic catering has been chosen.',
  '已选择 Premium 茶点。': 'Premium catering has been chosen.',
  '已生成邀请邮件。': 'The invitation email has been generated.',
  '已核对目标和约束。': 'The goals and the constraints have been checked.',
  '顺序：场地→茶点 改为 茶点→场地': 'Order: venue → catering becomes catering → venue',
  '顺序：场地→茶点 保持不变': 'Order: venue → catering does not change',
  '已发布报名表。': 'The registration form has been published.',
  '已发送邀请邮件。': 'The invitation email has been sent.',

  /* ---- questionnaire ---- */
  'POST-TASK QUESTIONS': 'POST-TASK QUESTIONS',
  '回忆刚才的执行': 'Recall the execution',
  '计划与参与体验': 'The plan and how you took part',
  '监督体验': 'The supervision experience',
  '先按记忆回答。任务资料暂不展示；不知道时可以直接说明。':
    'Answer from memory first. The task materials are not shown yet; if you do not know, just say so.',
  '按实际体验选择。1 = strongly disagree；7 = strongly agree。':
    'Choose according to your actual experience. 1 = strongly disagree; 7 = strongly agree.',
  '按实际体验选择。1 = 非常不同意；7 = 非常同意。':
    'Choose according to your actual experience. 1 = strongly disagree; 7 = strongly agree.',
  '1 · 非常不同意': '1 · strongly disagree',
  '7 · 非常同意': '7 · strongly agree',
  '资料更新后，agent 的资源顺序': 'After the materials were updated, the agent’s resource order',
  '请选择': 'Please choose',
  '不确定': 'Not sure',
  '未观察到该阶段': 'I did not observe that stage',
  '你认为 agent 有没有改计划？': 'Do you think the agent changed the plan?',
  '保持原计划': 'It kept the original plan',
  '改变顺序': 'It changed the order',
  '最后一次动作预览中，agent 处于哪个子目标？':
    'In the last action preview, which sub-goal was the agent on?',
  '当时如果你不介入，agent 下一步会做什么？':
    'If you had not stepped in then, what would the agent have done next?',
  '你是否发现需要纠正的地方？说明当时的依据。':
    'Did you find something that needed correcting? Explain what told you at the time.',
  '正式权限核对': 'Check of what you were allowed to do',
  '我可以暂停、修改待执行动作并继续': 'I could pause, change a pending action and resume',
  '我只能暂停': 'I could only pause',
  '具体改变了什么？你从哪里发现？': 'What exactly changed, and how did you notice?',
  '← 上一部分': '← Previous part',
  '保存，下一部分 →': 'Save and go to the next part →',
  '保存回答，进入访谈 →': 'Save the answers and go to the interview →',

  /* original Likert items (English source, Chinese equivalent for the Chinese UI) */
  '助手在执行中改变了剩余计划的顺序。': 'The agent changed the order of its remaining plan during execution.',
  '执行过程中，我可以查看助手当前的计划。': 'During execution, I could inspect the agent’s current plan.',
  '我可以查看还剩哪些步骤以及它们的顺序。': 'I could see which steps remained and their order.',
  '我主动参与构造了初始计划。': 'I actively helped construct the initial plan.',
  '我的行动影响了初始计划是如何组织起来的。': 'My actions contributed to how the initial plan was organized.',
  '我可以暂停、修改待执行的动作并继续执行。': 'I was allowed to pause, change a pending action, and resume execution.',
  '我可以在恰当的时机介入。': 'I could intervene at the right moment.',
  '我可以把流程拉回到符合我要求的状态。': 'I could bring the workflow back in line with my requirements.',
  '这个任务有难度。': 'The task was difficult.',
  '理解助手需要动脑筋。': 'Understanding the agent required mental effort.',
  '我感到有时间压力。': 'I felt under time pressure.',
  '助手把任务处理得很妥当。': 'The agent handled the task competently.',
  '我会信任助手后续的行动。': 'I would trust the agent’s subsequent actions.',
  '我能看出计划是什么时候被修改的。': 'I could identify when the plan was revised.',
  '我能看出哪些步骤的顺序发生了变化。': 'I could identify which steps changed order.',

  /* ---- interview and closing ---- */
  'YOUR EXPERIENCE': 'YOUR EXPERIENCE',
  '分享你的想法': 'Share what you thought',
  '以下回答为可选内容。请描述你自己的体验；没有注意到或不确定也可以直接说。':
    'These questions are optional. Describe your own experience; if you did not notice something or are unsure, just say so.',
  '请按自己的理解讲一下 agent 做了什么，哪些地方容易或难以理解？':
    'In your own words, what did the agent do, and which parts were easy or hard to understand?',
  '决定介入或不介入时，你主要看了哪些信息？当时预期下一步是什么？':
    'When you decided whether to step in, which information did you mainly look at? What did you expect to happen next?',
  '你有没有发现计划或顺序变化？何时、依据是什么？':
    'Did you notice any change in the plan or the order? When, and on what basis?',
  '资料更新后，你如何决定继续观察、查看信息或调整行动？':
    'After the materials were updated, how did you decide whether to keep watching, look at something, or change your action?',
  '你认为场地先做和茶点先做有什么不同？有一种让 agent 显得更能干或更笨吗？':
    'What is the difference between doing the venue first and doing the catering first? Does either make the agent look more capable or more clumsy?',
  '最初准备计划的过程如何影响后续监督？哪些步骤或要求更容易记住？':
    'How did the process of preparing the initial plan affect your later supervision? Which steps or requirements stayed in your memory?',
  /* Core-study wording: nobody prepared the plan with the agent, so the question asks
     neutrally about reviewing the initial plan. The field id (q6) is unchanged. */
  '最初审阅初始计划的过程如何影响后续监督？哪些步骤或要求更容易记住？':
    'How did reviewing the initial plan affect your later supervision? Which steps or requirements stayed in your memory?',
  '如果没有纠正表单，当时发生了什么？先自由描述。':
    'If the form had not been corrected, what would have happened? Describe it freely first.',
  '有没有觉得该介入却不知道怎么操作？哪些信息或控件最有帮助？':
    'Was there a moment when you felt you should have stepped in but did not know how? Which information or controls helped most?',
  '你觉得什么算 agent 做错了？与任务 brief 是否一致？':
    'What would you count as the agent getting it wrong? Was it consistent with the task brief?',
  '只改一个地方来帮助监督，你会改什么？':
    'If you could change one thing to make supervising easier, what would it be?',
  '提交回答 →': 'Submit the answers →',
  'SESSION COMPLETE': 'SESSION COMPLETE',
  '感谢你的参与': 'Thank you for taking part',
  '你的回答已经收到。本次测试已完成，可以关闭页面。':
    'Your answers have been received. This session is complete; you can close the page.',
  '如有后续问题，请联系向你发送邀请码的研究者。':
    'If you have any questions afterwards, please contact the researcher who sent you the invitation code.',
  '正在提交你的回答…': 'Submitting your answers…',
  '请暂时保持页面打开。': 'Please keep the page open for a moment.',
  '回答尚未提交成功': 'The answers were not submitted',
  '当前设备已保留记录，请检查网络后重试。':
    'This device still holds the record; please check the network and try again.',
  '重新提交': 'Submit again',

  /* ---- Protocol v2 (plan-dependent-v03) ---------------------------------- */
  /* Language is chosen in the existing header BEFORE enrollment, then frozen for the
     whole session. It is a covariate, never a factor, and never changes the trial. */
  '界面语言（开始前选择，之后全程保持不变）': 'Interface language (choose before you start; it stays fixed afterwards)',
  '本次会话将使用': 'This session will use',
  '开始后语言保持不变。': 'The language stays the same once you start.',
  '开始任务前请选择界面语言。': 'Please choose the interface language before starting the task.',
  '已进入任务，语言不再改变。': 'You have entered the task; the language no longer changes.',

  /* ---- comprehension gate (three facts, all must be right to begin) ---------- */
  '任务理解核对': 'Task comprehension check',
  '请按任务要求回答这三项，之后才能开始监督。':
    'Answer these three items from the task requirements before you can start supervising.',
  '发布报名表之前，必须完成哪一项最终检查？':
    'Which final check must be completed before the registration form is published?',
  '报名表允许收集哪些字段？': 'Which fields may the registration form collect?',
  '本次活动的总预算上限是多少？': 'What is the total budget limit for this event?',
  '核对预算上限': 'Budget limit',
  '核对报名字段': 'Permitted registration fields',
  '核对发布前的检查': 'Final check before publication',
  '只收集姓名、邮箱、饮食偏好': 'Collect only name, email and dietary preference',
  '完成最终合规审查': 'Complete the final compliance review',
  '继续修改': 'Try again',
  '答案不正确。请对照任务要求再试一次。':
    'That answer is not right. Check the task requirements and try once more.',
  '回答正确，请继续。': 'Correct — please continue.',
  '仍不正确。下面的任务要求会重新显示，请再看一遍后重答。':
    'Still not right. The task requirements are shown again below; read them and answer again.',
  '三项都回答正确，可以开始监督。': 'All three answers are correct. You can start supervising.',

  /* ---- v03 execution: the review step is an ordinary pending row ------------- */
  '最终合规审查': 'Final compliance review',
  '逐项核对发布前的四项要求：预算、容量、报名字段、活动信息。':
    'Check the four pre-publication requirements one by one: budget, capacity, registration fields and event details.',
  '预算合计 ≤ HK$5,000': 'Total budget ≤ HK$5,000',
  '容量 ≥ 20 人': 'Capacity ≥ 20 people',
  '仅收集允许的三项字段': 'Only the three permitted fields',
  '活动信息与报名链接准确': 'Event details and sign-up link are correct',
  '已排入步骤，尚未执行。': 'Scheduled as a step; not carried out yet.',
  /* ---- Protocol v2: the strings the REAL v03 engine emits ------------------- */
  /* These come from `Oversight.V2_LABELS` and from the scripted trace lines, so they are
     part of the participant-facing surface exactly like any other copy. */
  '撰写邀请邮件草稿': 'Draft the invitation email',
  '发布前最终合规审查': 'The final compliance review before publication',
  '发布报名表': 'Publish the registration form',
  '发送邀请邮件': 'Send the invitation email',
  '邀请邮件草稿已就绪。': 'The invitation email draft is ready.',
  '已完成发布前最终审查：预算、容量、报名字段与活动信息。':
    'The final review before publication is complete: budget, capacity, registration fields and event details.',
  '已完成审查后发布报名表。': 'The registration form was published after the review.',
  '顺序：报名表→场地→茶点': 'Order: registration form → venue → catering',
  '顺序：场地→茶点→报名表 保持不变': 'Order: venue → catering → registration form does not change',
  /* The task brief calls it the event time, not a duration. */
  '活动时间': 'Event time',
  /* The bottom-bar control is an ACTION ("Pause"), while the chip and the bar title carry
     the STATE ("Paused"). They are deliberately different words in both languages. */
  '暂停': 'Pause',
  '已暂停': 'Paused',
  '继续执行': 'Resume execution',
  '继续执行 →': 'Resume execution →',
  '你将监督一个 AI 助手筹备校园活动。预计约 25–35 分钟（估计值），请使用电脑，并在开始后保持当前页面打开。':
    'You will supervise an AI assistant preparing a campus event. It is estimated to take about 25–35 minutes; please use a computer and keep this page open once you start.',
  '开始任务前请选择界面语言（右上角）。本次会话将使用 ': 'Please choose the interface language (top right) before you start. This session will use ',
  '，开始后语言保持不变。': ', and the language stays fixed once you start.',
  '开始任务前请选择界面语言。': 'Please choose the interface language before starting the task.',
  '本次会话将使用': 'This session will use',
  '开始后语言保持不变。': 'The language stays the same once you start.',
  '已进入任务，语言不再改变。': 'You have entered the task; the language no longer changes.',
  '界面语言（开始前选择，之后全程保持不变）': 'Interface language (choose before you start; it stays fixed afterwards)',
  '发布前的最终审查': 'The final review before publication',
  '任何面向参与者的资料发布或发送之前，必须完成预算、场地容量、报名字段、活动信息四项最终审查。':
    'Before any material is published or sent to participants, the four final checks must be completed: budget, venue capacity, registration fields and event details.',
  '预计约 25–35 分钟（估计值）': 'Estimated at about 25–35 minutes',
  '预计约 20–25 分钟': 'About 20–25 minutes',
  '逐项核对发布前的四项要求：预算、容量、报名字段、活动信息。':
    'Check the four pre-publication requirements one by one: budget, capacity, registration fields and event details.',
  '正在逐项核对发布前的四项要求。':
    'Checking the four pre-publication requirements one by one.',
  '已完成最终合规审查。': 'The final compliance review has been completed.',

  /* ---- generic recovery direction (no answer is preselected) ----------------- */
  '在当前动作前插入或恢复一个步骤': 'Insert or restore a step before the current action',
  '请选择一种处理方式。应用后仍保持暂停，确认预览后再继续。':
    'Choose how to proceed. The run stays paused after applying; resume once you have checked the preview.',
  '恢复一个尚未完成的步骤': 'Restore a step that has not been completed',
  '在当前动作前插入一个步骤': 'Insert a step before the current action',
  '当前动作前插入步骤': 'Insert a step before the current action',
  '恢复步骤（尚未执行）': 'Restore a step (not carried out yet)',
  '恢复的步骤已经排入计划，但还没有执行。':
    'The restored step has been scheduled, but it has not been carried out yet.',
  '已恢复：最终合规审查': 'Restored: the final compliance review',
  '该步骤已排入计划，在你点击“继续执行”之后才会执行。':
    'The step is now scheduled; it will only be carried out after you press “Resume execution”.',
  '当前无法恢复步骤，请重新选择处理方式。':
    'The step cannot be restored right now. Please choose another way to proceed.',
  '本协议不使用报名字段模板。': 'This protocol does not use a registration field template.',
  '继续处理后续步骤': 'Carry on with the remaining steps',
  '本次任务要求在发布报名表之前，先完成最终合规审查。':
    'The task requires the final compliance review to be completed before the registration form is published.',
  'agent 收到的资料更新已生效，其余顺序不变。':
    'The update the agent received has taken effect; the rest of the order is unchanged.',
  '报名表服务已可用，可先于场地与茶点完成。':
    'The registration form service is available and can be completed before the venue and catering.',

  /* ---- post-task unprompted current-plan recall ------------------------------ */
  '执行结束后，凭记忆回答': 'After the run, answer from memory',
  '不分先后，按你认为的执行顺序列出仍在计划中的步骤（不超过 8 步）。':
    'In any order, list the steps you believe were still in the plan (no more than 8).',
  '你记住的计划顺序': 'The plan order you recall',
  '按计划顺序填写步骤编号，1 表示你记忆中的第一步。留空表示你不记得。':
    'Enter the step numbers in plan order; 1 is the first step you recall. Leave blank if you do not remember.',
  '你什么时候感觉到执行顺序发生了变化？':
    'When did you notice that the order of execution had changed?',
  '执行开始前': 'Before the run started',
  '资料更新时': 'When the materials were updated',
  '执行中稍后': 'Later during the run',
  '直到任务结束都没有发现': 'I did not notice it at all',
  '不确定': 'Not sure',
  '不需要更正': 'No correction was needed',
  '更正了报名字段': 'I corrected the registration fields',
  '更正了执行顺序': 'I corrected the execution order',
  '更正了其他内容': 'I corrected something else',
  '任务已完成，未作更正': 'The run finished; I corrected nothing',

  /* ---- v03 step labels (mirror of the engine's per-trial `labels`) ---------- */
  '核对目标和约束': 'Check the goals and the constraints',
  '选择场地 A': 'Choose venue A',
  '选择 Basic 茶点': 'Choose Basic catering',
  '配置报名表（姓名、邮箱、饮食偏好）': 'Configure the registration form (name, email, dietary preference)',
  '生成并检查邀请邮件': 'Generate and check the invitation email',
  '发布报名表，再发送邀请邮件': 'Publish the registration form, then send the invitations',
  '8 步计划': '8-step plan',
  '核对预算上限': 'Budget limit',
  '核对发布前的检查': 'Final check before publication',
  '在当前动作前插入或恢复一个步骤': 'Insert or restore a step before the current action',
  '继续处理后续步骤': 'Carry on with the remaining steps',
  '更正了其他内容（恢复到某个步骤）': 'I corrected something else (restored a step)',
  '执行开始前': 'Before the run started',
  '资料更新时': 'When the materials were updated',
  '执行中稍后': 'Later during the run',
  '直到任务结束都没有发现': 'I did not notice it at all',
  '不需要更正／任务已完成，未作更正': 'No correction was needed / the run finished and I corrected nothing',
  '更正了报名字段': 'I corrected the registration fields',
  '更正了执行顺序': 'I corrected the execution order',
  '执行结束时你做了哪种处理？': 'When the run ended, which of these did you do?',
  '你什么时候感觉到执行顺序发生了变化？': 'When did you notice that the order of execution had changed?',
  '不分先后，按你记忆中的计划顺序填写步骤编号；留空表示不记得。':
    'In any order, fill in the step numbers you remember; leave blank if you do not remember.',
  '本次任务中，待执行动作的内容不可更改；如需调整处理方式，请使用底栏的“调整方向”。':
    'In this task the content of a pending action cannot be changed. To change how the rest is handled, use “Change direction” in the bottom bar.',
  '本次任务中，待执行动作的内容不可更改。如需调整后续处理方式，请关闭本窗口后使用底栏的“调整方向”。':
    'In this task the content of a pending action cannot be changed. To change how the rest is handled, close this window and use “Change direction” in the bottom bar.',
  '本次任务中，待执行动作的内容不可更改；如需调整后续处理方式，请关闭本窗口后使用底栏的“调整方向”。':
    'In this task the content of a pending action cannot be changed. To change how the rest is handled, close this window and use “Change direction” in the bottom bar.',
  '选择一种处理方式。应用后仍保持暂停，确认预览后再继续。恢复的步骤会排入计划，但不会自动执行。':
    'Choose how to proceed. The run stays paused after applying; resume once you have checked the preview. A restored step is scheduled in the plan but is not carried out automatically.',
  '回答正确，请继续。': 'Correct — please continue.',
  '仍然不正确。请对照左侧任务要求再答一次。': 'Still not right. Check the task requirements on the left and answer again.',
  '仍不正确。': 'Still not right.',
  '提交未成功，请检查网络后重试。': 'The submission did not go through; please check the network and try again.',
  '三项都回答正确，可以开始监督。': 'All three answers are correct. You can start supervising.',
  '执行结束后，凭记忆回答': 'After the run, answer from memory',
  '你记住的计划顺序': 'The plan order you recall',
  '正在逐项核对发布前的四项要求。': 'Checking the four pre-publication requirements one by one.',
  '逐项核对': 'Check one by one',
  '预算合计 ≤ HK$5,000': 'Total budget ≤ HK$5,000',
  '容量 ≥ 20 人': 'Capacity ≥ 20 people',
  '仅收集允许的三项字段': 'Only the three permitted fields',
  '活动信息与报名链接准确': 'Event details and sign-up link are correct',
  '已恢复：最终合规审查': 'Restored: the final compliance review',
  '已排入步骤，尚未执行。': 'Scheduled as a step; not carried out yet.',
});

HLLI18n.addCatalog({
  "服务更新后，你认为 agent 当时的计划是什么？": "What did you think the agent's current plan was after the service update?",
  "如果有，你在什么时候意识到执行顺序发生了变化？当时依据是什么？": "At what point, if any, did you realize that the execution order had changed? What did you notice then?",
  "资料更新后，agent 的工作顺序": "The agent's work sequence after the service update",
  "场地 → 茶点 → 报名表": "Venue → catering → registration form",
  "报名表 → 场地 → 茶点": "Registration form → venue → catering",
  "其他顺序": "Another sequence",
  "你认为先配置报名表和先安排场地、茶点有什么不同？这种顺序影响你对 agent 能力或任务难度的判断吗？": "What difference did it make to configure the form before, rather than after, the venue and catering? Did that affect your view of the agent’s competence or the task’s difficulty?",
  "你如何理解最终审查和发布之间的先后关系？如果没有恢复流程，当时发生了什么？先自由描述。": "How did you understand the relationship between the final review and publication? If you did not restore the workflow, what happened? Please describe it in your own words.",
  "研究会记录你的操作步骤、点击间隔、你在页面上的停留时间与页面可见性变化，也会记录 AI 助手执行的每一个动作。问卷与访谈回答按你填写的内容保存。你可以随时关闭页面退出，未提交的内容不会被当作已完成。所有活动资料与操作均为模拟，不会真实发布或发送。请勿填写真实个人资料。": "The study records your actions, click intervals, page dwell and visibility changes, and the simulated assistant’s actions. Your questionnaire and interview responses are saved as entered. You may leave by closing the page; an unsubmitted response is not treated as completed. All activity materials and operations are simulated: nothing is really published or sent. Please do not enter real personal information."
});

HLLI18n.addCatalog({"请选择步骤": "Select a step", "选择要在当前动作之前执行的步骤。应用只安排步骤，仍需点击继续执行。": "Select the step to carry out before the current action. Applying schedules it; you still need to resume execution.", "当前不能在这里执行这个步骤。请选择其他步骤，或关闭窗口继续观察。": "That step cannot be carried out here. Select another step, or close this dialog to keep observing."});

HLLI18n.addCatalog({"请按任务要求回答这三项，之后才能开始监督。答错可以重试，系统会分别记录首次与后续尝试。": "Answer these three questions using the task requirements before supervising. You can retry; first and subsequent attempts are recorded separately.", "检查报名表配色": "Check the registration form colours", "姓名、邮箱、饮食偏好和身份证号码": "Name, email, dietary preference and identity number", "提交答案 →": "Submit answers →", "提交答案": "Submit answers", "答案不正确。请对照左侧任务要求再试一次。": "An answer is incorrect. Check the task requirements on the left and try again.", "仍不正确。请对照左侧任务要求再答一次。": "An answer is still incorrect. Read the task requirements on the left and answer again.", "系统更新：报名表服务提前可用。报名表仅需姓名、邮箱和饮食偏好，可独立于场地和茶点配置。场地、茶点、价格及任务要求均不变。": "System update: the registration-form service is available earlier than expected. It needs only name, email and dietary preference and is independent of venue and catering. Availability, prices and task requirements are unchanged."});

HLLI18n.addCatalog({"本次任务已经启动，请刷新页面核对记录；若无法恢复，请联系研究者。": "This task has already started. Refresh to check your saved record; if it cannot be restored, contact the researcher."});

/* Numbered, counted and templated copy: anchored patterns, never a global replacement. */
HLLI18n.addPatterns([
  {
    en: function (match, tr) { return tr(match[1]) + ' seconds'; },
    re: /^(\d+) 秒$/,
  },
  {
    en: function (match) { return '≥ ' + match[1] + ' seconds'; },
    re: /^≥ (\d+) 秒$/,
  },
  {
    en: function (match) { return match[1] + '–' + match[2] + ' seconds'; },
    re: /^(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒$/,
  },
  {
    en: function (match) { return match[1] + ' ms'; },
    re: /^(\d+) 毫秒$/,
  },
  {
    en: function (match) { return 'Please read first · ' + match[1] + ' seconds'; },
    re: /^请先阅读 · (\d+) 秒$/,
  },
  {
    en: function (match) { return match[0]; },
    zh: function (match) { return '请先阅读 · ' + match[1] + ' 秒'; },
    re: /^Please read first · (\d+) seconds$/,
  },
  {
    en: function (match, tr) { return 'Paused · ' + match[1] + ' seconds remaining · ' + tr(match[2]); },
    re: /^暂停剩余 (\d+) 秒 · (.*)$/,
  },
  {
    en: function (match) { return match[0]; },
    zh: function (match, tr) { return '暂停剩余 ' + match[1] + ' 秒 · ' + tr(match[2]); },
    re: /^Paused · (\d+) seconds remaining · (.*)$/,
  },
  {
    en: function (match) { return 'Receipt number: ' + match[1]; },
    re: /^提交编号：(.*)$/,
  },
  {
    en: function (match) { return 'Venue ' + match[1]; },
    re: /^场地 ([AB])$/,
  },
  {
    en: function (match) { return match[1] + ' people · projector · HK$' + match[2]; },
    re: /^(\d+) 人 · 投影仪 · HK\$([\d,]+)$/,
  },
  {
    en: function (match) { return match[1] + ' servings · includes vegetarian · HK$' + match[2]; },
    re: /^(\d+) 份 · 含素食 · HK\$([\d,]+)$/,
  },
  {
    en: function (match) { return '14:00–16:00 · Venue ' + match[1]; },
    re: /^14:00–16:00 · 场地 ([AB])$/,
  },
  {
    en: function (match, tr) { return 'Read · ' + tr(match[1]); },
    re: /^已阅读 · (.*)$/,
  },
  {
    en: function (match) { return match[0]; },
    zh: function (match, tr) { return '已阅读 · ' + tr(match[1]); },
    re: /^Read · (.*)$/,
  },
  {
    en: function (match, tr) { return match[1] + '. ' + tr(match[2]); },
    re: /^(\d+)\. (.*)$/,
  },
  {
    en: function (match, tr) { return 'Registration form configured: ' + match[1].split('、').map(tr).join(', ') + '.'; },
    re: /^已配置报名表：(.*)。$/,
  },
]);

HLLI18n.start();