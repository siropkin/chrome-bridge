# linkedin.com — messaging: read threads, reply in a conversation

- preconditions: logged-in linkedin.com tab; conversation list at `/messaging/`.

```bash
# verified 2026-09-12 against chrome-bridge 1.19.1 (the gotchas below produced
# tickets #22/#23/#28 — fixed/recorded after this run)
node cli.mjs tabs linkedin
node cli.mjs snap linkedin.com/messaging          # conversation rows get @eN refs
node cli.mjs click linkedin.com/messaging @eN --trusted   # open a conversation
node cli.mjs shot linkedin.com/messaging /tmp/thread.png  # VERIFY the switch (see gotchas)
node cli.mjs type linkedin.com/messaging @eComposer "reply text"
node cli.mjs press linkedin.com/messaging Enter
```

- gotchas:
  - **Conversation rows ignore synthetic clicks** — `click @eN` reported success and switched nothing; only `--trusted` (CDP Input) opens the thread. Same for `hover`: the per-message action bar does not appear for synthetic pointer events.
  - **The list re-sorts after you send** (most-recent-first). Every @eN captured before a send is suspect afterward — re-snap before the next click. Since the stale-ref guard, acting on a pre-send ref fails loudly (`was "…" at snap time, now resolves to "…"`); before it, the click silently landed on the wrong conversation and a reply went to the wrong person. Never batch `click row → type → send` across two conversations without a re-snap in between.
  - **The previous thread's DOM stays mounted** (hidden) while the new one loads: `eval` reads of `.msg-s-message-list__event` can return the STALE conversation and a verification then "passes" against the wrong thread. Verify a switch by the *visible* thread header instead: a `shot`, or an eval that filters by visibility — `[...document.querySelectorAll('.msg-s-message-list__event')].filter(e => e.checkVisibility())` (or `offsetParent !== null`) — never the first match in document order. Same pattern likely applies to other Ember/virtualized-list apps (Gmail conversation views too).
  - **The inbox switcher (Focused/Other/Archived/Spam pill) fights automation** (verified 2026-09-12, #44): a synthetic `click` on the pill toggles the dropdown unpredictably between CLI calls, and even with the button reading `expanded` the dropdown list is intermittently ABSENT from the snap tree — and re-snapping collapses it. What works, in order of preference:
    1. `activate` the tab first, then `click @pill --trusted`, then snap and `click @item --trusted`. Trusted input toggles the menu reliably; synthetic does not.
    2. If the snap shows the pill expanded but no `list "Focused Other Archived Spam"`, don't trust the tree — read the menu page-side: `eval <match> "[...document.querySelectorAll('.msg-inbox-switcher__dropdown-content button, [role=menu] [role=menuitem], .msg-inbox-switcher__option')].map(e => e.textContent.trim())"`, then click the item in the SAME eval (`…find(…).click()`), all in one tick. Never insert a `snap` between opening the menu and clicking the item — the extra CLI round trip is when it collapses.
    3. Verify the switch by the list header (`wait <match> --text "Other"` on the inbox heading) or a `shot`, not by the pill's aria state — it lags the real switch.
    Budget note: the first switch attempt taught ~8 failed combinations (synthetic vs trusted × re-snap loops). Follow the order above.
