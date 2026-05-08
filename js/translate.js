// ============================================================
// Translation popup, LLM streaming, selection→lookup, TOC builder.
//
// Fix #3 — UI overhaul:
//   * Theme-aware colors (CSS already handles this via var(--bg) etc).
//   * 5/10/15/syn/ant/ex/use/ety buttons live in the popup top bar
//     (#popup-actions) instead of inline below the response, in one
//     horizontally-scrollable row alongside the close + input-toggle icons.
//   * scroll-to-top of the latest answer uses requestAnimationFrame +
//     getBoundingClientRect for cross-browser correctness.
//   * Popup closing is instant (CSS uses display:none/flex, no fade).
// ============================================================

import { openBookFromDb } from './reader.js';
import {
  $, escapeHtml, settings, runtime,
  MODELS, MAX_TOKENS, attachPullToDismiss,
} from './state.js';

const popupWrapper = $('popup-wrapper')
const popup = $('popup');
const popupOut = $('popup-out');
const popupForm = $('popup-form');
const popupInput = $('popup-input');
const popupActions = $('popup-actions');
const tocList = $('toc-list');
const viewer = $('viewer');
const reader = $('reader');

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
  console.log(cfg);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const reasoningEffort = 'none'
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
  const url = `${cfg.url}/models/${cfg.model}:streamGenerateContent?alt=sse`;
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
  if (!apiKey) throw new Error(`missing ${cfg.keyRef} — paste it in Settings`);
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

const translateBubble = $('translate-bubble');
const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

// Captured when the bubble is shown (before iOS can clear the iframe selection).
let capturedBubbleText  = null;   // raw text — immune to Range/DOM state
let capturedBubbleRange = null;
let capturedBubbleMeta  = null;

// Timestamp of the last showPopupAt() call — used to ignore synthetic
// mousedown/pointerdown events that arrive ~300ms after a touch and would
// immediately dismiss the popup.
let popupOpenedAt = 0;

export function isPopupVisible() {
  return popupWrapper.classList.contains('visible');
}

function popupWrite(text, cls, opts) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  popupOut.appendChild(div);
  if (!opts || opts.scroll !== false) {
    popupOut.scrollTop = popupOut.scrollHeight;
  }
  return div;
}

function renderMarkdown(text) {
  let h = escapeHtml(text);
  h = h.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  return h;
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 599px), (pointer: coarse)').matches;
}

export function showPopupAt(rect) {
  popupOpenedAt = Date.now();
  if (isMobileViewport()) {
    popup.classList.add('mobile');
    popup.classList.remove('pos-above', 'pos-below');
    popup.style.left = '';
    popup.style.right = '';
    popup.style.top = '';
    popup.style.width = '';
    popupWrapper.classList.add('visible');
    clearAllSelections();
    return;
  }
  popup.classList.remove('mobile');
  // Make sure offsetHeight is meaningful for height-based placement.
  const wasHidden = !popup.classList.contains('visible');
  if (wasHidden) {
    popupWrapper.classList.add('visible');
  }
  const W = popup.offsetWidth || 420;
  const H = popup.offsetHeight || 200;
  if (wasHidden) {
    popupWrapper.classList.remove('visible');
  }
  const margin = 12;
  const gap = 12;
  let left = rect.left + rect.width / 2 - W / 2;
  left = Math.max(margin, Math.min(window.innerWidth - W - margin, left));
  // Place above the selection when its center is below the viewport midpoint —
  // keeps the popup from getting pushed off the bottom of the screen.
  const selCenterY = rect.top + rect.height / 2;
  const placeAbove = selCenterY > window.innerHeight / 2;
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
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popup.classList.toggle('pos-above', placeAbove);
  popup.classList.toggle('pos-below', !placeAbove);
  const arrowX = rect.left + rect.width / 2 - left;
  popup.style.setProperty('--arrow-x', Math.max(20, Math.min(W - 20, arrowX)) + 'px');
  popupWrapper.classList.add('visible');
  clearAllSelections();
}

function clearAllSelections() {
  try {
    viewer.querySelectorAll('iframe').forEach(ifr => {
      try { ifr.contentWindow && ifr.contentWindow.getSelection().removeAllRanges(); } catch {}
    });
    window.getSelection && window.getSelection().removeAllRanges();
  } catch {}
}

