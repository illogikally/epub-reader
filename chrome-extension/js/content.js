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
  // 'auto' | 'light' | 'dark' — set from Popup theme in the extension popup.
  // The reader has no equivalent: its popup takes the book's own theme colors.
  popupTheme: 'auto',
  apiKeys: { GEMINI_API_KEY: '', GROQ_API_KEY: '' },
};

const MAX_TOKENS = 600;
// Longest selection that may start a lookup. Past this the selection is simply
// ignored: no popup, no LLM call. Same cap as the reader.
const MAX_SELECTION_CHARS = 100;

// Inject HTML
const html = `
  <div id="llm-popup" popover="manual">
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

// Preload New Spirit for section headers via FontFace buffer so page CSP doesn't block it
try {
  fetch(chrome.runtime.getURL('fonts/NewSpirit-SemiBoldCondensed.otf'))
    .then(r => r.arrayBuffer())
    .then(buf => {
      const f1 = new FontFace('New Spirit', buf, { weight: '600 700' });
      const f2 = new FontFace('New Spirit Condensed', buf, { weight: '600 700' });
      return Promise.all([f1.load(), f2.load()]);
    })
    .then(fonts => {
      fonts.forEach(f => document.fonts.add(f));
    })
    .catch(() => {});
} catch (_) {}

// Set on our own container rather than the page's <html>, so nothing of ours
// leaks into the host page. `all: initial` on #llm-popup doesn't reset custom
// properties, so it still reaches #llm-popup-out.
function applyWordSpacing() {
  container.style.setProperty('--llm-word-spacing', settings.popupWordSpacing + 'px');
}

// Theme, same container-scoped reasoning as above: the palette lives on our
// wrapper, never on the page's :root. 'auto' is resolved here rather than with
// a prefers-color-scheme block in the CSS so the stylesheet carries the dark
// palette exactly once; the listener keeps auto honest if the OS flips while
// the page is open.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = settings.popupTheme === 'dark'
    || (settings.popupTheme !== 'light' && darkQuery.matches);
  container.classList.toggle('llm-theme-dark', dark);
  container.classList.toggle('llm-theme-light', !dark);
}
applyTheme();
darkQuery.addEventListener('change', applyTheme);

const $ = id => document.getElementById(id);
const popup = $('llm-popup');
const popupContent = popup.querySelector('.llm-popup-content');
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
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      // A provider that fails after the 200 reports it as an event in the
      // stream. Skipping it used to end in '(no response)' with no way to fall
      // through to the next model.
      if (obj?.error) throw new Error(`stream error: ${obj.error.message || JSON.stringify(obj.error)}`.slice(0, 300));
      yield obj;
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

async function* llmStream(cfg, messages, system) {
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

// The streaming reply's height/scroll follower — see sendToLLM. Module-level
// so a new reply, or closing the popup, can stop one still settling.
const FOLLOW_EASE = 0.3;
let kickFollow = () => {};
let stopFollow = () => {};
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
  return div;
}

// Reveals streamed text at a steady pace instead of in the lumps the network
// hands it over in — one read often carries several SSE events, so writing
// each chunk straight to the DOM made the answer jump a block at a time.
// Received text goes into a buffer; each animation frame shows a slice of the
// backlog (a fraction of it, so a big burst catches up quickly and a trickle
// still moves a character a frame). end() resolves once everything received
// has been shown; cancel() stops without showing the rest.
function smoothStream(onFrame) {
  let target = '';
  let shown = 0;
  let raf = 0;
  let done = false;
  let resolveEnd;
  const ended = new Promise(r => { resolveEnd = r; });
  function tick() {
    raf = 0;
    const backlog = target.length - shown;
    if (backlog > 0) {
      shown += Math.max(1, Math.ceil(backlog / (done ? 4 : 10)));
      // Don't cut a surrogate pair (emoji) in half.
      const c = target.charCodeAt(shown - 1);
      if (c >= 0xd800 && c <= 0xdbff && shown < target.length) shown++;
      onFrame(target.slice(0, shown));
    }
    if (shown < target.length) raf = requestAnimationFrame(tick);
    else if (done) resolveEnd();
  }
  return {
    push(text) {
      target += text;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    end() {
      done = true;
      if (!raf) tick();
      return ended;
    },
    get settled() {
      return done && shown >= target.length;
    },
    cancel() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      done = true;
      resolveEnd();
    },
  };
}

// A reply cut off mid-stream can end inside **bold** or *italic*. Rendered
// as is, the asterisks show until the closing pair arrives and then vanish,
// shifting the rest of the line; closing them early draws the word styled
// from its first letter instead.
function closeDanglingMarkdown(text) {
  let t = text.replace(/\*+$/, '');
  if ((t.match(/\*\*/g) || []).length % 2) t += '**';
  else if ((t.replace(/\*\*/g, '').match(/\*/g) || []).length % 2) t += '*';
  return t;
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

// The popup is attached to the selected word by CSS anchor positioning, so
// the browser itself keeps it there through every scroll — window, <body>,
// inner scroll containers — with no JS running while it does. JS runs once,
// here, when the popup opens: the element holding the word becomes the anchor
// (a temporary inline anchor-name, restored on close — the page's DOM is left
// alone), and where the word sits inside that element's box goes into custom
// properties that the CSS offsets from anchor() by.
const ANCHOR_NAME = '--llm-translator-anchor';
let anchorEl = null;
let anchorPrevName = '';

function anchorPopup(rect) {
  releaseAnchor();
  let el = lastLookup && lastLookup.range.startContainer;
  if (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
  // display:contents has no box to anchor to.
  while (el && el.parentElement && getComputedStyle(el).display === 'contents') {
    el = el.parentElement;
  }
  if (!el) return;
  anchorEl = el;
  anchorPrevName = el.style.getPropertyValue('anchor-name');
  el.style.setProperty('anchor-name', ANCHOR_NAME, 'important');

  const box = el.getBoundingClientRect();
  const W = popup.offsetWidth || 420;
  const margin = 12;
  const gap = 12;
  const wordCx = rect.left + rect.width / 2;

  const placeAbove = rect.top + rect.height / 2 > window.innerHeight / 2;
  popup.classList.toggle('pos-above', placeAbove);
  popup.classList.toggle('pos-below', !placeAbove);

  // Cap the height to the room on the chosen side, so a streaming answer
  // can't grow the card past the viewport edge.
  const avail = placeAbove
    ? rect.top - gap - margin
    : window.innerHeight - rect.bottom - gap - margin;
  popupContent.style.maxHeight = `min(60vh, 480px, ${Math.max(120, avail)}px)`;

  const left = Math.max(margin, Math.min(window.innerWidth - W - margin, wordCx - W / 2));
  popup.style.setProperty('--llm-dx', (left - box.left) + 'px');
  popup.style.setProperty('--llm-word-top', (rect.top - box.top) + 'px');
  popup.style.setProperty('--llm-word-bottom', (rect.bottom - box.top) + 'px');
  popup.style.setProperty('--arrow-x', Math.max(20, Math.min(W - 20, wordCx - left)) + 'px');
}

function releaseAnchor() {
  if (!anchorEl) return;
  if (anchorPrevName) anchorEl.style.setProperty('anchor-name', anchorPrevName);
  else anchorEl.style.removeProperty('anchor-name');
  anchorEl = null;
  anchorPrevName = '';
}

function showPopupAt(rect) {
  if (!isPopupVisible()) {
    popup.classList.add('visible');
    // Top layer: page transforms and overflow clipping can't reach it.
    try { popup.showPopover(); } catch {}
  }
  // Synchronous, so the card is anchored before the browser ever paints it.
  anchorPopup(rect);
}

let lastCloseTime = 0;
function hidePopup(clearSelection = false) {
  if (!isPopupVisible()) return;
  popup.classList.remove('visible');
  try { popup.hidePopover(); } catch {}
  releaseAnchor();
  popupHistory.length = 0;
  stopFollow();
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
// Oxford US IPA fetcher
// ============================================================
const ipaCache = new Map();

async function fetchOxfordIpa(word) {
  if (!word) return null;
  const clean = word.toLowerCase().trim().replace(/^[^a-z0-9'-]+|[^a-z0-9'-]+$/gi, '');
  if (!clean) return null;
  if (ipaCache.has(clean)) return ipaCache.get(clean);

  const targetUrl = `https://www.oxfordlearnersdictionaries.com/search/english/direct/?q=${encodeURIComponent(clean)}`;
  const extractIpa = (html) => {
    if (!html) return null;
    const m = html.match(/class=["']phons_n_am["'][^>]*>[\s\S]*?<span class=["']phon["']>([^<]+)<\/span>/i)
           || html.match(/class=["']phon["']>([^<]+)<\/span>/i);
    return m ? m[1].trim() : null;
  };

  // 1. Try Chrome background service worker first (bypasses CORS using host permissions)
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const resp = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 3500);
        chrome.runtime.sendMessage({ action: 'fetchOxfordHtml', url: targetUrl }, res => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !res) resolve(null);
          else resolve(res);
        });
      });
      if (resp?.html) {
        const ipa = extractIpa(resp.html);
        if (ipa) {
          ipaCache.set(clean, ipa);
          return ipa;
        }
      }
    } catch (e) {}
  }

  // 2. Direct fetch fallback
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(targetUrl, { signal: ctrl.signal });
    clearTimeout(id);
    if (res.ok) {
      const html = await res.text();
      const ipa = extractIpa(html);
      if (ipa) {
        ipaCache.set(clean, ipa);
        return ipa;
      }
    }
  } catch (e) {}

  // 3. CORS proxy fallback
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 3500);
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl, { signal: ctrl.signal });
    clearTimeout(id);
    if (res.ok) {
      const html = await res.text();
      const ipa = extractIpa(html);
      if (ipa) {
        ipaCache.set(clean, ipa);
        return ipa;
      }
    }
  } catch (e) {}

  return null;
}

