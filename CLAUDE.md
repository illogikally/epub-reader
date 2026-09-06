# Project conventions for Claude

## Commit after every modification — no confirmation needed

The user has granted blanket, standing authorization to commit changes in this repo. After any modification you make (edit, create, delete), commit it **immediately and automatically** — do **not** ask "should I commit?", do **not** wait for approval, do **not** announce that you're about to commit. Just run `git add` + `git commit` as part of the same turn that produced the change. Treat the commit as part of the edit, not as a separate step requiring confirmation.

This standing authorization covers all `git add` and `git commit` invocations in this repo. It does **not** cover `git push`, force-pushes, history rewrites, or branch deletions — still ask for those.

Workflow per modification:

1. Make the edit.
2. `git add <specific files you touched>` — never `git add -A` / `git add .` (the tree often carries unrelated dirty files; don't sweep them in). Note this is about *unrelated* files only: `chrome-extension/*` is a real, maintained part of this repo — see the two-copies section below — so stage it whenever you actually changed it.
3. `git commit -m "<concise message>"` — match the existing terse style in `git log` (e.g. `save`, or a short imperative description of what changed).
4. Move on.

If a single user request requires several logically distinct edits, commit each one separately as you go rather than bundling them at the end.

Do not push to a remote unless the user explicitly asks.

## Always bump the app version with every code change

This app has no build step and no service worker — cache-busting is a hand-maintained `?v=N` query string appended to `css/reader.css` and every `js/*.js` import (see the comment at `index.html` near the closing `<script>` tags). iOS's WKWebView (Safari, and any other iOS browser — they're all WKWebView under the hood) caches these very aggressively, so if `?v=N` isn't bumped, a phone can keep silently running old JS/CSS after a push, which is exactly what happened for several rounds before this rule was added: fixes were pushed, `?v=41` was never bumped, and the phone kept serving the pre-fix files with no error and no visible sign anything was stale.

So, on **every** code change to this repo (not just this one file — any `.js` or `.css` edit):

1. Increment `APP_VERSION` in `js/debug.js` by 1.
2. Update every `?v=N` occurrence in `index.html` and all `js/*.js` files to that same new number (`grep -rn '?v=' index.html js/*.js` to check nothing was missed).

Do this as part of the same commit as the change itself — it's cheap (a constant bump plus a global find/replace) and it's the one thing that would have caught the stale-cache bug immediately: `APP_VERSION` is shown at the bottom of the Settings sheet ("Version N"), so "does your Settings say the number I expect?" is now a one-glance check instead of a guess.

## Push straight to master

When the user does ask for a push, and no other branch has been specified for the task, push straight to `master` — skip making a feature branch and skip opening a PR. Commit directly on `master` (or fast-forward it) and push there. Only use a separate branch when the user explicitly asks for one, or when a specific task setup designates one (e.g. a harness-assigned branch for a given session).

## There are TWO copies of the translation feature — check both

The select-text → LLM-lookup popup exists **twice**, as two independent implementations of the same feature. Neither imports the other; there is no shared module. A change to one is silently absent from the other unless it is ported by hand.

| | Reader (the web app) | Chrome extension |
|---|---|---|
| Entry point | `js/translate.js` (~1000 lines) | `chrome-extension/js/content.js` (~650 lines) |
| Styles | `css/reader.css` (`#popup`, `.action`, …) | `chrome-extension/css/content.css` (`#llm-popup`, `.llm-*`) |
| Model registry | `js/state.js` (exported ES module) | `chrome-extension/js/models.js` (plain globals — content scripts aren't modules) |
| Settings UI | Settings sheet in `index.html` | `chrome-extension/popup.html` + `js/popup.js` |
| Storage | `settings` in `state.js` (localStorage + Dropbox sync) | `chrome.storage.local` |
| Where it runs | inside the epub.js iframe, via `js/touchselect.js` (custom coarse-pointer selection) | any page, on the native `window.getSelection()` |

What is duplicated, and therefore drifts: `streamSSE` / `streamOpenAI` / `llmStream`, `sendToLLM`, `popupWrite` / `renderMarkdown`, `showPopupAt` / `hidePopup` / outside-click handling, `extractContextFromRange`, `doLookup` and its meaning prompt, and `renderActionsBar` with the whole deep/syn/ant/ex/use/ety prompt set.

Deliberate differences — do **not** "fix" these by making them match:

* **Providers.** The reader is Groq-only (`GROQ_URL`, `GROQ_KEY_REF` in `state.js`). The extension speaks Groq *and* Gemini through a `PROVIDERS` table + `VENDORS` map (`streamOpenAI` / `streamGoogle`) in `models.js`/`content.js`.
* **429 fallback.** The extension rotates to the next model in the list on a rate-limit error and persists that selection; the reader just surfaces the error.
* **`deep` action.** The reader uses 1 sentence of context and injects the book's `creator`/`title` from epub metadata; the extension uses 3 sentences and has no book to draw metadata from.
* **Spent actions.** The reader marks each action link one-shot (`spentActions`); the extension lets you click them repeatedly.
* **Cache-busting.** The `?v=N` rule above applies only to the reader's `index.html` / `js/*.js`. The extension has no `?v=` — it's versioned by `chrome-extension/manifest.json` and reloaded from `chrome://extensions`.

So, when asked to change lookup behaviour or prompt wording:

1. Assume it means **both** unless the user names one. If the ask is genuinely reader-only (anything touching epub metadata, TOC, reading progress) or extension-only (Gemini, `chrome.storage`), say so.
2. Grep for the thing you're editing across both trees before you start — e.g. `grep -rn 'ETYMOLOGY' js/ chrome-extension/` — so you find the second copy rather than assuming it doesn't exist.
3. Port the change, adapting to the local idioms (ES import vs. global, `settings.x` vs. `chrome.storage.local`, `#popup` vs. `#llm-popup`).
4. Commit the two edits separately (`Lookup prompt: …` then `extension: same lookup prompt rewrite as the reader`) — that's the existing style in `git log`, and it makes the port auditable.