export function hidePopup() {
  popupWrapper.classList.remove('visible');
  popupHistory.length = 0;
  popupOut.innerHTML = '';
  popupActions.innerHTML = '';
  popupForm.hidden = true;
  popupInput.value = '';
  lastLookup = null;
  hideBubble();
  // Clear stray selections inside iframes so the bubble doesn't immediately
  // re-appear from the same selection on mobile.
  try {
    viewer.querySelectorAll('iframe').forEach(ifr => {
      try { ifr.contentWindow && ifr.contentWindow.getSelection().removeAllRanges(); } catch {}
    });
  } catch {}
}

// ============================================================
// Outside-click / Escape dismissal
// ============================================================
function handleOutsideClick(e) {
  if (!isPopupVisible()) return;
  // Ignore synthetic mouse/pointer events that arrive ~300ms after a touch
  // on the bubble — they'd immediately close the popup we just opened.
  if (Date.now() - popupOpenedAt < 400) return;
  const t = e.target;
  if (t && popup.contains(t)) return;
  hidePopup();
}

export function attachOutsideClickToFrame(doc) {
  if (!doc) return;
  const fire = () => { if (isPopupVisible()) hidePopup(); };
  const onTap = () => {
    setTimeout(() => {
      const sel = doc.getSelection && doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      fire();
    }, 30);
  };
  doc.addEventListener('mousedown',   onTap, { passive: true });
  doc.addEventListener('touchstart',  onTap, { passive: true });
  doc.addEventListener('pointerdown', onTap, { passive: true });
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

  // Capped auto-scroll while the reply streams in.
  //   target = min(scrollHeight - clientHeight, replyTop - 4)
  // Short answer → scroll-to-bottom (whole answer visible).
  // Long answer → first line of current answer pinned 4px below the top,
  //               new content streams in below it.
  // If the user manually scrolls during streaming we latch userInterrupted
  // and stop following for the rest of this reply; the flag resets in
  // ensureReply() when the next reply begins.
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
        // If the user scrolled since our last programmatic set, stop following.
        if (expectedScrollTop >= 0
            && Math.abs(popupOut.scrollTop - expectedScrollTop) > SCROLL_TOLERANCE) {
          userInterrupted = true;
          return;
        }
        const containerRect = popupOut.getBoundingClientRect();
        const replyRect = replyDiv.getBoundingClientRect();
        // Offset of replySpan's top within the scrollable content.
        const replyTopOffset = replyRect.top - containerRect.top + popupOut.scrollTop;
        const maxScroll = popupOut.scrollHeight - popupOut.clientHeight;
        const target = Math.min(
          Math.max(0, maxScroll),
          Math.max(0, replyTopOffset - 4),
        );
        popupOut.scrollTop = target;
        // Read back: browsers may clamp/round the actual stored value.
        expectedScrollTop = popupOut.scrollTop;
      } catch {}
    });
  }

  function preventPopupOutOfView() {
    requestAnimationFrame(() => {
      const margin = 10;
      const rect = popup.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - margin) {
        const newTop = window.innerHeight - rect.height - margin;
        popup.style.top = Math.max(margin, newTop) + 'px';
      }
    });
  }

  try {
    for await (const chunk of llmStream(popupHistory, `I'm in a tight space right now so don't format using tables. Be concise`)) {
      ensureReply();
      reply += chunk;
      replyDiv.innerHTML = renderMarkdown(reply.trim());
      scrollFollowReply();
      preventPopupOutOfView()
    }
    if (!reply) {
      if (pending) pending.remove();
      popupWrite('(no response)\n\n', 'e');
      popupHistory.pop();
    } else {
      replyDiv.classList.remove('cursor');
      popupHistory.push({ role: 'assistant', content: reply });
      if (followup) renderActionsBar(followup.phrase, followup.context);
    }
  } catch (err) {
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
  } finally {
    popupBusy = false;
    popupInput.disabled = false;
  }
}

