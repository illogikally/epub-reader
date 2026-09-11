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

import { openBookFromDb } from './reader.js?v=61';
import {
  $, escapeHtml, settings, runtime,
  currentModel, GROQ_URL, GROQ_KEY_REF,
  MAX_TOKENS, CONTEXT_SENTENCES, MAX_SELECTION_CHARS, attachPullToDismiss, isCoarsePointer, isPhoneUI,
} from './state.js?v=61';
import {
  onSelectionSettled, onBookTap,
  getTouchSelection, clearTouchSelection,
} from './touchselect.js?v=61';

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
    top_p: 1,
  };
  // Per-model, not guessed from the name: a model that doesn't support
  // reasoning_effort rejects the whole request if it is sent one.
  if (cfg.reasoning && cfg.reasoning !== 'off') {
    body.reasoning_effort = cfg.reasoning;
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  for await (const evt of streamSSE(GROQ_URL, headers, body)) {
    const text = evt?.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

async function* llmStream(messages, system) {
  const cfg = currentModel();
  if (!cfg) throw new Error('no model configured — add one in Settings');
  const apiKey = (settings.apiKeys[GROQ_KEY_REF] || '').trim();
  if (!apiKey) throw new Error('missing Groq key — paste it in Settings');
  yield* streamOpenAI(cfg, messages, system, apiKey);
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
  // The tail of a syn headword line — "• **từ** · văn phong · sắc thái" — drawn
  // smaller so the meaning line under it and the example sentence carry the
  // entry. The `ex` answer also bullets with "•" and a bold keyword, but it runs
  // straight into a sentence, so requiring " · " right after the bold keeps this
  // off it.
  h = h.replace(/^(• <strong>[^<]*<\/strong>)( · .*)$/gm, '$1<span class="attrs">$2</span>');
  return h;
}

function isMobileViewport() {
  return isPhoneUI();
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
  // Restart the pop-in. Looking up a second word moves the popup rather than
  // reopening it, so the class is already there and the animation would not
  // replay — removing it and forcing a reflow is what makes it retrigger.
  // Cheap here: the placement above has already flushed layout.
  popup.classList.remove('popping');
  void popup.offsetWidth;
  popup.classList.add('popping');
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
  popup.classList.remove('popping');
  popupHistory.length = 0;
  popupOut.innerHTML = '';
  popupActions.innerHTML = '';
  spentActions.clear();          // new word — every action is available again
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
// `heading` is the section label the popup draws above the answer (SYNONYM,
// ANTONYM, …). It used to be the model's job — every action prompt ended with
// a mandatory `**SYNONYM**:` line — which meant the label was missing or
// mangled whenever the model ignored the format. The popup owns it now, so the
// prompts ask for the body alone.
// `actionKey` ties this answer back to the action link that started it, so a
// second click on that (now spent) link can scroll to the answer instead of
// doing nothing — see addAction / scrollToSpent.
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

// An action is spent once it has been used: its answer is already in the
// transcript below, so running it again only appends a duplicate — a second
// click scrolls to that answer instead. Tracked in a map (key -> the element
// its answer starts at) rather than on the element because renderActionsBar
// rebuilds the whole row from scratch (today when a lookup's own reply lands),
// which would otherwise hand back a fresh, clickable button. doLookup clears it
// when a new word is looked up.
const spentActions = new Map();

function markSpent(a) {
  a.classList.add('used', 'spent');
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

// Builds one action link. `key` identifies it across rebuilds; `run` fires on
// the first click, and every later click scrolls to what that run produced.
function addAction(key, label, title, run) {
  const a = document.createElement('a');
  a.href = '#';
  a.className = 'action';
  a.textContent = label;
  a.title = title;
  if (spentActions.has(key)) markSpent(a);
  a.onclick = (e) => {
    e.preventDefault();
    if (spentActions.has(key)) { scrollToSpent(key); return; }
    if (popupBusy) return;
    spentActions.set(key, null);
    markSpent(a);
    run();
  };
  popupActions.appendChild(a);
  return a;
}

// Renders the action buttons into the top bar (#popup-actions),
// alongside the close + input-toggle icons. One scrollable row.
function renderActionsBar(phrase, context) {
  popupActions.innerHTML = '';
  const ctxNote = context && context !== phrase ? ` Context: "${context}".` : '';

  // The popup prints the section label itself (see sendToLLM's `heading`), so
  // a model that also prints one would double it up.
  const noHeading = 'Không in tiêu đề.';

  // deep — re-run the lookup as a literary/historical analysis
  [1].forEach(n => {
    addAction('deep', 'deep', `Re-run with ${n} sentences of context`, async () => {
      if (!lastLookup) return;
      const context = extractContextFromRange(lastLookup.range, n);
      const { creator, title } = await runtime.book.loaded.metadata;
      const prompt = `Với góc nhìn văn học, sử học, phân tích "${phrase}" trong "${title}" (${creator}), tối đa 50 từ. Ngữ cảnh: "${context}"`;
      sendToLLM(prompt, null, null, true, 'DEEP', 'deep');
    });
  });

  // Synonyms are only worth listing if you can tell them apart, so every entry
  // gets register + connotation, names the ONE thing that shifts against the
  // headword, and earns its place with a sentence the headword would be wrong in.
  // The "• **từ** · a · b" headword line is parsed by renderMarkdown — keep it.
  const synCtx = context && context !== phrase ? `\nCâu: """${context}"""` : '';
  const synonymPrompt = `Đồng nghĩa tiếng Anh của "${phrase}" theo nét nghĩa trong câu.${synCtx}
Trả về đúng khối sau, đủ 5 mục (${phrase} trước, rồi 4 từ từ gần đến xa), không dòng trống, không thêm gì:
• **${phrase}** · [văn phong] · [sắc thái]
[nghĩa của nó]
  *[câu ví dụ điển hình]*
• **[từ]** · [văn phong] · [sắc thái]
[một điểm khác cụ thể so với ${phrase}; mở đầu "dễ nhầm:" nếu hay bị dùng nhầm]
  *[câu chỉ hợp với từ này]* — thay bằng "${phrase}" thì [hỏng ở đâu]
**TRỤC**: [5 từ xếp theo khác biệt chính, vd annoyed < angry < furious]
- Văn phong: trang trọng/trung tính/đời thường/lóng/chuyên ngành; sắc thái: tích cực/trung tính/tiêu cực. Chỉ ghi giá trị, không nhãn.
- Mỗi từ khác ở một điểm riêng; cấm "trang trọng hơn", "mạnh hơn" mà không nói hơn ở đâu.
- Ví dụ tiếng Anh, mô tả tiếng Việt. ${noHeading}`;

  // Short-label follow-up queries — single words only.
  // [button label, prompt, tooltip, heading drawn above the answer]
  const items = phrase.trim().split(' ').length > 1 ? [] : [
    ['syn', synonymPrompt, 'Synonyms', 'SYNONYM'],
    ['ant', `A few antonyms of "${phrase}".${ctxNote} Reply with only the words, comma-separated.`, 'Antonyms', 'ANTONYM'],
    ['ex',  `3 short, varied example sentences using "${phrase}" in the same sense.${ctxNote} One per line starting with •, keyword in bold. Nothing else.`, 'Examples', 'EXAMPLE'],
    ['use', `Độ thông dụng của "${phrase}" trong tiếng Anh hiện đại (thang 1-100). Chỉ trả về: [mức độ] - [văn phong].`, 'Usage frequency', 'USAGE'],
    ['ety', `Từ nguyên của "${phrase}", ngắn gọn. ${noHeading}`, 'Etymology', 'ETYMOLOGY'],
  ];
  items.forEach(([label, q, longLabel, heading]) => {
    addAction(label, label, longLabel, () => {
      sendToLLM(q, longLabel + ': "' + phrase + '"', null, true, heading, label);
    });
  });

  // Last in the row, and touch only: it exists because native selection is
  // disabled on coarse pointers, so there is no iOS Copy button. Desktop keeps
  // native selection and doesn't need it. Not spendable — copying twice is
  // harmless and appends nothing.
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
  spentActions.clear();          // new word — every action is available again
  popupForm.hidden = true;

  const is_a_word = phrase.trim().split(' ').length == 1
  // The sentence only picks the sense (and part of speech) — it is not to be translated.
  const ctxBlock = local ? `\nCâu (chỉ để chọn nét nghĩa, không dịch): """${local}"""` : '';
  const prompt = is_a_word
    ? `Nghĩa tiếng Việt của riêng từ "${phrase}".${ctxBlock}
Trả về đúng 1 dòng: **${phrase}** /IPA/: nghĩa
- Nghĩa ngắn như từ điển (1-4 từ), tối đa 2 nghĩa ngăn bằng dấu phẩy; không lấy nghĩa cả thành ngữ chứa từ.
- Không thêm gì khác. Vd câu "We sat on the river bank." → **bank** /bæŋk/: bờ, bờ sông`
    : `Nghĩa tiếng Việt của riêng cụm "${phrase}".${ctxBlock}
Trả về đúng 1 dòng: **${phrase}**: nghĩa
- Nghĩa ngắn như từ điển, không phải câu; thành ngữ thì trả nghĩa thành ngữ.
- Không phiên âm, không thêm gì khác. Vd **gave up**: từ bỏ, cai`
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
  if (!phrase || phrase.length > MAX_SELECTION_CHARS) return;

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
  if (sel.text.length > MAX_SELECTION_CHARS) return;

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
// zip's uncompressed byte sizes — the measure of chapter length that costs
// nothing, used until book.locations has been generated (see primeLocations
// in reader.js).
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

// Memoised per book: the table above is derived from zip metadata and never
// changes for a given book. Computed on first use rather than only in
// buildToc, because buildToc runs after rendition.display() and the first
// relocated event therefore beats it.
let progressBook = null;
let progressFractions = null;
function fractionsFor(book) {
  if (!book) return null;
  if (book !== progressBook) {
    progressBook = book;
    progressFractions = spineStartFractions(book);
  }
  return progressFractions;
}

const clamp01 = n => Math.min(1, Math.max(0, n));

// How far into the book `loc` is, as 0..1, or null if it can't be worked out.
//
// NOT loc.start.percentage on its own: epubjs derives that from book.locations,
// and with no locations generated locationFromCfi returns -1, which
// percentageFromLocation turns into a flat 0. So it is exact only once
// locations exist; until then we interpolate between the byte-size fractions
// above using the page offset within the current section. displayed.page /
// .total come from the layout and are recomputed on every relayout, so the
// estimate follows the reader's font and margin settings for free.
export function readingProgress(loc) {
  const start = loc?.start;
  const index = start?.index;
  if (typeof index !== 'number' || index < 0) return null;

  const book = runtime.book;
  if (book?.locations?.length?.() > 0 && typeof start.percentage === 'number') {
    return clamp01(start.percentage);
  }

  const fractions = fractionsFor(book);
  const spineLength = book?.spine?.spineItems?.length || 0;
  let from, to;
  if (fractions && fractions[index] != null) {
    from = fractions[index];
    to = index + 1 < fractions.length ? fractions[index + 1] : 1;
  } else if (spineLength) {
    from = index / spineLength;
    to = (index + 1) / spineLength;
  } else {
    return null;
  }

  // (page - 1) / (pages - 1): the first page of a section reads as its start
  // and the last reads as the next section's start, so the first page of the
  // book is exactly 0% and the last is exactly 100%. Dividing by `pages`
  // instead would leave the book topping out short of 100 — badly so when the
  // final section is only a page or two long.
  const page = start.displayed?.page;
  const pages = start.displayed?.total;
  const within = (typeof page === 'number' && typeof pages === 'number' && pages > 1)
    ? clamp01((page - 1) / (pages - 1))
    : 0;

  return clamp01(from + (to - from) * within);
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
  const fractions = fractionsFor(book);

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
  // The Contents row is also the progress bar — see .chrome-row-primary.
  const bar = $('btn-toc');
  if (bar) bar.style.setProperty('--progress', ok ? (pct * 100).toFixed(2) + '%' : '0%');
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