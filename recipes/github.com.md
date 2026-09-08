# github.com — set a repository's social preview image

- preconditions: repo settings page (`https://github.com/<owner>/<repo>/settings`), owner logged in (repo Settings is admin-only). The driven tab must be the one with the GitHub session — check `profiles` if several are connected.

```bash
# verified 2026-09-08 against chrome-bridge 1.18.11
node cli.mjs nav <match> https://github.com/<owner>/<repo>/settings
node cli.mjs wait <match> --text "Social preview"
node cli.mjs snap <match>            # full snap — Social preview's Edit sits under the
                                     # "Download template" link; refs differ per page load
node cli.mjs click <match> @<edit>    # opens a menu: "Upload an image…" / "Remove image"
node cli.mjs snap <match> --diff      # VERIFY the ref before clicking — the two menuitems
                                     # are adjacent; "Remove image" is one ref away
node cli.mjs click <match> @<upload>
node cli.mjs upload <match> '#repo-image-file-input' ./image.png
```

- gotchas:
  - **No crop dialog**: unlike avatars, the repo social preview applies directly — `wait --text "Set new image"` never fires. The upload goes `is-uploading` → `is-default` and looks like it failed; confirm server-side by checking the og:image meta tag on the repo page.
  - **Verify via the meta tag, not `opengraph.githubassets.com`**: the auto-card URL answers even when a custom preview is set. Fetch the repo page and read `og:image` — a live custom preview points at `repository-images.githubusercontent.com/<repo-id>/…`; compare bytes with the local file for certainty.
  - **`upload` needs the form open**: target `#repo-image-file-input` only after clicking "Upload an image…" (it attaches the file-attachment form). Uploading before that sets files on a node the uploader never reads (`files: 0`, `is-default`, "uncertain" verdict).
  - **`net` + `upload` can't run together**: both attach the debugger; the second attach kills the first's capture — nets come back empty. Diagnose upload failures via `eval` on `file-attachment`'s className, not via `net`.
  - **Flash noise**: a red flash "You can't perform that action at this time." can appear during a failing-looking attempt while the upload actually succeeds — trust the og:image check, not the flash.
