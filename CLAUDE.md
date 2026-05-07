# Project conventions for Claude

## Commit after every modification

After any change you make to files in this repo (edit, create, delete), immediately create a git commit containing that change. Do not batch multiple unrelated changes into one commit, and do not leave the working tree dirty between turns.

Workflow per modification:

1. Make the edit.
2. `git add` the specific files you touched (avoid `git add -A` / `git add .` so you don't sweep in unrelated files).
3. `git commit -m "<concise message>"` — match the existing terse style in `git log` (e.g. `save`, or a short imperative description of what changed).
4. Move on to the next change.

If a single user request requires several logically distinct edits, commit each one separately as you go rather than bundling them at the end.

Do not push to a remote unless the user explicitly asks.
