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

import { openBookFromDb } from './reader.js?v=19';
import {
  $, escapeHtml, settings, runtime,
  MODELS, MAX_TOKENS, CONTEXT_SENTENCES, attachPullToDismiss, isCoarsePointer,
} from './state.js?v=19';
import {
  onSelectionSettled, onBookTap,
  getTouchSelection, clearTouchSelection,
} from './touchselect.js?v=19';

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


// Timestamp of the last showPopupAt() call — used to ignore synthetic
// mousedown/pointerdown events that arrive ~300ms after a touch and would
// immediately dismiss the popup.
let popupOpenedAt = 0;

// `closing` is true while the mobile sheet is animating out. It must read as
// not-visible, or the outside-tap handler re-enters hidePopup() mid-animation.
let closing = false;
let closeTimer = null;

export function isPopupVisible() {
  return popupWrapper.classList.contains('visible') && !closing;
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
    // Cancel an in-flight close so reopening mid-animation doesn't get torn
    // down by the pending teardown.
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    closing = false;

    popup.classList.add('mobile');
    popup.classList.remove('pos-above', 'pos-below');
    popup.style.left = '';
    popup.style.right = '';
    popup.style.top = '';
    popup.style.bottom = '';
    popup.style.width = '';
    popup.style.maxHeight = '';
    // attachPullToDismiss() leaves an inline transform/transition behind when
    // it drags the sheet; clear them so the CSS transition owns the animation.
    popup.style.transform = '';
    popup.style.transition = '';

    popupWrapper.classList.add('visible');
    // Next frame, so the browser has a chance to lay the sheet out at
    // translateY(100%) before .shown animates it to 0. Same frame = no
    // transition at all.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => popupWrapper.classList.add('shown'));
    });
    clearAllSelections();
    return;
  }
  popupWrapper.classList.add('shown');   // desktop: no transition, just parity
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
  popup.style.left = left + 'px';
  if (placeAbove) {
    // Anchor by bottom so the popup's bottom edge stays pinned just above the
    // selection; as content streams in, growth expands upward instead of
    // covering the selected text.
    popup.style.top = '';
    popup.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
    const avail = Math.max(120, rect.top - gap - margin);
    popup.style.maxHeight = `min(60vh, 480px, ${avail}px)`;
  } else {
    let top = rect.bottom + gap;
    if (top + H > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - H - margin);
      if (top < rect.bottom + gap) top = rect.bottom + gap;
    }
    popup.style.bottom = '';
    popup.style.maxHeight = '';
    popup.style.top = top + 'px';
  }
  popup.classList.toggle('pos-above', placeAbove);
  popup.classList.toggle('pos-below', !placeAbove);
  const arrowX = rect.left + rect.width / 2 - left;
  popup.style.setProperty('--arrow-x', Math.max(20, Math.min(W - 20, arrowX)) + 'px');
  popupWrapper.classList.add('visible');
  // Desktop: leave the selection alone so the user can still copy / re-select.
}

// Book content only: our own touch selection plus any native selection inside
// the chapter iframes.
function clearFrameSelections() {
  clearTouchSelection();
  try {
    viewer.querySelectorAll('iframe').forEach(ifr => {
      try { ifr.contentWindow && ifr.contentWindow.getSelection().removeAllRanges(); } catch {}
    });
  } catch {}
}

function clearAllSelections() {
  clearFrameSelections();
  try { window.getSelection && window.getSelection().removeAllRanges(); } catch {}
}

function finishHide() {
  closeTimer = null;
  closing = false;
  popupWrapper.classList.remove('visible', 'shown');
  popupHistory.length = 0;
  popupOut.innerHTML = '';
  popupActions.innerHTML = '';
  popupForm.hidden = true;
  popupInput.value = '';
  lastLookup = null;
  popup.style.transform = '';
  popup.style.transition = '';
  // Frame-only: on desktop the user may have text selected in the popup itself
  // or elsewhere in the page, and closing the popup shouldn't wipe it.
  clearFrameSelections();
}

