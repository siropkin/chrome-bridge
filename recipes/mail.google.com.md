# mail.google.com — search: run a query from the search box

- preconditions: logged-in mail.google.com tab in the FOREGROUND (trusted input refuses hidden tabs — `activate <match>` first; still-hidden warnings mean the window is occluded, `emulate <match> focus` flips that).

```bash
# verified 2026-09-30 against chrome-bridge 1.25.2
node cli.mjs snap mail.google.com                       # textbox "Search mail" @eN, button "Search mail" @eM
node cli.mjs activate mail.google.com
node cli.mjs fill mail.google.com @eN 'from:me in:anywhere'
node cli.mjs press mail.google.com Enter @eN --trusted  # hash → #search/…, list re-renders (114 rows in the verified run)
node cli.mjs click mail.google.com @eM --trusted        # the Search button works too — trusted only
```

- gotchas:
  - **Synthetic input is a dead end on Gmail search** (#50): synthetic `press Enter` fires the router (hash → `#search/…`, title "Search results") but the conversation list can stay STALE — old inbox rows under a Search-results title — and synthetic `click` on the Search button does nothing at all. Both report plain success on old builds; on ≥1.25.2 the no-op paths carry `— no observable page effect … --trusted`. Trust that warning.
  - **Before 1.25.2 even `--trusted` Enter was a no-op** (the CDP keyDown carried no `text`, so Blink fired no keypress and ran no implicit submit). If `press Enter --trusted` doesn't move the hash, upgrade.
  - **The empty-result trap**: after a search the `tr.zA` rows can take 10–20s to render. A `document.querySelectorAll('tr.zA').length` of 0 immediately after the hash change is NOT "no matches" — wait and re-read; the genuine empty state renders "No messages matched your search" text.
  - Last-resort bypass that skips the app's key handling entirely: `nav mail.google.com "https://mail.google.com/mail/u/0/#search/<query>"` then `eval mail.google.com "location.reload()"` (subject to the same render lag).
