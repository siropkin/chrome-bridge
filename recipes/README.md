# recipes — verified per-domain flows

A recipe encodes a flow this bridge has already run successfully on one site: the login wall, the quirky composer, the flair picker, the export dance. Reading one before acting replaces re-deriving the flow with 20 exploratory commands — the first working run is expensive, every later one is a replay.

## Reading

Before driving a site you'll revisit, check `recipes/<domain>.md` here (`domain` = the site's registrable name: `devto.md`, `linkedin.md`). `AGENTS.md` points here.

## Writing one (after a verified run)

1. Run the flow with the bridge and verify it worked — end state included (the toast, the saved draft, the posted comment).
2. `node cli.mjs history <match> --batch /tmp/flow.batch` — the recorded commands, exported replayable.
3. Prune to intent: drop exploratory reads and dead ends, keep preconditions (URL, what must be loaded/logged-in), the sequence, and the site-specific gotchas — what broke on the first tries and the workaround that worked is the part no re-derivation can recover cheaply.
4. Save as `recipes/<domain>.md` in your chrome-bridge checkout and commit locally. Upstream a recipe only when it's generally useful — a login-wall workaround is, a personal bookmarking flow isn't.
5. Stale = delete. A recipe that no longer reproduces costs more than re-deriving the flow; after a site redesign, re-verify before trusting one.

## Skeleton

```markdown
# <site> — <what the flow does>

- preconditions: <URL shape, login state, extension version quirk if it mattered>

```bash
# verified <date> against chrome-bridge <version>
node cli.mjs <command> …   # the sequence, as a replayable batch
```

- gotchas: <what broke on the first tries, the fix that worked>
```
