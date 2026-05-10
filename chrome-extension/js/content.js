// ============================================================
// LLM Translator Content Script
// ============================================================

let settings = {
  selectedModelIdx: 0,
  contextSentences: 1,
  apiKeys: { GEMINI_API_KEY: '', GROQ_API_KEY: '' },
};

const MODELS = [
  {
    name: 'groq · openai/gpt-oss-120b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    format: 'openai',
    keyRef: 'GROQ_API_KEY',
  },
  {
    name: 'groq · qwen3-32b',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'qwen/qwen3-32b',
    format: 'openai',
    keyRef: 'GROQ_API_KEY',
  },
  {
    name: 'groq · llama-3.3-70b-versatile',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    format: 'openai',
    keyRef: 'GROQ_API_KEY',
  },
];

const MAX_TOKENS = 1024;

// Inject HTML
const html = `
  <div id="llm-popup">
    <div class="llm-popup-arrow"></div>
    <div class="llm-popup-content">
      <div class="pop-bar">
        <div class="llm-pop-actions" id="llm-popup-actions"></div>
        <div class="pop-bar-spacer"></div>
        <button class="llm-icon-circle-btn" id="llm-popup-toggle-input" title="Ask follow-up">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
        <button class="llm-icon-circle-btn" id="llm-popup-close" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div id="llm-popup-out"></div>
      <form id="llm-popup-form" hidden>
        <span class="prompt">&gt;</span>
        <input id="llm-popup-input" type="text" autocomplete="off" placeholder="ask follow-up…">
      </form>
    </div>
  </div>
`;

const container = document.createElement('div');
container.innerHTML = html;
document.body.appendChild(container);