// Renders the action buttons into the top bar (#popup-actions),
// alongside the close + input-toggle icons. One scrollable row.
function renderActionsBar(phrase, context) {
  popupActions.innerHTML = '';
  const ctxNote = context && context !== phrase ? ' Context: "' + context + '".' : '';

  const formatInstructions = 'Văn bản trong [] là các chỉ dẫn, thay thế chúng cùng [] với các thông tin tương ứng';
  // [5] [10] [15] — re-run lookup with N sentences of context
  [5].forEach(n => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = String(n);
    a.title = `Re-run with ${n} sentences of context`;
    a.onclick = async (e) => {
      e.preventDefault();
      if (popupBusy || !lastLookup) return;
      const context = extractContextFromRange(lastLookup.range, n);
      const bookMetadata = await runtime.book.loaded.metadata;
      const prompt = `Bạn là nhà phân tích văn học, sử học. Hãy phân tích từ/cụm từ được đánh dấu dựa trên hiểu biết cá nhân và các thông tin sau, tối đa 50 từ:
      TÁC GIẢ: ${bookMetadata.creator}
      TÁC PHẨM: ${bookMetadata.title}
      TỪ/CỤM TỪ: ${phrase}
      NGỮ CẢNH: ${context}`
      sendToLLM(prompt, null, null, true);
    };
    popupActions.appendChild(a);
  });

  // Short-label follow-up queries
  if (phrase.trim().split(' ').length > 1) {
    return;
  }
  const items = [
    ['syn', `Liệt kê một số từ đồng nghĩa với nghĩa của <${phrase}> trong <${ctxNote}>.
    So sánh ngắn gọn sự khác biệt giữa <${phrase}> và các từ đồng nghĩa theo mẫu sau, ${formatInstructions}:
    **SYNONYM**:
    [synonyms, one each line starting with •, nuance and example, the example should be itatlic].
    `, 'Synonyms'],
    ['ant', `List a few antonyms of <${phrase}> in <${ctxNote}> using this format, ${formatInstructions}: **ANTONYM**: [antonyms separated by comma]. Be concise.`, 'Antonyms'],
    ['ex',  `Give 3 short example sentences using <${phrase}> with the same meaning as <${phrase}> in ${ctxNote}, make the examples as diverge as possible using this format, ${formatInstructions}:
**EXAMPLE**:
[3 examples one each line starting with •, the keyword should be bold]`, 'Examples'],
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

// ============================================================
// Selection → context extraction → lookup
// ============================================================
function extractContextFromRange(range, totalSentences) {
  if (!range) return '';
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

export function doLookup(phrase, range, sentenceCount) {
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
- Nghĩa: nghĩa của TỪ "${phrase}" đứng một mình (không phải nghĩa của cả cụm)
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

// capturedRange: pre-cloned Range from pointerdown — used on mobile where iOS
// may clear the iframe selection before the click event fires.
function fireLookupForSelection(sel, doc, iframe, capturedRange) {
  if (popupBusy) return;
  if (isPopupVisible()) return;

  let phrase, range;
  if (capturedRange) {
    phrase = capturedRange.toString().trim();
    range = capturedRange;
  } else {
    if (!sel || sel.isCollapsed) return;
    phrase = sel.toString().trim();
    try { range = sel.getRangeAt(0); } catch { return; }
  }
  if (!phrase || phrase.length > 1000) return;

  const rect = range.getBoundingClientRect();
  const ifrRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
  const viewportRect = {
    left:   rect.left   + ifrRect.left,
    top:    rect.top    + ifrRect.top,
    right:  rect.right  + ifrRect.left,
    bottom: rect.bottom + ifrRect.top,
    width:  rect.width,
    height: rect.height,
  };

  const savedRange = capturedRange || range.cloneRange();
  if (sel) { try { sel.removeAllRanges(); } catch {} }
  lastLookup = { phrase, range: savedRange, doc };
  hideBubble();

  showPopupAt(viewportRect);
  doLookup(phrase, savedRange, settings.contextSentences);
}

// Find the first iframe with a non-empty selection. Returns null if none.
function findActiveIframeSelection() {
  if (!runtime.rendition || reader.hidden) return null;
  const iframes = viewer.querySelectorAll('iframe');
  for (const ifr of iframes) {
    let win, doc;
    try { win = ifr.contentWindow; doc = ifr.contentDocument || (win && win.document); }
    catch { continue; }
    if (!win || !doc) continue;
    let sel;
    try { sel = win.getSelection(); } catch { continue; }
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      return { sel, doc, ifr };
    }
  }
  return null;
}

// ============================================================
// Per-iframe selection wiring.
//
// Desktop: auto-fire lookup on mouseup with a non-collapsed selection.
// Mobile: drive the bubble from a debounced selectionchange. During an
//   iOS handle drag, selectionchange fires constantly and the debounce
//   keeps resetting, so the bubble stays hidden until the selection has
//   been stable for `delay` ms. No touch-event gating — iOS swallows
//   touchend in some long-press flows and any flag tied to it gets
//   stuck.
// ============================================================

let bubbleSelDebounce = null;
function scheduleBubbleUpdate(delay = 200) {
  if (bubbleSelDebounce) clearTimeout(bubbleSelDebounce);
  bubbleSelDebounce = setTimeout(() => {
    bubbleSelDebounce = null;
    updateBubble();
  }, delay);
}

export function attachSelectionHandler(doc) {
  const win = doc.defaultView;
  const iframe = win ? win.frameElement : null;

  if (!isCoarsePointer) {
    doc.addEventListener('mouseup', () => {
      // Tiny delay so the browser has finalized the selection range.
      setTimeout(() => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed) return;
        fireLookupForSelection(sel, doc, iframe);
      }, 10);
    });
    return;
  }

  doc.addEventListener('selectionchange', () => scheduleBubbleUpdate());
}

