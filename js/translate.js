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

import {
  $, escapeHtml, settings, runtime,
  MODELS, MAX_TOKENS,
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
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const body = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    messages: msgs,
    stream: true,
    temperature: 0,
    reasoning_effort: 'low',
  };
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
  if (isMobileViewport()) {
    popupWrapper.classList.add('mobile');
    popup.style.left = '';
    popup.style.right = '';
    popup.style.top = '';
    popup.style.width = '';
    popupWrapper.classList.add('visible');
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
  let left = rect.left + rect.width / 2 - W / 2;
  left = Math.max(margin, Math.min(window.innerWidth - W - margin, left));
  // Place above the selection when its center is below the viewport midpoint —
  // keeps the popup from getting pushed off the bottom of the screen.
  const selCenterY = rect.top + rect.height / 2;
  const placeAbove = selCenterY > window.innerHeight / 2;
  let top;
  if (placeAbove) {
    top = rect.top - H - 8;
    if (top < margin) top = margin; // not enough room above either, clamp
  } else {
    top = rect.bottom + 8;
    if (top + H > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - H - margin);
    }
  }
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popupWrapper.classList.add('visible');
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
    for await (const chunk of llmStream(popupHistory, `I'm in a tight space right now so don't format using tables`)) {
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

  // [5] [10] [15] — re-run lookup with N sentences of context
  [5, 10, 15].forEach(n => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = String(n);
    a.title = `Re-run with ${n} sentences of context`;
    a.onclick = (e) => {
      e.preventDefault();
      if (popupBusy || !lastLookup) return;
      doLookup(lastLookup.phrase, lastLookup.range, n);
    };
    popupActions.appendChild(a);
  });

  // Short-label follow-up queries
  if (phrase.trim().split(' ').length > 1) {
    return;
  }
  const items = [
    ['syn', `List a few synonyms of <${phrase}> in <${ctxNote}> using this format, the text inside [] is instructions, you should replace them with actual info: **Synonyms**: [synonyms separated by comma]. Be concise.`, 'Synonyms'],
    ['ant', `List a few antonyms of <${phrase}> in <${ctxNote}> using this format, the text inside [] is instructions, you should replace them with actual info: **Antonyms**: [antonyms separated by comma]. Be concise.`, 'Antonyms'],
    ['ex',  `Give 3 short example sentences using <${phrase}> in ${ctxNote} using this format, the text inside the [] is instructions, you should replace them with actual info:
**Usage**:
[3 examples one each line using - as bullet, the keyword should be bold]`, 'Examples'],
    ['use', 'On a scale of 1-100, how often is "' + phrase + '" used in modern English and its register. Be concise.', 'Usage frequency'],
    ['ety', 'Briefly explain the etymology of "' + phrase + '". Be concise.', 'Etymology'],
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
    ? `Những cụm từ trong [] chỉ dẫn, thay thế các chỉ dẫn này cùng [] với câu trả lời tương ứng, chỉ trả lời, không lặp lại chỉ dẫn. Trả lời cực kì ngắn gọn theo mẫu sau về nghĩa của từ <${phrase}> trong đoạn <${local}> theo mẫu sau:
**${phrase}** /[IPA]/: [Nghĩa của từ]`
    : `Trả lời ngắn gọn, đúng trọng tâm. Đừng thêm bất cứ từ gì ngoài nghĩa của đoạn dịch. Không thêm bất cứ từ gì, dịch word-by-word cho tao. Đoạn sau <${phrase}> trong câu <${local}> có nghĩa là ...`
  const ctxLabel = sentenceCount > 1 ? ` (ctx: ${sentenceCount})` : '';
  sendToLLM(prompt, `meaning: "${phrase}"${ctxLabel}`, { phrase, context: local }, true);
}

function fireLookupForSelection(sel, doc, iframe) {
  if (popupBusy) return;
  if (isPopupVisible()) return;
  if (!sel || sel.isCollapsed) return;
  const phrase = sel.toString().trim();
  if (!phrase || phrase.length > 1000) return;

  let range;
  try { range = sel.getRangeAt(0); } catch { return; }

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

  const savedRange = range.cloneRange();
  try { sel.removeAllRanges(); } catch {}
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
// Desktop path: auto-fire on mouseup inside the iframe.
// On (pointer: coarse) this is a no-op — mobile uses the bubble.
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
  let top;
  if (selBottom + bh + margin <= window.innerHeight) {
    top = selBottom + margin;
  } else if (selTop - bh - margin >= margin) {
    top = selTop - bh - margin;
  } else {
    top = Math.max(margin, window.innerHeight - bh - margin);
  }
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

let selectionPollTimer = null;
export function startSelectionPolling() {
  if (selectionPollTimer) return;
  // Mobile-only: drives bubble visibility. iOS Safari fires selectionchange
  // unreliably for in-iframe selections, so we poll as a backstop.
  if (!isCoarsePointer) return;
  selectionPollTimer = setInterval(updateBubble, 200);
}
export function stopSelectionPolling() {
  if (!selectionPollTimer) return;
  clearInterval(selectionPollTimer);
  selectionPollTimer = null;
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
  if (translateBubble) {
    // Stop pointerdown from bubbling to the document-level outside-click
    // handler (which would tear down popup state right before we open it).
    translateBubble.addEventListener('pointerdown', e => e.stopPropagation());
    translateBubble.addEventListener('mousedown',   e => e.stopPropagation());
    translateBubble.addEventListener('touchstart',  e => e.stopPropagation(), { passive: true });
    translateBubble.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      fireFromBubble();
    });
  }

  // Top-document selectionchange: on mobile (where iframe selectionchange is
  // unreliable), this drives bubble visibility. Debounced lightly so the
  // bubble feels snappy without thrashing during handle drag.
  let bubbleSelTimer;
  document.addEventListener('selectionchange', () => {
    if (!isCoarsePointer) return;
    clearTimeout(bubbleSelTimer);
    bubbleSelTimer = setTimeout(updateBubble, 80);
  });
}