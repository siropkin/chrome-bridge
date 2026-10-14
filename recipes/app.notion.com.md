# app.notion.com — replace an image block with a local file

- preconditions: the page is open and you're logged in. You need the image's block id: it's the `notion_record=block.<id>` part of the image URL that the Notion MCP fetch returns, or the `data-block-id` attribute on `.notion-image-block`.

```bash
# verified 2026-10-02 against chrome-bridge 1.26.2
T=id:<tabId>; B='[data-block-id="<block-id>"]'
node cli.mjs scroll $T "$B"
node cli.mjs snap $T "$B"                          # → figure @eF
node cli.mjs click $T @eF --trusted                # shows the image toolbar
node cli.mjs snap $T | grep 'Open block actions menu'   # → @eM
node cli.mjs click $T @eM --trusted
node cli.mjs snap $T '[role=dialog]' | grep 'option "Replace"'   # → @eR
node cli.mjs click $T @eR --trusted                # opens the "Embed" dialog
node cli.mjs snap $T '[role=dialog]' | grep 'Upload image'       # → @eU
node cli.mjs upload $T @eU ./new.png --chooser     # intercepts the OS picker
node cli.mjs eval $T "document.querySelector('$B img').naturalWidth"  # verify
```

- gotchas:
  - A plain (synthetic) click on the figure does nothing. You need `--trusted`, because the toolbar only appears on real pointer events.
  - The page has no `input[type=file]` before you click upload. Use `upload --chooser` on the "Upload image" button.
  - The Notion MCP `update_content` can't swap an image: the old image's S3 URL is re-signed on every read, so `old_str` never matches.
  - Full-page snaps get cut off at 300 nodes. Scope them with `'[role=dialog]'` or the block selector.