// ============================================================
// Mobile path: bubble appears next to the active selection;
// tapping it fires the lookup explicitly.
// ============================================================
function hideBubble() {
  if (translateBubble) translateBubble.hidden = true;
}

function updateBubble() {
  if (!translateBubble) return;
  if (!isCoarsePointer) return;
  if (isPopupVisible() || popupBusy) { hideBubble(); return; }
  const found = findActiveIframeSelection();
  if (!found) { hideBubble(); return; }
  let range;
  try { range = found.sel.getRangeAt(0); } catch { hideBubble(); return; }
  const rect = range.getBoundingClientRect();
  const ifrRect = found.ifr.getBoundingClientRect();
  const selTop    = rect.top    + ifrRect.top;
  const selBottom = rect.bottom + ifrRect.top;
  const selCenterX = rect.left + ifrRect.left + rect.width / 2;

  // Snapshot everything now — iOS/Android clears the iframe selection when
  // the user taps the bubble, so we capture text + range + meta here while
  // the selection is still live. Text string is the safest primary source.
  try {
    capturedBubbleText  = found.sel.toString().trim();
    capturedBubbleRange = range.cloneRange();
    capturedBubbleMeta  = { doc: found.doc, ifr: found.ifr };
  } catch {
    capturedBubbleText  = null;
    capturedBubbleRange = null;
    capturedBubbleMeta  = null;
  }

  // Make visible first so we can measure. Position offscreen until measured
  // to avoid a frame of flicker at (0,0).
  translateBubble.style.left = '-9999px';
  translateBubble.style.top = '-9999px';
  translateBubble.hidden = false;
  const bw = translateBubble.offsetWidth;
  const bh = translateBubble.offsetHeight;

  const margin = 8;
  // Prefer below the selection — iOS's native action bar appears above,
  // so this avoids visual collision. Flip above if there's no room.
  const canBelow = selBottom + bh + margin <= window.innerHeight;
  const canAbove = selTop - bh - margin >= margin;
  let top;
  if (canBelow) {
    top = selBottom + margin;
  } else if (canAbove) {
    top = selTop - bh - margin;
  } else {
    top = Math.max(margin, window.innerHeight - bh - margin);
  }
  translateBubble.classList.toggle('bubble-below', canBelow);
  translateBubble.classList.toggle('bubble-above', !canBelow && canAbove);
  let left = selCenterX - bw / 2;
  left = Math.max(margin, Math.min(window.innerWidth - bw - margin, left));
  translateBubble.style.left = left + 'px';
  translateBubble.style.top = top + 'px';
}

