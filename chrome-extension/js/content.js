// ============================================================
// LLM Translator Content Script
// ============================================================

// The model list lives in js/models.js and is edited from the popup —
// SEED_MODELS on first run, whatever the user has added from then on.
let settings = {
  models: [],
  selectedModelId: null,
  contextSentences: 1,
  // Popup word spacing, in px — set from the slider in the extension popup.
  // The reader has the same setting under Settings → Lookup Popup.
  popupWordSpacing: 0,
  apiKeys: { GEMINI_API_KEY: '', GROQ_API_KEY: '' },
};

const MAX_TOKENS = 1024;
// Longest selection that may start a lookup. Past this the selection is simply
// ignored: no popup, no LLM call. Same cap as the reader.
const MAX_SELECTION_CHARS = 100;

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

// Popup font picks: Iosevka on the portrait ~2K monitor, Consolas elsewhere.
function isVertical2k() {
  // Portrait + ~2K. Long side covers the panel both at native 2560 and at
  // Windows DPI-scaled values (e.g. 125% -> 2048), while excluding 1080p portrait.
  const w = screen.width, h = screen.height, long = Math.max(w, h);
  return h > w && long >= 2000 && long <= 2600;
}
function applyFontMode() {
  document.documentElement.classList.toggle('llm-vert2k', isVertical2k());
}
applyFontMode();
window.addEventListener('resize', applyFontMode);