function cleanMeaning(text, phrase) {
  if (!text) return '';
  const cleanWord = phrase.trim().replace(/^[^a-zA-Z0-9'-]+|[^a-zA-Z0-9'-]+$/g, '') || phrase.trim();
  const esc = cleanWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let cleaned = text.replace(new RegExp('^\\s*(?:\\*{1,2}' + esc + '\\*{1,2}|' + esc + ')\\s*(?:\\/[^\\/]+\\/)?\\s*[:\\-–—]?\\s*', 'i'), '');
  cleaned = cleaned.replace(/^\s*[:\-–—]\s*/, '');
  return cleaned;
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
async function sendToLLM(text, metaLabel, followup, silent, heading, actionKey, ipaPromise) {
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
  let smoother = null;
  let currentShown = '';

  let ipa = null;
  let ipaPending = !!ipaPromise;
  if (ipaPromise) {
    ipaPromise.then(res => {
      ipa = res;
      ipaPending = false;
      if (replyDiv && smoother) updateStreamDisplay();
    }).catch(() => {
      ipaPending = false;
      if (replyDiv && smoother) updateStreamDisplay();
    });
  }

  function formatReplyText(rawText) {
    if (!ipaPromise || !followup?.phrase) return rawText;
    const displayWord = followup.phrase.trim().replace(/^[^a-zA-Z0-9'-]+|[^a-zA-Z0-9'-]+$/g, '') || followup.phrase.trim();
    const cleaned = cleanMeaning(rawText, followup.phrase);
    let prefix = '';
    if (ipa) {
      prefix = `**${displayWord}** ${ipa}: `;
    } else if (ipaPending) {
      prefix = `**${displayWord}** /.../: `;
    } else {
      prefix = `**${displayWord}**: `;
    }
    return prefix + cleaned;
  }

  function updateStreamDisplay() {
    if (!replyDiv) return;
    const textToRender = formatReplyText(currentShown);
    replyDiv.innerHTML = renderMarkdown(closeDanglingMarkdown(textToRender.trim()));
    kickFollow();
  }

  // Both the card's height and the scroll position are eased toward where the
  // content wants them rather than set outright: set outright, every new line
  // landed as a jump (the card grew a whole line-height in one frame, or, once
  // at full height, the transcript scrolled by one). One rAF loop
  // (startFollow) does both until they settle, then hands the height back to
  // CSS.
  let expectedScrollTop = -1;
  let userInterrupted = false;
  const SCROLL_TOLERANCE = 5;

  function ensureReply() {
    if (replyDiv) return;
    if (pending) { pending.remove(); pending = null; }
    const cls = (actionKey === 'ex' || heading === 'EXAMPLE') ? 'a ex' : 'a';
    replyDiv = popupWrite('', cls, { scroll: false });
    replyDiv.classList.add('cursor');
    expectedScrollTop = -1;
    userInterrupted = false;
    startFollow(replyDiv, () => smoother.settled);
    smoother = smoothStream(shown => {
      currentShown = shown;
      updateStreamDisplay();
    });
  }

  function followStep(el) {
    if (!el.isConnected) return false;
    let moving = false;

    // Height: what CSS alone would give, then a step toward it.
    const held = popupContent.style.height;
    popupContent.style.height = '';
    const natural = popupContent.getBoundingClientRect().height;
    popupContent.style.height = held;
    const current = popupContent.getBoundingClientRect().height;
    let eased = natural;
    if (Math.abs(natural - current) > 0.5) {
      eased = current + (natural - current) * FOLLOW_EASE;
      moving = true;
    }
    popupContent.style.height = eased + 'px';

    if (!userInterrupted) {
      if (expectedScrollTop >= 0
          && Math.abs(popupOut.scrollTop - expectedScrollTop) > SCROLL_TOLERANCE) {
        userInterrupted = true;
      } else {
        const containerRect = popupOut.getBoundingClientRect();
        const replyRect = el.getBoundingClientRect();
        const replyTopOffset = replyRect.top - containerRect.top + popupOut.scrollTop;
        // Max scroll once the height has caught up, not at this frame's
        // height: scrolling into the lag would pull the text up only to let
        // it drop back as the height arrives.
        const maxScroll = popupOut.scrollHeight - popupOut.clientHeight - (natural - eased);
        const target = Math.min(
          Math.max(0, maxScroll),
          Math.max(0, replyTopOffset - 4),
        );
        const from = popupOut.scrollTop;
        if (Math.abs(target - from) > 0.5) {
          popupOut.scrollTop = from + (target - from) * FOLLOW_EASE;
          moving = true;
        } else {
          popupOut.scrollTop = target;
        }
        expectedScrollTop = popupOut.scrollTop;
      }
    }
    return moving;
  }

  // One follow loop for the whole popup, not one per reply: the previous
  // reply's loop may still be settling when the next one starts.
  function startFollow(el, isSettled) {
    stopFollow();
    let raf = 0;
    const tick = () => {
      raf = 0;
      const moving = followStep(el);
      if (!el.isConnected || (!moving && isSettled())) { stopFollow(); return; }
      // Idle while streaming with nothing new: the next revealed frame kicks
      // it again.
      if (moving) raf = requestAnimationFrame(tick);
    };
    kickFollow = () => { if (!raf) raf = requestAnimationFrame(tick); };
    stopFollow = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      popupContent.style.height = '';
      kickFollow = () => {};
      stopFollow = () => {};
    };
  }

  try {
    // Any failure falls through to the next model in the list, starting from
    // the selected one: a 429, but also an overloaded or retired model, a
    // model whose provider has no key, a request over the per-minute token cap
    // (Groq sends that as 413, not 429), or an empty answer. The model that
    // does answer becomes the selection, so the next lookup starts there. An
    // error is shown only once every model has failed — one line per model.
    // The swap itself is silent: which model ends up answering isn't something
    // you can act on mid-lookup.
    if (followup) renderActionsBar(followup.phrase, followup.context);
    const models = settings.models.slice();   // onChanged may swap the list mid-loop
    const first = Math.max(0, models.indexOf(currentModel(models, settings.selectedModelId)));
    const failures = models.length ? [] : ['no model configured — add one in Extension Settings'];
    for (let i = 0; i < models.length; i++) {
      const cfg = models[(first + i) % models.length];
      try {
        for await (const chunk of llmStream(cfg, popupHistory, `Đừng dùng bảng để format. Hãy trả lời ngắn gọn, súc tích`)) {
          ensureReply();
          reply += chunk;
          smoother.push(chunk);
        }
        if (!reply) throw new Error('(no response)');
        await smoother.end();
        kickFollow();   // let the height/scroll settle and hand height back to CSS
        replyDiv.classList.remove('cursor');
        if (ipaPromise) {
          try { ipa = await ipaPromise; } catch {}
          ipaPending = false;
        }
        const finalContent = formatReplyText(reply);
        replyDiv.innerHTML = renderMarkdown(finalContent.trim());
        popupHistory.push({ role: 'assistant', content: finalContent });
        if (cfg.id !== settings.selectedModelId) {
          settings.selectedModelId = cfg.id;
          chrome.storage.local.set({ selectedModelId: cfg.id });
        }
        break;
      } catch (err) {
        failures.push(`${cfg.model}: ${err.message}`);
        // A model that started answering and then failed leaves a half reply;
        // drop it, and put the plain spinner back (ensureReply removed it the
        // moment the first chunk landed) for the next model.
        if (smoother) { smoother.cancel(); smoother = null; }
        stopFollow();
        if (replyDiv) { replyDiv.remove(); replyDiv = null; }
        reply = '';
        currentShown = '';
        if (!pending) pending = popupWrite('...', 'sys');
      }
    }
    if (failures.length === Math.max(1, models.length)) {
      if (pending) pending.remove();
      popupHistory.pop();
      popupWrite('error: ' + failures.join('\n') + '\n\n', 'e');
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
  const ctxNote = context && context !== phrase ? ` Context: "${context}".` : '';

  // The popup prints the section label itself (see sendToLLM's `heading`), so
  // a model that also prints one would double it up.
  const noHeading = 'Không in tiêu đề.';

  [3].forEach(n => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'action';
    a.textContent = 'more';
    a.title = `Re-run with ${n} sentences of context`;
    if (spentActions.has('more')) markSpent(a);
    a.onclick = async (e) => {
      e.preventDefault();
      if (spentActions.has('more')) { scrollToSpent('more'); return; }
      if (popupBusy || !lastLookup) return;
      spentActions.set('more', null);
      markSpent(a);
      const context = extractContextFromRange(lastLookup.range, n);
      const prompt = `Phân tích "${phrase}" theo hiểu biết của bạn, tối đa 50 từ, một đoạn liền. Ngữ cảnh: "${context}"`;
      sendToLLM(prompt, null, null, true, 'MORE', 'more');
    };
    popupActions.appendChild(a);
  });

  if (phrase.trim().split(' ').length > 1) return;

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
  *[câu chỉ hợp với từ này]*
- Văn phong: trang trọng/trung tính/đời thường/lóng/chuyên ngành; sắc thái: tích cực/trung tính/tiêu cực. Chỉ ghi giá trị, không nhãn.
- Mỗi từ khác ở một điểm riêng; cấm "trang trọng hơn", "mạnh hơn" mà không nói hơn ở đâu.
- Ví dụ tiếng Anh, mô tả tiếng Việt. ${noHeading}`;

  // [button label, prompt, tooltip, heading drawn above the answer]
  const items = [
    ['syn', synonymPrompt, 'Synonyms', 'SYNONYM'],
    ['ant', `A few antonyms of "${phrase}".${ctxNote} Reply with only the words, comma-separated.`, 'Antonyms', 'ANTONYM'],
    ['ex',  `3 short, varied example sentences using "${phrase}" in the same sense.${ctxNote} One per line starting with •, keyword in bold. Nothing else.`, 'Examples', 'EXAMPLE'],
    ['use', `Độ thông dụng của "${phrase}" trong tiếng Anh hiện đại (thang 1-100). Chỉ trả về: [mức độ] - [văn phong].`, 'Usage frequency', 'USAGE'],
    ['ety', `Từ nguyên của "${phrase}", ngắn gọn. ${noHeading}`, 'Etymology', 'ETYMOLOGY'],
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
  stopFollow();
  popupOut.innerHTML = '';
  popupActions.innerHTML = '';
  spentActions.clear();          // new word — every action is available again
  popupForm.hidden = true;

  const is_a_word = phrase.trim().split(/\s+/).length === 1;
  // The sentence only picks the sense (and part of speech) — it is not to be translated.
  const ctxBlock = local ? `\nCâu (chỉ để chọn nét nghĩa, không dịch): """${local}"""` : '';
  const prompt = is_a_word
    ? `Nghĩa tiếng Việt của riêng từ "${phrase}".${ctxBlock}
Trả về đúng 1 dòng: nghĩa
- Nghĩa ngắn như từ điển (1-4 từ), tối đa 2 nghĩa ngăn bằng dấu phẩy; không lấy nghĩa cả thành ngữ chứa từ.
- Không thêm gì khác. Vd câu "We sat on the river bank." → bờ, bờ sông`
    : `Nghĩa tiếng Việt của riêng cụm "${phrase}".${ctxBlock}
Trả về đúng 1 dòng: **${phrase}**: nghĩa
- Nghĩa ngắn như từ điển, không phải câu; thành ngữ thì trả nghĩa thành ngữ.
- Không phiên âm, không thêm gì khác. Vd **gave up**: từ bỏ, cai`
  const ctxLabel = sentenceCount > 1 ? ` (ctx: ${sentenceCount})` : '';
  const ipaPromise = is_a_word ? fetchOxfordIpa(phrase) : null;
  sendToLLM(prompt, `meaning: "${phrase}"${ctxLabel}`, { phrase, context: local }, true, null, null, ipaPromise);
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
chrome.storage.local.get([...MODEL_STORE_KEYS, 'contextSentences', 'popupWordSpacing', 'popupTheme', 'apiKeys'], (res) => {
  const store = readModelStore(res);
  settings.models = store.models;
  settings.selectedModelId = store.selectedModelId;
  if (res.contextSentences !== undefined) settings.contextSentences = res.contextSentences;
  if (res.popupWordSpacing !== undefined) settings.popupWordSpacing = res.popupWordSpacing;
  if (res.popupTheme !== undefined) settings.popupTheme = res.popupTheme;
  if (res.apiKeys !== undefined) settings.apiKeys = res.apiKeys;
  applyWordSpacing();
  applyTheme();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.models) settings.models = normaliseModels(changes.models.newValue);
  if (changes.selectedModelId) settings.selectedModelId = changes.selectedModelId.newValue;
  if (changes.contextSentences) settings.contextSentences = changes.contextSentences.newValue;
  if (changes.popupWordSpacing) {
    settings.popupWordSpacing = changes.popupWordSpacing.newValue;
    applyWordSpacing();
  }
  if (changes.popupTheme) {
    settings.popupTheme = changes.popupTheme.newValue;
    applyTheme();
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