function fireFromBubble() {
  const found = findActiveIframeSelection();
  if (!found) { hideBubble(); return; }
  fireLookupForSelection(found.sel, found.doc, found.ifr);
}

export function stopBubble() {
  if (bubbleSelDebounce) { clearTimeout(bubbleSelDebounce); bubbleSelDebounce = null; }
  hideBubble();
}

// ============================================================
// TOC builder (lives here because it needs rendition + drawer hide)
// ============================================================
export function buildToc(toc) {
  tocList.innerHTML = '';
  const render = (items, depth = 0) => {
    items.forEach(item => {
      const a = document.createElement('a');
      a.textContent = item.label.trim();
      a.style.paddingLeft = (depth * 16) + 'px';
      a.addEventListener('click', e => {
        e.preventDefault();
        if (runtime.rendition) runtime.rendition.display(item.href);
        document.dispatchEvent(new CustomEvent('reader:hideAllDrawers'));
      });
      tocList.appendChild(a);
      if (item.subitems?.length) render(item.subitems, depth + 1);
    });
  };
  render(toc);
  if (!toc.length) {
    tocList.innerHTML = '<p style="color:var(--chrome-fg);font-size:13px">No table of contents.</p>';
  }
}

// ============================================================
// Top-level wiring — popup buttons, form, outside clicks, sel change
// ============================================================
export function initTranslateEvents() {
  $('popup-close').addEventListener('click', hidePopup);
  $('popup-toggle-input').addEventListener('click', () => {
    popupForm.hidden = !popupForm.hidden;
    if (!popupForm.hidden) popupInput.focus();
  });

  // Pull-down-to-dismiss when the result area is scrolled to the top
  attachPullToDismiss(popup, () => popupOut, hidePopup);

  popupWrapper.addEventListener('mousedown',  handleOutsideClick);
  popupWrapper.addEventListener('touchstart', handleOutsideClick, { passive: true });
  popupWrapper.addEventListener('pointerdown', handleOutsideClick);

  popupForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = popupInput.value.trim();
    if (!text) return;
    popupInput.value = '';
    sendToLLM(text, null, null, false);
  });

  // Bubble — mobile path. Fires the lookup explicitly on tap.
  // capturedBubbleRange / capturedBubbleMeta are module-scope and set by
  // updateBubble() so the range is available even if iOS cleared the selection.
  //
  // We use touchend (not click) because:
  //   1. touchend fires immediately when the finger lifts, before any 200ms
  //      polling tick can run updateBubble() → hideBubble() → hidden=true,
  //      which would cancel a pending click on iOS.
  //   2. It avoids the ~300ms synthetic-click delay on iOS.
  if (translateBubble) {
    translateBubble.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    translateBubble.addEventListener('mousedown',  e => e.stopPropagation());

    function fireBubbleLookup() {
      if (popupBusy || isPopupVisible()) return;
      const text  = capturedBubbleText;
      const range = capturedBubbleRange;
      const meta  = capturedBubbleMeta;
      capturedBubbleText  = null;
      capturedBubbleRange = null;
      capturedBubbleMeta  = null;
      if (text && meta) {
        // Use saved text string — immune to iOS/Android clearing the selection.
        // Range is kept for context extraction; rect doesn't matter on mobile
        // (bottom-sheet popup ignores position).
        lastLookup = { phrase: text, range, doc: meta.doc };
        hideBubble();
        let viewportRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        if (range) {
          try {
            const r = range.getBoundingClientRect();
            const ir = meta.ifr ? meta.ifr.getBoundingClientRect() : { left: 0, top: 0 };
            viewportRect = { left: r.left + ir.left, top: r.top + ir.top, right: r.right + ir.left, bottom: r.bottom + ir.top, width: r.width, height: r.height };
          } catch {}
        }
        showPopupAt(viewportRect);
        doLookup(text, range, settings.contextSentences);
      } else {
        fireFromBubble();
      }
    }

    // Primary path — touch devices
    translateBubble.addEventListener('touchend', e => {
      e.preventDefault();  // suppress synthetic click
      e.stopPropagation();
      fireBubbleLookup();
    }, { passive: false });

    // Fallback — non-touch (mouse click)
    translateBubble.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      fireBubbleLookup();
    });
  }
}