export function hidePopup() {
  if (closing) return;
  const animated = popup.classList.contains('mobile')
                && popupWrapper.classList.contains('visible');
  if (!animated) { finishHide(); return; }

  // Slide out, then tear down. The timeout is required rather than a safety
  // net: attachPullToDismiss() has often already animated the sheet to
  // translateY(100%) itself before calling us, so removing .shown may change
  // nothing and transitionend would never fire.
  closing = true;
  popupWrapper.classList.remove('shown');
  const done = (e) => {
    if (e && e.target !== popup) return;
    popup.removeEventListener('transitionend', done);
    if (closeTimer) { clearTimeout(closeTimer); }
    finishHide();
  };
  popup.addEventListener('transitionend', done);
  closeTimer = setTimeout(done, 320);
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

// Desktop only. The touch equivalent is onBookTap() below: touch events never
// reach listeners bound inside the book iframe on iOS, so the capture layer in
// the parent document reports taps instead.
export function attachOutsideClickToFrame(doc) {
  if (!doc || isCoarsePointer) return;
  const onTap = () => {
    // Deferred so a drag that starts a selection has had time to register;
    // a live selection means the user is reading, not dismissing.
    setTimeout(() => {
      const sel = doc.getSelection && doc.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      if (isPopupVisible()) hidePopup();
    }, 30);
  };
  doc.addEventListener('mousedown',   onTap, { passive: true });
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

  // Desktop popover only: as the answer streams in the popup grows, and this
  // nudges it back up so it doesn't run off the bottom of the window.
  //
  // It must NOT run for the mobile sheet. That is laid out with
  // `top: auto; bottom: 0`, and writing an inline `top` over-constrains it —
  // top + bottom + height all resolved means `bottom` is dropped, so the sheet
  // detaches from the bottom edge and leaves a gap as it grows. This used to be
  // masked by `top: auto !important`, which was removed so that custom CSS can
  // restyle the sheet.
  function preventPopupOutOfView() {
    if (popup.classList.contains('mobile')) return;
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
  [1].forEach(n => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = 'deep';
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

  // Short-label follow-up queries — single words only.
  const items = phrase.trim().split(' ').length > 1 ? [] : [
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

  // Last in the row, and touch only: it exists because native selection is
  // disabled on coarse pointers, so there is no iOS Copy button. Desktop keeps
  // native selection and doesn't need it.
  // Gated on isCoarsePointer rather than isMobileViewport(): a narrow desktop
  // window gets the .mobile sheet but still has real selection.
  if (isCoarsePointer) {
    const copy = document.createElement('a');
    copy.href = '#';
    copy.className = 'action';
    copy.textContent = 'copy';
    copy.title = 'Copy the selected text';
    copy.onclick = async (e) => {
      e.preventDefault();
      try { await navigator.clipboard.writeText(phrase); copy.classList.add('used'); }
      catch { copy.textContent = 'copy?'; }
    };
    popupActions.appendChild(copy);
  }
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
  lastLookup = { phrase, range: savedRange, doc };

  showPopupAt(viewportRect);
  doLookup(phrase, savedRange, CONTEXT_SENTENCES);
}

// ============================================================
// Per-iframe selection wiring.
//
// Desktop: auto-fire lookup on mouseup with a non-collapsed selection.
// Mobile: nothing wired here — selectionchange does not fire reliably
//   inside epub.js's blob iframes on iOS. The bubble is driven by a
//   200ms polling interval started from initTranslateEvents() instead.
// ============================================================

export function attachSelectionHandler(doc) {
  if (isCoarsePointer) return;

  const win = doc.defaultView;
  const iframe = win ? win.frameElement : null;
  doc.addEventListener('mouseup', () => {
    // Tiny delay so the browser has finalized the selection range.
    setTimeout(() => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed) return;
      fireLookupForSelection(sel, doc, iframe);
    }, 10);
  });
}

// ============================================================
// Touch path: the lookup fires by itself when a selection settles.
//
// There is no bubble to tap any more — js/touchselect.js reports the finished
// long-press or drag and we go straight to the popup, which is what desktop
// has always done on mouseup via attachSelectionHandler().
// ============================================================
function lookupSelection(sel) {
  if (!isCoarsePointer) return;
  // One lookup per gesture: a drag that extends the selection settles once,
  // on release, and this also stops a second gesture interrupting a live call.
  if (popupBusy || isPopupVisible()) return;
  if (!sel || !sel.text) return;

  lastLookup = { phrase: sel.text, range: sel.range, doc: sel.doc };

  let viewportRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  try {
    const r = sel.range.getBoundingClientRect();
    const ir = sel.ifr ? sel.ifr.getBoundingClientRect() : { left: 0, top: 0 };
    viewportRect = {
      left: r.left + ir.left, top: r.top + ir.top,
      right: r.right + ir.left, bottom: r.bottom + ir.top,
      width: r.width, height: r.height,
    };
  } catch {}

  showPopupAt(viewportRect);
  doLookup(sel.text, sel.range, CONTEXT_SENTENCES);
}

// Kept for closeBook(): drop any live selection when the book goes away.
export function stopBubble() {
  clearTouchSelection();
}

// ============================================================
// TOC (lives here because it needs rendition + drawer hide)
//
// Modelled on the Apple Books contents sheet: a header carrying the cover,
// the title and how far in you are, then one full-bleed row per entry with
// the entry's position in the book on the right.
// ============================================================
let tocLinks = [];        // rows in render order, each with a .spineIndex
let currentTocLink = null;

// Where each spine item starts, as a fraction of the book. Derived from the
// zip's uncompressed byte sizes — the only measure of chapter length that is
// free: book.locations.generate() would have to parse every section (see the
// note in openBookFromDb).
function spineStartFractions(book) {
  try {
    const zip = book?.archive?.zip;
    const items = book?.spine?.spineItems;
    if (!zip || !items?.length) return null;
    const sizes = items.map(item => {
      const url = String(item.url || item.href || '');
      const path = url.replace(/^\//, '');
      let entry = null;
      try { entry = zip.file(decodeURIComponent(path)); } catch {}
      if (!entry) entry = zip.file(path);
      const size = entry?._data?.uncompressedSize;
      return typeof size === 'number' && size > 0 ? size : 0;
    });
    const total = sizes.reduce((a, b) => a + b, 0);
    if (!total) return null;
    const fractions = [];
    let run = 0;
    for (const size of sizes) { fractions.push(run / total); run += size; }
    return fractions;
  } catch { return null; }
}

// Spine index for a TOC href, or -1. spine.get() handles fragments and the
// usual nav-doc-relative hrefs; the basename pass catches nav documents that
// sit in a different folder than the content.
function spineIndexForHref(book, href) {
  if (!book || !href) return -1;
  try {
    const section = book.spine.get(href);
    if (section && typeof section.index === 'number') return section.index;
  } catch {}
  const base = decodeURIComponent(String(href).split('#')[0]).split('/').pop();
  const match = book.spine?.spineItems?.find(item =>
    decodeURIComponent(String(item.href || '')).split('/').pop() === base);
  return match ? match.index : -1;
}

export function buildToc(toc, meta = {}) {
  const book = runtime.book;
  const cover = $('toc-cover');
  cover.hidden = !meta.cover;
  if (meta.cover) cover.src = meta.cover;
  $('toc-book-title').textContent = meta.title || '';
  setTocPosition(null);

  tocList.innerHTML = '';
  tocLinks = [];
  currentTocLink = null;
  const fractions = spineStartFractions(book);

  const render = (items, depth = 0) => {
    items.forEach(item => {
      const a = document.createElement('a');
      a.dataset.depth = Math.min(depth, 3);
      a.style.setProperty('--toc-indent', (depth * 18) + 'px');

      const label = document.createElement('span');
      label.className = 'toc-label';
      label.textContent = item.label.trim();
      a.appendChild(label);

      const spineIndex = spineIndexForHref(book, item.href);
      a.spineIndex = spineIndex;
      if (fractions && spineIndex >= 0 && fractions[spineIndex] != null) {
        const num = document.createElement('span');
        num.className = 'toc-num';
        num.textContent = Math.round(fractions[spineIndex] * 100) + '%';
        a.appendChild(num);
      }

      a.addEventListener('click', e => {
        e.preventDefault();
        if (runtime.rendition) runtime.rendition.display(item.href);
        document.dispatchEvent(new CustomEvent('reader:hideAllDrawers'));
      });
      tocList.appendChild(a);
      tocLinks.push(a);
      if (item.subitems?.length) render(item.subitems, depth + 1);
    });
  };
  render(toc);
  if (!toc.length) {
    tocList.innerHTML = '<p style="color:var(--chrome-fg);font-size:13px;padding:16px 20px">No table of contents.</p>';
  }
  // The book is already displayed by the time the TOC is built, so seed the
  // highlight and the position line from where we actually are.
  try {
    const loc = runtime.rendition?.currentLocation();
    markTocCurrent(loc?.start?.index);
    setTocPosition(loc?.start?.percentage);
  } catch {}
}

// Reading position shown under the TOC title, and echoed on the Contents row
// of the floating chrome ("Contents · 12%"). pct is 0..1, or null to hide.
export function setTocPosition(pct) {
  const ok = typeof pct === 'number' && pct >= 0 && pct <= 1;
  const text = ok ? Math.round(pct * 100) + '%' : '';
  const row = $('toc-position');
  if (row) {
    row.hidden = !ok;
    if (ok) $('toc-position-value').textContent = text;
  }
  const chip = $('chrome-progress');
  if (chip) chip.textContent = ok ? ' · ' + text : '';
}

// Highlight the entry covering the given spine index: the first entry that
// starts in this section, else the last entry that starts before it.
export function markTocCurrent(spineIndex) {
  if (typeof spineIndex !== 'number' || !tocLinks.length) return;
  let match = tocLinks.find(a => a.spineIndex === spineIndex);
  if (!match) {
    for (const a of tocLinks) {
      if (a.spineIndex >= 0 && a.spineIndex < spineIndex) match = a;
    }
  }
  if (match === currentTocLink) return;
  currentTocLink?.classList.remove('current');
  currentTocLink = match || null;
  currentTocLink?.classList.add('current');
}

// Called when the drawer opens — the current chapter is often far down a long
// list, so bring it into view before the sheet is looked at.
export function scrollTocToCurrent() {
  if (!currentTocLink) return;
  const target = currentTocLink.offsetTop - tocList.clientHeight / 2
    + currentTocLink.offsetHeight / 2;
  tocList.scrollTop = Math.max(0, target);
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

  // Touch: fire the lookup as soon as a selection settles.
  onSelectionSettled(lookupSelection);

  // Touch: a plain tap on the book dismisses the popup. The in-iframe listener
  // that used to do this never fires on iOS.
  onBookTap(() => { if (isPopupVisible()) hidePopup(); });
}