// Set on our own container rather than the page's <html>, so nothing of ours
// leaks into the host page. `all: initial` on #llm-popup doesn't reset custom
// properties, so it still reaches #llm-popup-out.
function applyWordSpacing() {
  container.style.setProperty('--llm-word-spacing', settings.popupWordSpacing + 'px');
}

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
  // Per-model, not guessed from the name: a model that doesn't support
  // reasoning_effort rejects the whole request if it is sent one.
  if (cfg.reasoning && cfg.reasoning !== 'off') {
    body.reasoning_effort = cfg.reasoning;
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  for await (const evt of streamSSE(providerOf(cfg).url, headers, body)) {
    const text = evt?.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

async function* streamGoogle(cfg, messages, system, apiKey) {
  const url = `${providerOf(cfg).url}/v1/models/${cfg.model}:streamGenerateContent?alt=sse`;
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
  const cfg = currentModel(settings.models, settings.selectedModelId);
  if (!cfg) throw new Error('no model configured — add one in Extension Settings');
  const provider = providerOf(cfg);
  const apiKey = (settings.apiKeys[provider.keyRef] || '').trim();
  if (!apiKey) throw new Error(`missing ${provider.keyRef} — paste it in Extension Settings`);
  const fn = VENDORS[provider.format];
  if (!fn) throw new Error(`unknown vendor format: ${provider.format}`);
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
  spentActions.clear();          // new word — every action is available again
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
// `heading` is the section label the popup draws above the answer (SYNONYM,
// ANTONYM, …). It used to be the model's job — every action prompt ended with
// a mandatory `**SYNONYM**:` line — which meant the label was missing or
// mangled whenever the model ignored the format. The popup owns it now, so the
// prompts ask for the body alone.
// `actionKey` ties this answer back to the action link that started it, so a
// second click on that (now spent) link scrolls to the answer instead of asking
// the model for it all over again — see renderActionsBar / scrollToSpent.
async function sendToLLM(text, metaLabel, followup, silent, heading, actionKey) {
  if (popupBusy) return;
  popupBusy = true;
  const firstIndex = popupOut.children.length;
  if (!silent) {
    if (metaLabel) popupWrite('[' + metaLabel + ']\n', 'meta');
    popupWrite('> ' + text + '\n', 'u');
  }
  if (heading) popupWrite(heading, 'title');
  // The heading is the first thing written and outlives the transient '...'
  // spinner, so it is the anchor we scroll back to.
  if (actionKey && spentActions.has(actionKey)) {
    spentActions.set(actionKey, popupOut.children[firstIndex] || null);
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
    // On a 429, fall through to the next model in the list and keep it
    // selected — the list is user-editable, so its length is not a constant.
    let attempts = 0;
    while (attempts === 0 || attempts < settings.models.length) {
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
        if (isRateLimit && attempts < settings.models.length - 1) {
          attempts++;
          const cur = currentModel(settings.models, settings.selectedModelId);
          const idx = settings.models.indexOf(cur);
          const next = settings.models[(idx + 1) % settings.models.length];
          settings.selectedModelId = next.id;
          chrome.storage.local.set({ selectedModelId: settings.selectedModelId });

          // Swap models silently — no "Rate limit. Trying X..." line. Which
          // model ends up answering isn't something you can act on mid-lookup,
          // and the notice pushed the actual answer down the transcript.
          if (replyDiv) {
            replyDiv.remove();
            replyDiv = null;
          }
          // ensureReply() removes `pending` the moment the first chunk lands,
          // so a model that started answering and then 429'd leaves nothing
          // on screen. Put the plain spinner back for the retry.
          if (!pending) pending = popupWrite('...', 'sys');
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

// An action that has already run keeps its answer in the transcript below, so a
// second click scrolls to it rather than re-asking the model. Keyed by label,
// mapped to the element its answer starts at; a map rather than a flag on the
// element because renderActionsBar rebuilds the whole row from scratch on every
// reply, which would otherwise hand back a fresh, unused-looking button.
const spentActions = new Map();

function markSpent(a) {
  a.classList.add('used');
}

// Scrolls the transcript so a spent action's answer starts just below the top.
function scrollToSpent(key) {
  const el = spentActions.get(key);
  if (!el || !el.isConnected) return;
  const top = el.getBoundingClientRect().top
            - popupOut.getBoundingClientRect().top
            + popupOut.scrollTop;
  popupOut.scrollTo({ top: Math.max(0, top - 4), behavior: 'smooth' });
}

function renderActionsBar(phrase, context) {
  popupActions.innerHTML = '';
  const ctxNote = context && context !== phrase ? ' Context: "' + context + '".' : '';
  const formatInstructions = 'Tuân thủ format sau 100%, không thay thế bất kì từ chữ gì trừ chữ trong [], văn bản trong [] là các chỉ dẫn, thay thế chúng cùng [] với các thông tin tương ứng';

  // The popup prints the section label itself (see sendToLLM's `heading`), so
  // a model that also prints one would double it up.
  const noHeading = 'KHÔNG in tiêu đề hay nhãn phần (kiểu **SYNONYM**:) — chỉ trả về nội dung.';

  [3].forEach(n => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = 'deep';
    a.title = `Re-run with ${n} sentences of context`;
    if (spentActions.has('deep')) markSpent(a);
    a.onclick = async (e) => {
      e.preventDefault();
      if (spentActions.has('deep')) { scrollToSpent('deep'); return; }
      if (popupBusy || !lastLookup) return;
      spentActions.set('deep', null);
      markSpent(a);
      const context = extractContextFromRange(lastLookup.range, n);
      const prompt = `Hãy phân tích từ/cụm từ được đánh dấu dựa trên hiểu biết cá nhân. Nhiều nhất là 50 từ, viết liền mạch không xuống dòng:
      TỪ/CỤM TỪ: ${phrase}
      NGỮ CẢNH: ${context}`
      sendToLLM(prompt, null, null, true, 'DEEP', 'deep');
    };
    popupActions.appendChild(a);
  });

  if (phrase.trim().split(' ').length > 1) return;

  // Synonyms are only worth listing if you can tell them apart, so every entry
  // is forced onto the same three axes (register / intensity / connotation),
  // has to name the ONE thing that shifts against the headword, and has to
  // earn its place with a sentence the headword would be wrong in.
  const synCtx = context && context !== phrase
    ? `\n\nCâu chứa từ:\n"""\n${context}\n"""`
    : '';
  const synonymPrompt = `Nhiệm vụ: liệt kê 5 từ đồng nghĩa của <${phrase}>, đúng nét nghĩa mà nó mang ở đây.${synCtx}

Định dạng đầu ra BẮT BUỘC — không thêm gì trước hay sau khối này:

• **${phrase}** — [văn phong] · [cường độ n/5] · [sắc thái] · gốc: [nét nghĩa trung tính của chính nó]
  *[câu tiếng Anh dùng ${phrase} một cách điển hình]*
• **[từ]** — [văn phong] · [cường độ n/5] · [sắc thái] · khác: [đổi gì so với ${phrase}]
  *[câu tiếng Anh chỉ hợp với từ này]* — thay bằng "${phrase}" thì [hỏng ở đâu]
**TRỤC**: [cả 5 từ xếp trên trục khác biệt chính, ngăn bằng dấu <]

Quy tắc:
- Khối trên là bắt buộc và đầy đủ: yêu cầu "ngắn gọn" ở chỗ khác không được phép cắt bớt gạch đầu dòng hay bỏ trống ô nào.
- Đúng 5 gạch đầu dòng, mỗi gạch bắt đầu bằng •, và "${phrase}" là gạch ĐẦU TIÊN, làm mốc so sánh cho 4 từ còn lại.
- 4 từ còn lại xếp từ gần nghĩa nhất đến xa nhất.
- [văn phong]: trang trọng / trung tính / đời thường / lóng / chuyên ngành.
- [cường độ n/5]: 1 nhẹ nhất, 5 mạnh nhất, chấm trên cùng một thang với "${phrase}".
- [sắc thái]: tích cực / trung tính / tiêu cực.
- "khác:" nêu ĐÚNG MỘT điểm khác cụ thể, và mỗi từ phải khác ở một điểm KHÁC NHAU — không lặp cùng một kiểu khác biệt cho hai từ.
- CẤM mô tả chung chung kiểu "trang trọng hơn", "mạnh hơn", "ít dùng hơn" nếu không nói rõ: hơn ở chỗ nào, dùng trong tình huống nào, hay đi với từ nào.
- Nếu một từ hay bị tưởng là thay thế được cho "${phrase}", mở phần "khác:" bằng "dễ nhầm:".
- Ví dụ của 4 từ còn lại phải là câu mà CHỈ từ đó hợp: thay bằng "${phrase}" thì sai nghĩa hoặc nghe gượng, và phải nói rõ hỏng ở đâu sau dấu gạch.
- Từ đồng nghĩa và câu ví dụ bằng TIẾNG ANH; mọi phần mô tả bằng TIẾNG VIỆT.
- Câu ví dụ in nghiêng bằng đúng một cặp dấu sao: *như thế này*.
- Dòng **TRỤC** cuối cùng xếp cả 5 từ trên trục khác biệt chính (thường là cường độ), ví dụ: annoyed < angry < furious.
- KHÔNG dùng bảng, KHÔNG chèn dòng trống giữa các gạch đầu dòng, KHÔNG mở bài hay kết luận.
- ${noHeading}`;

  // [button label, prompt, tooltip, heading drawn above the answer]
  const items = [
    ['syn', synonymPrompt, 'Synonyms', 'SYNONYM'],
    ['ant', `List a few antonyms of <${phrase}> in <${ctxNote}> using this format, ${formatInstructions}: [antonyms separated by comma]. Be concise. ${noHeading}`, 'Antonyms', 'ANTONYM'],
    ['ex',  `Give 3 short example sentences using <${phrase}> with the same meaning as <${phrase}> in ${ctxNote}, make the examples as diverge as possible using this format, ${formatInstructions}:
[3 examples one each line starting with •, the keyword should be bold]
${noHeading}`, 'Examples', 'EXAMPLE'],
    ['use', `Độ thông dụng của ${phrase} trong tiếng anh hiện đại là bao nhiêu (thang 1-100). Be concise. Using this format: mức dộ - register. ${noHeading}`, 'Usage frequency', 'USAGE'],
    ['ety', `Giải thích ngắn gọn etymology của <${phrase}>. Chỉ trả về phần etymology. ${noHeading}`, 'Etymology', 'ETYMOLOGY'],
  ];
  items.forEach(([label, q, longLabel, heading]) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = label;
    a.title = longLabel;
    if (spentActions.has(label)) markSpent(a);
    a.onclick = (e) => {
      e.preventDefault();
      if (spentActions.has(label)) { scrollToSpent(label); return; }
      if (popupBusy) return;
      spentActions.set(label, null);
      markSpent(a);
      sendToLLM(q, longLabel + ': "' + phrase + '"', null, true, heading, label);
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
  spentActions.clear();          // new word — every action is available again
  popupForm.hidden = true;

  const is_a_word = phrase.trim().split(' ').length == 1
  const kind = is_a_word ? 'từ' : 'cụm';
  const ctxBlock = local ? `

Câu chứa ${kind}:
"""
${local}
"""` : '';
  const ctxRule = local
    ? (is_a_word
        ? `- Câu ngữ cảnh CHỈ dùng để chọn đúng nét nghĩa và đúng từ loại của từ khi từ có nhiều nghĩa — không phải để dịch.
`
        : `- Câu ngữ cảnh CHỈ dùng để chọn đúng nét nghĩa của cụm — không phải để dịch.
`)
    : '';
  const prompt = is_a_word
    ? `Nhiệm vụ: Tra nghĩa của riêng từ **${phrase}**${local ? ' trong câu dưới đây' : ''}.${ctxBlock}

Định dạng đầu ra BẮT BUỘC (chỉ đúng 1 dòng, không thêm bất kỳ nội dung nào khác):
**${phrase}** /IPA/: Nghĩa

Quy tắc:
- Chỉ trả nghĩa của riêng từ "${phrase}". KHÔNG dịch câu, KHÔNG diễn giải câu, KHÔNG đưa chữ nào khác của câu vào phần Nghĩa.
${ctxRule}- Nếu từ nằm trong một thành ngữ hay cụm cố định, VẪN chỉ trả nghĩa của riêng từ đó, KHÔNG trả nghĩa của cả thành ngữ.
- Nghĩa: ngắn gọn như một mục từ điển (1-4 từ tiếng Việt); tối đa 2 nghĩa gần nhau, ngăn cách bằng dấu phẩy.
- /IPA/: phiên âm IPA của từ "${phrase}" đúng với từ loại đã chọn.
- KHÔNG thêm giải thích, tiêu đề, ví dụ, hay bất kỳ văn bản nào ngoài đúng 1 dòng trên.

Ví dụ output hợp lệ:
Câu "The bank was closed." — từ "bank" → **bank** /bæŋk/: ngân hàng
Câu "We sat on the river bank." — từ "bank" → **bank** /bæŋk/: bờ, bờ sông
Câu "Break a leg tonight!" — từ "leg" → **leg** /leɡ/: chân`
    : `Nhiệm vụ: Tra nghĩa của riêng cụm **${phrase}**${local ? ' trong câu dưới đây' : ''}.${ctxBlock}

Định dạng đầu ra BẮT BUỘC (chỉ đúng 1 dòng, không thêm bất kỳ nội dung nào khác):
**${phrase}**: Nghĩa

Quy tắc:
- Chỉ trả nghĩa của riêng cụm "${phrase}". KHÔNG dịch cả câu, KHÔNG đưa phần nào của câu nằm ngoài cụm vào phần Nghĩa.
${ctxRule}- Nếu cụm là thành ngữ hay cụm cố định, trả nghĩa thành ngữ của nó; nếu không, trả nghĩa sát nhất của cụm.
- Nghĩa: ngắn gọn như một mục từ điển, KHÔNG phải một câu hoàn chỉnh.
- KHÔNG thêm phiên âm, giải thích, tiêu đề, ví dụ, hay bất kỳ văn bản nào ngoài đúng 1 dòng trên.

Ví dụ output hợp lệ:
Câu "Break a leg tonight!" — cụm "break a leg" → **break a leg**: chúc may mắn
Câu "She gave up smoking last year." — cụm "gave up" → **gave up**: từ bỏ, cai`
  const ctxLabel = sentenceCount > 1 ? ` (ctx: ${sentenceCount})` : '';
  sendToLLM(prompt, `meaning: "${phrase}"${ctxLabel}`, { phrase, context: local }, true);
}

function fireLookupForSelection(sel, doc) {
  if (popupBusy) return;
  if (isPopupVisible()) return;
  if (!sel || sel.isCollapsed) return;
  const phrase = sel.toString().trim();
  if (!phrase || phrase.length > MAX_SELECTION_CHARS) return;

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
chrome.storage.local.get([...MODEL_STORE_KEYS, 'contextSentences', 'popupWordSpacing', 'apiKeys'], (res) => {
  const store = readModelStore(res);
  settings.models = store.models;
  settings.selectedModelId = store.selectedModelId;
  if (res.contextSentences !== undefined) settings.contextSentences = res.contextSentences;
  if (res.popupWordSpacing !== undefined) settings.popupWordSpacing = res.popupWordSpacing;
  if (res.apiKeys !== undefined) settings.apiKeys = res.apiKeys;
  applyWordSpacing();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.models) settings.models = normaliseModels(changes.models.newValue);
  if (changes.selectedModelId) settings.selectedModelId = changes.selectedModelId.newValue;
  if (changes.contextSentences) settings.contextSentences = changes.contextSentences.newValue;
  if (changes.popupWordSpacing) {
    settings.popupWordSpacing = changes.popupWordSpacing.newValue;
    applyWordSpacing();
  }
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