const $ = id => document.getElementById(id);
const popup = $('llm-popup');
const popupOut = $('llm-popup-out');
const popupForm = $('llm-popup-form');
const popupInput = $('llm-popup-input');
const popupActions = $('llm-popup-actions');

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// LLM streaming (browser-direct SSE)
// ============================================================
async function* streamSSE(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let txt = '';
    try { txt = await res.text(); } catch {}
    throw new Error(`http ${res.status}: ${txt.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const evt = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = evt.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { yield JSON.parse(payload); } catch {}
    }
  }
}

async function* streamOpenAI(cfg, messages, system, apiKey) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    messages: msgs,
    stream: true,
    temperature: 0,
    top_p: 1,
  };
  if (!cfg.model.startsWith('llama')) {
    body.reasoning_effort = cfg.model.startsWith('qwen') ? 'none' : 'low';
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  for await (const evt of streamSSE(cfg.url, headers, body)) {
    const text = evt?.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

async function* streamGoogle(cfg, messages, system, apiKey) {
  const url = `${cfg.url}/v1/models/${cfg.model}:streamGenerateContent?alt=sse`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: MAX_TOKENS,
      thinkingConfig: { thinkingLevel: 'MINIMAL' },
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const headers = { 'x-goog-api-key': apiKey };
  for await (const evt of streamSSE(url, headers, body)) {
    const parts = evt?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.thought) continue;
      if (p.text) yield p.text;
    }
  }
}

const VENDORS = { openai: streamOpenAI, google: streamGoogle };

async function* llmStream(messages, system) {
  const cfg = MODELS[settings.selectedModelIdx];
  if (!cfg) throw new Error('no model selected');
  const apiKey = (settings.apiKeys[cfg.keyRef] || '').trim();
  if (!apiKey) throw new Error(`missing ${cfg.keyRef} — paste it in Extension Settings`);
  const fn = VENDORS[cfg.format];
  if (!fn) throw new Error(`unknown vendor format: ${cfg.format}`);
  yield* fn(cfg, messages, system, apiKey);
}

// ============================================================
// Popup state + helpers
// ============================================================
const popupHistory = [];
let popupBusy = false;
let lastLookup = null;

function isPopupVisible() {
  return popup.classList.contains('visible');
}

function popupWrite(text, cls, opts) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  popupOut.appendChild(div);
  if (!opts || opts.scroll !== false) {
    popupOut.scrollTop = popupOut.scrollHeight;
  }
  repositionPopup();
  return div;
}

function renderMarkdown(text) {
  let h = escapeHtml(text);
  h = h.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  return h;
}

function repositionPopup(customRect) {
  if (!isPopupVisible() || !lastLookup) return;
  const rect = customRect || lastLookup.range.getBoundingClientRect();
  const W = 420;
  const H = popup.offsetHeight;
  const margin = 12;
  const gap = 12;

  const selCenterX = rect.left + rect.width / 2;
  const selCenterY = rect.top + rect.height / 2;
  
  const placeAbove = selCenterY > window.innerHeight / 2;
  
  popup.classList.toggle('pos-above', placeAbove);
  popup.classList.toggle('pos-below', !placeAbove);

  let left = selCenterX - W / 2;
  left = Math.max(margin, Math.min(window.innerWidth - W - margin, left));
  
  let top;
  if (placeAbove) {
    top = rect.top - H - gap;
    if (top < margin) top = margin;
  } else {
    top = rect.bottom + gap;
    if (top + H > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - H - margin);
      if (top < rect.bottom + gap) top = rect.bottom + gap;
    }
  }
  
  popup.style.left = (left + window.scrollX) + 'px';
  popup.style.top = (top + window.scrollY) + 'px';

  let arrowX = selCenterX - left;
  arrowX = Math.max(20, Math.min(W - 20, arrowX));
  popup.style.setProperty('--arrow-x', arrowX + 'px');
}

function showPopupAt(rect) {
  const wasHidden = !isPopupVisible();
  if (wasHidden) {
    // Start invisible but with display:flex so we can measure it
    popup.style.visibility = 'hidden';
    popup.style.opacity = '0';
    popup.classList.add('visible');
    // Force a layout reflow so offsetHeight is populated
    void popup.offsetHeight;
  }
  
  repositionPopup(rect);

  if (wasHidden) {
    // Now that it's positioned, make it visible. 
    // Opacity transition is handled by CSS if desired, 
    // or we just snap it on.
    popup.style.visibility = 'visible';
    popup.style.opacity = '1';
  }
}

let lastCloseTime = 0;
function hidePopup(clearSelection = false) {
  if (!isPopupVisible()) return;
  popup.classList.remove('visible');
  popupHistory.length = 0;
  popupOut.innerHTML = '';
  popupActions.innerHTML = '';
  popupForm.hidden = true;
  popupInput.value = '';
  lastLookup = null;
  lastCloseTime = Date.now();
  if (clearSelection) {
    try { window.getSelection()?.removeAllRanges(); } catch (e) {}
  }
}

function handleOutsideClick(e) {
  if (!isPopupVisible()) return;
  const t = e.target;
  if (t && popup.contains(t)) return;
  // Clear selection on left-click outside to prevent re-triggering.
  // Keep it for right-clicks to allow context menu (Copy, etc).
  const isLeftClick = e.button === 0 || e.button === undefined;
  hidePopup(isLeftClick);
}

// ============================================================
// LLM call + UI flow
// ============================================================
async function sendToLLM(text, metaLabel, followup, silent) {
  if (popupBusy) return;
  popupBusy = true;
  if (!silent) {
    if (metaLabel) popupWrite('[' + metaLabel + ']\n', 'meta');
    popupWrite('> ' + text + '\n', 'u');
  }
  popupHistory.push({ role: 'user', content: text });
  popupInput.disabled = true;

  let pending = popupWrite('...', 'sys');
  let replyDiv = null;
  let reply = '';

  let expectedScrollTop = -1;
  let userInterrupted = false;
  const SCROLL_TOLERANCE = 5;

  function ensureReply() {
    if (replyDiv) return;
    if (pending) { pending.remove(); pending = null; }
    replyDiv = popupWrite('', 'a', { scroll: false });
    replyDiv.classList.add('cursor');
    expectedScrollTop = -1;
    userInterrupted = false;
  }

  function scrollFollowReply() {
    if (userInterrupted || !replyDiv) return;
    requestAnimationFrame(() => {
      if (userInterrupted || !replyDiv) return;
      try {
        if (expectedScrollTop >= 0
            && Math.abs(popupOut.scrollTop - expectedScrollTop) > SCROLL_TOLERANCE) {
          userInterrupted = true;
          return;
        }
        const containerRect = popupOut.getBoundingClientRect();
        const replyRect = replyDiv.getBoundingClientRect();
        const replyTopOffset = replyRect.top - containerRect.top + popupOut.scrollTop;
        const maxScroll = popupOut.scrollHeight - popupOut.clientHeight;
        const target = Math.min(
          Math.max(0, maxScroll),
          Math.max(0, replyTopOffset - 4),
        );
        popupOut.scrollTop = target;
        expectedScrollTop = popupOut.scrollTop;
      } catch {}
    });
  }

  try {
    let attempts = 0;
    while (attempts < MODELS.length) {
      try {
        if (followup) renderActionsBar(followup.phrase, followup.context);
        for await (const chunk of llmStream(popupHistory, `Đừng dùng bảng để format. Hãy trả lời ngắn gọn, súc tích`)) {
          ensureReply();
          reply += chunk;
          replyDiv.innerHTML = renderMarkdown(reply.trim());
          repositionPopup();
          scrollFollowReply();
        }
        if (!reply) {
          if (pending) pending.remove();
          popupWrite('(no response)\n\n', 'e');
          popupHistory.pop();
        } else {
          replyDiv.classList.remove('cursor');
          popupHistory.push({ role: 'assistant', content: reply });
        }
        break; // Success
      } catch (err) {
        const isRateLimit = err.message.includes('429') || err.message.toLowerCase().includes('rate limit');
        if (isRateLimit && attempts < MODELS.length - 1) {
          attempts++;
          settings.selectedModelIdx = (settings.selectedModelIdx + 1) % MODELS.length;
          chrome.storage.local.set({ selectedModelIdx: settings.selectedModelIdx });
          
          if (pending) pending.remove();
          pending = popupWrite(`Rate limit. Trying ${MODELS[settings.selectedModelIdx].name}...`, 'sys');
          
          if (replyDiv) {
            replyDiv.remove();
            replyDiv = null;
          }
          reply = '';
          continue;
        }

        if (pending) pending.remove();
        if (replyDiv && reply) {
          replyDiv.classList.remove('cursor');
          replyDiv.innerHTML = renderMarkdown(reply) + '\n';
          popupHistory.push({ role: 'assistant', content: reply });
        } else if (replyDiv) {
          replyDiv.remove();
          popupHistory.pop();
        } else {
          popupHistory.pop();
        }
        popupWrite('error: ' + err.message + '\n\n', 'e');
        break;
      }
    }
  } finally {
    popupBusy = false;
    popupInput.disabled = false;
  }
}

function renderActionsBar(phrase, context) {
  popupActions.innerHTML = '';
  const ctxNote = context && context !== phrase ? ' Context: "' + context + '".' : '';
  const formatInstructions = 'Tuân thủ format sau 100%, không thay thế bất kì từ chữ gì trừ chữ trong [], văn bản trong [] là các chỉ dẫn, thay thế chúng cùng [] với các thông tin tương ứng';

  [3].forEach(n => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = 'deep';
    a.title = `Re-run with ${n} sentences of context`;
    a.onclick = async (e) => {
      e.preventDefault();
      if (popupBusy || !lastLookup) return;
      const context = extractContextFromRange(lastLookup.range, n);
      const prompt = `Hãy phân tích từ/cụm từ được đánh dấu dựa trên hiểu biết cá nhân. Nhiều nhất là 50 từ, viết liền mạch không xuống dòng:
      TỪ/CỤM TỪ: ${phrase}
      NGỮ CẢNH: ${context}`
      sendToLLM(prompt, null, null, true);
    };
    popupActions.appendChild(a);
  });

  if (phrase.trim().split(' ').length > 1) return;

  const items = [
    ['syn', `Liệt kê một số từ đồng nghĩa với nghĩa của <${phrase}> trong <${ctxNote}>.
    So sánh ngắn gọn sự khác biệt giữa <${phrase}>, ${formatInstructions}:
    **SYNONYM**:
    [synonyms, one each line starting with •, nuance and example, the example should be itatlic].
    `, 'Synonyms'],
    ['ant', `List a few antonyms of <${phrase}> in <${ctxNote}> using this format, ${formatInstructions}: **ANTONYM**: [antonyms separated by comma]. Be concise.`, 'Antonyms'],
    ['ex',  `Give 3 short example sentences using <${phrase}> with the same meaning as <${phrase}> in ${ctxNote}, make the examples as diverge as possible using this format, ${formatInstructions}:
**EXAMPLE**:
3 examples one each line starting with •, the keyword should be bold]`, 'Examples'],
    ['use', `Độ thông dụng của ${phrase} trong tiếng anh hiện đại là bao nhiêu (thang 1-100). Be concise. Using this format: **USAGE**: mức dộ - register`, 'Usage frequency'],
    ['ety', `Giải thích ngắn gọn etymology của <${phrase}> sử dụng mẫu sau: **ETYMOLOGY**: etymology.`, 'Etymology'],
  ];
  items.forEach(([label, q, longLabel]) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = label;
    a.title = longLabel;
    a.onclick = (e) => {
      e.preventDefault();
      if (popupBusy) return;
      a.classList.add('used');
      sendToLLM(q, longLabel + ': "' + phrase + '"', null, true);
    };
    popupActions.appendChild(a);
  });
}

function extractContextFromRange(range, totalSentences) {
  const total = Math.max(1, totalSentences | 0);
  let node = range.startContainer;
  if (node.nodeType === 3) node = node.parentNode;
  let block = node;
  const blockTags = new Set(['P','DIV','LI','BLOCKQUOTE','SECTION','ARTICLE','BODY','TD','PRE']);
  while (block && !blockTags.has(block.tagName) && block.parentNode) block = block.parentNode;
  if (!block) block = node;
  const blockText = block.textContent || '';

  const pre = range.cloneRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  const startOff = pre.toString().length;

  const post = range.cloneRange();
  post.selectNodeContents(block);
  post.setStart(range.endContainer, range.endOffset);
  const endOff = blockText.length - post.toString().length;

  const SENT = '.!?\n';
  let b = endOff;
  while (b < blockText.length && !SENT.includes(blockText[b])) b++;
  if (b < blockText.length) b++;

  let curStart = startOff;
  while (curStart > 0 && !SENT.includes(blockText[curStart - 1])) curStart--;

  const wantPrev = total - 1;
  let a = curStart;
  let sentBoundaries = 0;
  while (a > 0 && sentBoundaries < wantPrev) {
    a--;
    if (SENT.includes(blockText[a])) sentBoundaries++;
  }
  while (a < blockText.length && (SENT.includes(blockText[a]) || /\s/.test(blockText[a]))) a++;

  return blockText.slice(a, b).replace(/\s+/g, ' ').trim();
}

function doLookup(phrase, range, sentenceCount) {
  const context = extractContextFromRange(range, sentenceCount);
  const local = context && context !== phrase ? context : '';

  popupHistory.length = 0;
  popupOut.innerHTML = '';
  popupActions.innerHTML = '';
  popupForm.hidden = true;

  const is_a_word = phrase.trim().split(' ').length == 1
  const prompt = is_a_word
    ? `Nhiệm vụ: Tra từ **${phrase}** xuất hiện trong đoạn văn sau và trả về đúng theo định dạng quy định.

Đoạn văn ngữ cảnh:
"""
${local}
"""

Định dạng đầu ra BẮT BUỘC (chỉ trả về đúng dòng này, không thêm bất kỳ nội dung nào khác):
**${phrase}** /IPA/:  Nghĩa

Quy tắc:
- Chỉ dịch từ "${phrase}", KHÔNG dịch cả đoạn văn
- /IPA/: phiên âm IPA chuẩn của từ "${phrase}"
- Nghĩa: nghĩa của TỪ "${phrase}" ngữ cảnh
- KHÔNG viết thêm giải thích, tiêu đề, hay bất kỳ văn bản nào ngoài đúng 1 dòng định dạng trên

Ví dụ output hợp lệ:
**example** /ɪɡˈzɑːmpl/: ví dụ`
    : `Trong câu sau: "${local}"
Chỉ dịch đúng đoạn này (không dịch cả câu): "${phrase}"

Ví dụ — nếu đoạn cần dịch là "break a leg", output đúng là:
chúc may mắn`
  const ctxLabel = sentenceCount > 1 ? ` (ctx: ${sentenceCount})` : '';
  sendToLLM(prompt, `meaning: "${phrase}"${ctxLabel}`, { phrase, context: local }, true);
}

function fireLookupForSelection(sel, doc) {
  if (popupBusy) return;
  if (isPopupVisible()) return;
  if (!sel || sel.isCollapsed) return;
  const phrase = sel.toString().trim();
  if (!phrase || phrase.length > 1000) return;

  let range;
  try { range = sel.getRangeAt(0); } catch { return; }

  const rect = range.getBoundingClientRect();
  const viewportRect = {
    left:   rect.left,
    top:    rect.top,
    right:  rect.right,
    bottom: rect.bottom,
    width:  rect.width,
    height: rect.height,
  };

  const savedRange = range.cloneRange();
  lastLookup = { phrase, range: savedRange, doc };

  showPopupAt(viewportRect);
  doLookup(phrase, savedRange, settings.contextSentences);
}

// Initializing
chrome.storage.local.get(['selectedModelIdx', 'contextSentences', 'apiKeys'], (res) => {
  if (res.selectedModelIdx !== undefined) settings.selectedModelIdx = res.selectedModelIdx;
  if (res.contextSentences !== undefined) settings.contextSentences = res.contextSentences;
  if (res.apiKeys !== undefined) settings.apiKeys = res.apiKeys;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.selectedModelIdx) settings.selectedModelIdx = changes.selectedModelIdx.newValue;
  if (changes.contextSentences) settings.contextSentences = changes.contextSentences.newValue;
  if (changes.apiKeys) settings.apiKeys = changes.apiKeys.newValue;
});

$('llm-popup-close').addEventListener('click', hidePopup);
$('llm-popup-toggle-input').addEventListener('click', () => {
  popupForm.hidden = !popupForm.hidden;
  if (!popupForm.hidden) popupInput.focus();
});

document.addEventListener('mousedown',  handleOutsideClick);
document.addEventListener('touchstart', handleOutsideClick, { passive: true });
document.addEventListener('pointerdown', handleOutsideClick);

popupForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = popupInput.value.trim();
  if (!text) return;
  popupInput.value = '';
  sendToLLM(text, null, null, false);
});

document.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    fireLookupForSelection(sel, document);
  }, 10);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isPopupVisible()) {
    hidePopup();
  }
});
