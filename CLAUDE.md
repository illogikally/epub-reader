# Project conventions for Claude

## Commit after every modification — no confirmation needed

The user has granted blanket, standing authorization to commit changes in this repo. After any modification you make (edit, create, delete), commit it **immediately and automatically** — do **not** ask "should I commit?", do **not** wait for approval, do **not** announce that you're about to commit. Just run `git add` + `git commit` as part of the same turn that produced the change. Treat the commit as part of the edit, not as a separate step requiring confirmation.

This standing authorization covers all `git add` and `git commit` invocations in this repo. It does **not** cover `git push`, force-pushes, history rewrites, or branch deletions — still ask for those.

Workflow per modification:

1. Make the edit.
2. `git add <specific files you touched>` — never `git add -A` / `git add .` (don't sweep in unrelated files like the pre-existing dirty `chrome-extension/*` and `js/translate.js`).
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
