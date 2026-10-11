# Claude Web UI

## Branches

- All work lands on the default branch (`kore`). Commit there directly.
- No feature branches, no worktrees, unless Gabriel asks for one by name. If a branch was needed for a transient reason, merge it into `kore` and delete it in the same task.
- Several Claude sessions may edit this checkout at once. Before editing `public/*` or `server.mjs`, run `git status`; make small anchored edits, never whole-file rewrites, and commit as soon as a step is verified.

## Look and feel

- The interface mirrors claude.ai: no accent-coloured borders on inputs or the composer, Chat/Cowork toggle and model picker inside the composer, a single-row pill composer in conversations with the "Claude is AI…" footer, title as a dropdown, accordion side panel.
- Verify changes in the browser pane with this session's own server (`PORT=<free port> NO_OPEN=1 node server.mjs`; the tokenized link is printed on start). Port 3737 belongs to another session's server.
