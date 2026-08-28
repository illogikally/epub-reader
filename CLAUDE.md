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

## Push straight to master

When the user does ask for a push, and no other branch has been specified for the task, push straight to `master` — skip making a feature branch and skip opening a PR. Commit directly on `master` (or fast-forward it) and push there. Only use a separate branch when the user explicitly asks for one, or when a specific task setup designates one (e.g. a harness-assigned branch for a given session).
