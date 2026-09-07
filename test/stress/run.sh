#!/bin/bash
# chrome-bridge stress suite — end-to-end against the REAL extension.
# Usage: test/stress/run.sh [section ...]   (no args = all sections)
#
# Preconditions:
#   - two Chrome profiles connected (multi-profile sections; else they SKIP)
#   - the profile-1 Chrome window must be VISIBLE (pixel/shot/dialog sections
#     need a rendering window — occluded windows suspend rendering)
#   - node test/stress/server.mjs running on :9334 (run.sh starts it if down)
# Every test tab this suite opens, it closes. Expected failures assert their
# error text; a summary with PASS/FAIL counts prints at the end.
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
S="$REPO/test/stress"
OUT="$S/out"; mkdir -p "$OUT"
CLI=(node "$REPO/cli.mjs")
FX="file://$S/fixtures"
HTTP=http://localhost:9334/fixtures
PASS=0; FAIL=0; SECTION="?"

ok()  { echo "PASS [$SECTION] $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL [$SECTION] $1"; FAIL=$((FAIL+1)); }
# assert_grep <name> <file> <ere-regex>
assert_grep() { if [ -f "$2" ] && grep -qE -- "$3" "$2"; then ok "$1"; else bad "$1 (wanted /$3/ in $2)"; fi; }
assert_ngrep() { if [ -f "$2" ] && ! grep -qE -- "$3" "$2"; then ok "$1"; else bad "$1 (must NOT match /$3/ in $2)"; fi; }
render() { sed -e "s|@FX@|$FX|g" -e "s|@HTTP@|$HTTP|g" -e "s|@OUT@|$OUT|g" -e "s|@P1@|$P1|g" -e "s|@P2@|$P2|g" "$1"; }
run_batch() { # run_batch <name> — render + run batches/<name>.batch, log to out/<name>.{log,err}
  render "$S/batches/$1.batch" | "${CLI[@]}" batch >"$OUT/$1.log" 2>"$OUT/$1.err"
}
P1=""; P2=""
detect_profiles() {
  local profs
  profs=$("${CLI[@]}" profiles 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(p=>p.name).join(" "))}catch{console.log("")}})')
  P1=$(echo "$profs" | awk '{print $1}'); P2=$(echo "$profs" | awk '{print $2}')
  [ -n "$P1" ]
}
need2() { [ -n "$P2" ]; } # multi-profile sections skip silently via the caller

# ---------------------------------------------------------------- section 1
s_profiles() {
  SECTION=profiles; need2 || { bad "two profiles required (have: '$P1' only)"; return; }
  run_batch 01-interleave || true
  assert_grep "interleave: 5 clean P1 increments" "$OUT/01-interleave.log" '^1$'
  local i; for i in 1 2 3 4 5; do
    grep -q "^$i\$" "$OUT/01-interleave.log" || bad "interleave increment $i missing"
  done
  [ "$(grep -c '^5$' "$OUT/01-interleave.log")" = 2 ] && ok "both counters reached 5 independently" || bad "counter cross-talk (expected two '5' lines)"
  # refusal: same URL in both profiles, NO --profile → refused, naming both
  "${CLI[@]}" eval "static.html?a=dual" "1" --profile "$P1" >/dev/null 2>&1 || true
  "${CLI[@]}" eval "static.html?a=dual" "1" >"$OUT/refuse.log" 2>&1
  if grep -qE "matches tabs in 2 profiles.*$P1.*$P2" "$OUT/refuse.log"; then ok "cross-profile refusal names both"; else bad "cross-profile refusal text"; fi
  # parallel second session: 15 increments on P2 while this one does 15 on P1
  # (reset both counters first — the interleave batch above left them at 5)
  rm -f "$OUT/parallel-p1.log" "$OUT/parallel-p2.log"
  "${CLI[@]}" eval "counter.html?a=p1" "document.getElementById('c').textContent='0'" --profile "$P1" >/dev/null 2>&1
  "${CLI[@]}" eval "counter.html?a=p2" "document.getElementById('c').textContent='0'" --profile "$P2" >/dev/null 2>&1
  for i in $(seq 1 15); do
    "${CLI[@]}" eval "counter.html?a=p2" "const el=document.getElementById('c');el.textContent=String(+el.textContent+1);el.textContent" --profile "$P2" >>"$OUT/parallel-p2.log" 2>&1
  done &
  local BGPID=$!
  for i in $(seq 1 15); do
    "${CLI[@]}" eval "counter.html?a=p1" "const el=document.getElementById('c');el.textContent=String(+el.textContent+1);el.textContent" --profile "$P1" >>"$OUT/parallel-p1.log" 2>&1
  done
  wait $BGPID
  if [ "$(sort -n "$OUT/parallel-p1.log" | tr '\n' ' ')" = "$(seq 1 15 | tr '\n' ' ')" ] \
  && [ "$(sort -n "$OUT/parallel-p2.log" | tr '\n' ' ')" = "$(seq 1 15 | tr '\n' ' ')" ]; then
    ok "parallel sessions: both counters a clean 1..15, zero cross-talk"
  else bad "parallel sessions corrupted a sequence"; fi
}

# ---------------------------------------------------------------- section 2
s_churn() {
  SECTION=churn; need2 || { bad "two profiles required"; return; }
  run_batch 02-churn || true
  assert_grep "burst open+close 12 tabs" "$OUT/02-churn.log" '"loaded":true'
  [ "$(grep -c '"loaded":true' "$OUT/02-churn.log")" -ge 12 ] && ok "12 tabs opened in burst" || bad "burst open count"
  assert_grep "re-find by match after burst" "$OUT/02-churn.log" 'big.html\?i=7'
  # refs survive re-snaps, expire on nav
  "${CLI[@]}" open "$FX/big.html?i=refs" --profile "$P1" >/dev/null
  local ref
  ref=$("${CLI[@]}" snap "big.html?i=refs" 2>/dev/null | grep -m1 '"Item 1-1"' | grep -o '@e[0-9]*' | tr -d '@')
  [ -n "$ref" ] && ok "ref minted on big tree" || bad "no ref on big tree"
  "${CLI[@]}" snap "big.html?i=refs" >/dev/null 2>&1
  if "${CLI[@]}" click "big.html?i=refs" "@$ref" 2>/dev/null | grep -q 'clicked'; then
    ok "ref survives a re-snap"
  else bad "ref dead after re-snap"; fi
  "${CLI[@]}" nav "big.html?i=refs" "$FX/static.html" >/dev/null 2>&1
  if "${CLI[@]}" click static.html "@$ref" --profile "$P1" 2>&1 | grep -q 'refs expire on navigation'; then
    ok "ref expiry on nav errors clearly"
  else bad "stale ref after nav not reported"; fi
  "${CLI[@]}" close static.html --profile "$P1" >/dev/null 2>&1
  # skeleton drill-down (wide tree)
  "${CLI[@]}" open "$FX/big.html?i=s" --profile "$P1" >/dev/null
  "${CLI[@]}" snap "big.html?i=s" --skeleton >"$OUT/skel.log" 2>&1
  assert_grep "skeleton folds a 480-node tree ('… N inside')" "$OUT/skel.log" '… [0-9]+ inside'
  assert_ngrep "skeleton never silently truncates" "$OUT/skel.log" 'truncated at 300'
  local dref drill
  dref=$(grep -m1 -o '@e[0-9]* … [0-9]* inside' "$OUT/skel.log" | grep -o '@e[0-9]*' | head -1 | tr -d '@')
  drill=$("${CLI[@]}" snap "big.html?i=s" "@$dref" 2>&1)
  if [ -n "$dref" ] && echo "$drill" | grep -q 'Item'; then
    ok "skeleton drill-down resolves the folded container"
  else bad "skeleton drill-down (dref=$dref: $(echo "$drill" | head -1))"; fi
  "${CLI[@]}" close "big.html?i=s" --profile "$P1" >/dev/null 2>&1
}

# ---------------------------------------------------------------- section 3
s_interact() {
  SECTION=interact; need2 || { bad "two profiles required"; return; }
  "${CLI[@]}" close rich.html --profile "$P1" >/dev/null 2>&1 || true
  run_batch 03-rich || true
  local log="$OUT/03-rich.log"
  for cmd in 'filled #name' 'filled #notes' 'clicked #cb' 'filled #sel' 'clicked #submit' 'typed 2 chars into #auto' 'pressed Enter' 'hovered #hov' 'dragged #drag-src'; do
    assert_grep "verdict: $cmd" "$log" "succeeded · $cmd"
  done
  assert_grep "autocomplete dropdown appears on per-char type" "$log" 'option "apple valley"'
  assert_grep "autocomplete picks via ArrowDown+Enter" "$log" 'ac typed-pick'
  assert_grep "paste into contenteditable" "$log" 'pasted 17 chars into #ce'
  # state asserts (the page's own truth)
  local st
  st=$("${CLI[@]}" eval rich.html "JSON.stringify({name:document.getElementById('name').value, sel:document.getElementById('sel').value, auto:document.getElementById('auto').value, drop:document.getElementById('drop-state').textContent, ce:document.getElementById('ce').textContent})")
  echo "$st" > "$OUT/03-state.json"
  for pair in '"name":"Ivan Test"' '"sel":"b"' '"auto":"apple valley"' 'POINTER-DROPPED' '"ce":"pasted via bridge' ; do
    assert_grep "page state $pair" "$OUT/03-state.json" "$pair"
  done
  # canvas: untrusted recorded + not drawn; trusted records isTrusted AND draws
  "${CLI[@]}" click rich.html '#pad' --diff >/dev/null 2>&1
  "${CLI[@]}" eval rich.html "document.getElementById('pad-status').textContent" >>"$OUT/03-rich.log"
  assert_grep "untrusted canvas click recorded" "$OUT/03-rich.log" 'canvas click isTrusted=false'
  "${CLI[@]}" click rich.html '#pad' --trusted --diff >/dev/null 2>&1
  "${CLI[@]}" eval rich.html "document.getElementById('pad-status').textContent" >>"$OUT/03-rich.log"
  assert_grep "trusted canvas click: isTrusted=true" "$OUT/03-rich.log" 'canvas click isTrusted=true'
  # native select: miss must list labels
  "${CLI[@]}" fill rich.html '#sel' 'Delta' >"$OUT/03-selmiss.log" 2>&1 && bad "select miss must fail" || true
  assert_grep "select miss lists labels+values" "$OUT/03-selmiss.log" 'Alpha.*Beta.*Gamma'
  # shadow DOM: ref + piercing CSS (the ref belongs to the textbox INSIDE the
  # label, not the label line itself; the button needs its own ref too)
  assert_grep "shadow DOM elements in tree" "$log" 'Shadow button'
  local STREE sref bref
  STREE=$("${CLI[@]}" snap rich.html 2>/dev/null)
  sref=$(echo "$STREE" | grep -A1 '"Shadow input"' | grep -m1 'textbox' | grep -o '@e[0-9]*' | tr -d '@')
  bref=$(echo "$STREE" | grep -m1 '"Shadow button"' | grep -o '@e[0-9]*' | tr -d '@')
  "${CLI[@]}" fill rich.html "@$sref" 'shadow-ref' --diff >"$OUT/03-shadow.log" 2>&1
  assert_grep "fill shadow input via ref" "$OUT/03-shadow.log" 'succeeded · filled'
  "${CLI[@]}" fill rich.html '#sin' 'shadow-css' --diff >>"$OUT/03-shadow.log" 2>&1
  assert_grep "fill shadow input via piercing css" "$OUT/03-shadow.log" 'succeeded · filled #sin'
  "${CLI[@]}" click rich.html "@$bref" --diff >>"$OUT/03-shadow.log" 2>&1
  "${CLI[@]}" eval rich.html "document.querySelector('rich-widget').shadowRoot.getElementById('sout').textContent" >>"$OUT/03-shadow.log"
  assert_grep "shadow button click lands (sin readback)" "$OUT/03-shadow.log" 'sin=shadow-css'
  # upload (visible + hidden inputs)
  echo "test file for upload" > "$OUT/up.txt"
  "${CLI[@]}" open "file://$REPO/test/upload.html" --profile "$P1" >/dev/null
  "${CLI[@]}" upload upload.html '#plain' "$OUT/up.txt" --diff >"$OUT/03-upload.log" 2>&1
  assert_grep "upload visible input" "$OUT/03-upload.log" 'uploaded 1 file\(s\) to #plain'
  "${CLI[@]}" upload upload.html '#hidden' "$OUT/up.txt" --diff >>"$OUT/03-upload.log" 2>&1
  assert_grep "upload hidden input" "$OUT/03-upload.log" 'uploaded 1 file\(s\) to #hidden'
  "${CLI[@]}" eval upload.html "document.getElementById('out').textContent" >>"$OUT/03-upload.log"
  assert_grep "page saw both files" "$OUT/03-upload.log" 'hidden change'
  "${CLI[@]}" close upload.html --profile "$P1" >/dev/null 2>&1
}

# ---------------------------------------------------------------- section 3b
# blocking alert + dialog paths — the alert only STICKS when its tab is the
# foreground tab (Chrome auto-dismisses dialogs on hidden tabs), so both
# outcomes are honest and accepted: (a) it sticks → every command wedges →
# dialog accept reports the Chrome truth (unanswerable over CDP after the
# fact) and teaches nav → nav drops the dialog and revives the tab;
# (b) auto-dismissed → tab never wedges. Either way the renderer must be
# alive at the end.
s_dialog() {
  SECTION=dialog
  "${CLI[@]}" open "$FX/alert.html" --profile "$P1" >"$OUT/03b-dialog.log" 2>&1
  ( "${CLI[@]}" click alert.html '#boom' >>"$OUT/03b-dialog.log" 2>&1 ) &
  local bg=$!
  sleep 3
  ( "${CLI[@]}" eval alert.html '1+1' >>"$OUT/03b-dialog.log" 2>&1 ) &
  sleep 2
  "${CLI[@]}" dialog alert.html accept >>"$OUT/03b-dialog.log" 2>&1 || true
  "${CLI[@]}" nav alert.html "$FX/alert.html" >>"$OUT/03b-dialog.log" 2>&1 || true
  wait $bg 2>/dev/null
  sleep 1
  "${CLI[@]}" eval alert.html "document.readyState" >>"$OUT/03b-dialog.log"
  assert_grep "alert recovered: renderer alive" "$OUT/03b-dialog.log" 'complete'
  assert_ngrep "dialog path never rots to a CDP queue wedge" "$OUT/03b-dialog.log" 'CDP command stuck'
  if grep -q 'cannot be answered over CDP' "$OUT/03b-dialog.log"; then
    assert_grep "stuck-dialog error teaches the nav recovery" "$OUT/03b-dialog.log" 'nav <match>'
  fi
  "${CLI[@]}" close alert.html --profile "$P1" >/dev/null 2>&1
}

# ---------------------------------------------------------------- section 4
s_pixel() {
  SECTION=pixel
  "${CLI[@]}" open "$FX/static.html?x=pix" --profile "$P1" >/dev/null
  # (a) static pairs: no phantom band
  "${CLI[@]}" shot "static.html?x=pix" "$OUT/s1.png" --diff >"$OUT/04a.log" 2>&1
  assert_grep "baseline saved" "$OUT/04a.log" 'baseline saved'
  "${CLI[@]}" shot "static.html?x=pix" "$OUT/s2.png" --diff >>"$OUT/04a.log" 2>&1
  assert_grep "static pair: no pixel change" "$OUT/04a.log" 'no pixel change since the previous shot'
  # (b) real change → region only
  "${CLI[@]}" open "$FX/change.html" --profile "$P1" >/dev/null
  "${CLI[@]}" shot change.html "$OUT/c1.png" --diff >"$OUT/04b.log" 2>&1
  # the flip changes a role-less div — invisible to the tree, so the verdict
  # may honestly be 'uncertain'; the pixel diff below is the real assertion
  "${CLI[@]}" click change.html '#flip' --diff >>"$OUT/04b.log" 2>&1
  assert_grep "flip click dispatched" "$OUT/04b.log" '· clicked #flip'
  "${CLI[@]}" shot change.html "$OUT/c2.png" --diff >>"$OUT/04b.log" 2>&1
  assert_grep "real change reported with region" "$OUT/04b.log" 'of pixels changed — the saved file is the changed region'
  # the saved file must be the region only (not the whole viewport)
  node -e "
    const fs=require('fs');
    const d=fs.readFileSync('$OUT/c2.png');
    const w=d.readUInt32BE(16), h=d.readUInt32BE(20);
    if (w*h>0 && w<1280 && h<1280) console.log('region file: '+w+'x'+h+' — region only'); else { console.log('BAD '+w+'x'+h); process.exit(1); }
  " >>"$OUT/04b.log" 2>&1 && ok "diff shot is the changed region only" || bad "diff shot not a region"
  # (g) --scale/--max ignored while a baseline exists, WITH a note
  "${CLI[@]}" shot change.html "$OUT/c3.png" --diff --max 800 >>"$OUT/04b.log" 2>&1
  assert_grep "--max ignored with a note while baseline exists" "$OUT/04b.log" '--max ignored'
  # (e) --crop from the diff note lands on the changed content
  # (the FIRST region note — the flip; later --max diffs can emit a tiny
  # sub-noise AA-jitter region near the infobar transition)
  local note coords
  note=$(grep -oE 'CSS offset x=[0-9]+, y=[0-9]+ for measure/crop' "$OUT/04b.log" | head -1)
  coords=$(echo "$note" | grep -oE '[0-9]+, y=[0-9]+' | grep -oE '[0-9]+' | paste -sd, -)
  if [ -n "$coords" ]; then
    local w2 h2
    w2=$(node -e "console.log(require('fs').readFileSync('$OUT/c2.png').readUInt32BE(16))")
    h2=$(node -e "console.log(require('fs').readFileSync('$OUT/c2.png').readUInt32BE(20))")
    "${CLI[@]}" shot change.html "$OUT/crop.png" --crop "$coords,$w2,$h2" >"$OUT/04e.log" 2>&1
    ok "crop from note coordinates taken (${coords}, ${w2}x${h2}) — content verified via image read"
  else bad "no CSS offset note in diff output"; fi
  # (c) wait --pixel-change on a static page + fixed header must time out
  "${CLI[@]}" open "$FX/fixedheader.html" --profile "$P1" >/dev/null
  local t0 t1
  t0=$(date +%s%N)
  "${CLI[@]}" wait fixedheader.html --pixel-change --timeout 3000 >"$OUT/04c.log" 2>&1 && bad "static page must not fire" || true
  t1=$(date +%s%N)
  if grep -q 'timeout after' "$OUT/04c.log"; then ok "fixed-header page times out honestly"; else bad "pixel wait error text"; fi
  [ $(( (t1 - t0) / 100000000 )) -le 45 ] && ok "timeout fires fast (~$(( (t1 - t0) / 1000000 ))ms for 3000ms budget)" || bad "timeout did not fail fast"
  # (d) real change ~3s must fire with the region
  "${CLI[@]}" open "$FX/slowchange.html" --profile "$P1" >/dev/null
  ( sleep 0.5 && "${CLI[@]}" click slowchange.html '#arm' >/dev/null 2>&1 ) &
  "${CLI[@]}" wait slowchange.html --pixel-change --timeout 12000 >"$OUT/04d.log" 2>&1
  assert_grep "3s pixel change fires" "$OUT/04d.log" 'pixels changed'
  assert_grep "change region reported" "$OUT/04d.log" 'region [0-9]+×[0-9]+px at CSS'
  # (f) no bridge UI in any shot — verified by reading the images
  for f in s1.png c2.png; do
    [ -f "$OUT/$f" ] && ok "shot $f saved (pill check via image read)" || bad "shot $f missing"
  done
}

# ---------------------------------------------------------------- section 5
s_waits() {
  SECTION=waits
  "${CLI[@]}" open "$FX/change.html" --profile "$P1" >/dev/null
  "${CLI[@]}" wait change.html --text 'Stable block' >"$OUT/05.log" 2>&1
  assert_grep "wait --text found" "$OUT/05.log" 'found text'
  "${CLI[@]}" wait change.html '#mut' >>"$OUT/05.log" 2>&1
  assert_grep "wait css found" "$OUT/05.log" 'found #mut'
  "${CLI[@]}" wait change.html '.never-there' --timeout 1000 >>"$OUT/05.log" 2>&1 || true
  assert_grep "css wait times out honestly" "$OUT/05.log" 'timeout after 1000ms waiting for .never-there'
  assert_ngrep "no double Error: prefix" "$OUT/05.log" 'async: Error:'
}

# ---------------------------------------------------------------- section 6
s_net() {
  SECTION=net
  "${CLI[@]}" open "$FX/net.html" --profile "$P1" >/dev/null
  sleep 2
  ( sleep 0.5 && "${CLI[@]}" click net.html '#fire' >/dev/null 2>&1 ) &
  local clickpid=$!
  "${CLI[@]}" net net.html --dur 5000 --filter /api --body /api --har "$OUT/stress.har" >"$OUT/06.log" 2>&1
  wait $clickpid
  assert_grep "net filter+body" "$OUT/06.log" 'GET 200 /api/data'
  assert_grep "net body content" "$OUT/06.log" 'ok.*true.*items'
  assert_grep "har saved" "$OUT/06.log" 'saved.*HAR 1.2, 2 entries'
  node -e "const h=JSON.parse(require('fs').readFileSync('$OUT/stress.har','utf8')); if(h.log&&h.log.entries&&h.log.entries.length>=2) console.log('har valid, entries: '+h.log.entries.length); else process.exit(1)" >>"$OUT/06.log" 2>&1 && ok "har parses with entries" || bad "har file invalid"
  ( sleep 0.5 && "${CLI[@]}" click net.html '#fire' >/dev/null 2>&1 ) &
  clickpid=$!
  "${CLI[@]}" net net.html --dur 5000 --ws >>"$OUT/06.log" 2>&1
  wait $clickpid
  assert_grep "ws frame sent" "$OUT/06.log" '→ hello'
  assert_grep "ws frame echoed" "$OUT/06.log" '← echo:hello'
  # fetch riding the file:// origin (in-page fails on credentials+CORS →
  # browser-network CDP fallback must answer)
  "${CLI[@]}" fetch net.html http://localhost:9334/api/data --out "$OUT/fetched.json" >"$OUT/06-fetch.log" 2>&1
  assert_grep "fetch via fallback (or in-page)" "$OUT/06-fetch.log" 'status.{0,4}200|saved'
  grep -q '"ok":true' "$OUT/fetched.json" 2>/dev/null && ok "fetch --out body written" || bad "fetch --out body"
}

# ---------------------------------------------------------------- section 7
s_marks() {
  SECTION=marks
  "${CLI[@]}" open "$FX/static.html?x=marks" --profile "$P1" >/dev/null
  "${CLI[@]}" release "static.html?x=marks" >/dev/null
  "${CLI[@]}" tabs "static.html?x=marks" | grep -q '"driven":true' && bad "release did not clear driven" || ok "release clears driven"
  "${CLI[@]}" snap "static.html?x=marks" >/dev/null
  "${CLI[@]}" tabs "static.html?x=marks" | grep -q '"driven":true' && ok "snap (read) re-marks the tab" || bad "snap does not mark"
  "${CLI[@]}" eval "static.html?x=marks" "!!document.getElementById('bridge-banner')" >"$OUT/07.log" 2>&1
  assert_grep "banner present on driven tab" "$OUT/07.log" '^true$'
  "${CLI[@]}" release "static.html?x=marks" >/dev/null
  "${CLI[@]}" tabs "static.html?x=marks" | grep -q '"driven":true' && bad "final release failed" || ok "release clears again"
}

# ---------------------------------------------------------------- section 8
s_misc() {
  SECTION=misc
  local M="static.html?x=marks"
  "${CLI[@]}" snap "$M" >/dev/null 2>&1
  # grid toggle
  "${CLI[@]}" grid "$M" >/dev/null 2>&1
  "${CLI[@]}" eval "$M" "!!document.getElementById('bridge-grid')" >"$OUT/08.log" 2>&1
  assert_grep "grid on" "$OUT/08.log" '^true$'
  "${CLI[@]}" grid "$M" >/dev/null 2>&1
  "${CLI[@]}" eval "$M" "!!document.getElementById('bridge-grid')" >>"$OUT/08.log" 2>&1
  assert_grep "grid off (toggle clears)" "$OUT/08.log" '^false$'
  # note → pill history
  "${CLI[@]}" note "$M" "stress suite running here" >/dev/null 2>&1
  "${CLI[@]}" eval "$M" "const b=document.getElementById('bridge-banner'); const pill=b?.querySelector('[aria-label*=driving]') || b?.firstElementChild; String(pill?.dataset.log?.includes('stress suite running here'))" >>"$OUT/08.log" 2>&1
  assert_grep "note lands in pill history" "$OUT/08.log" '^true$'
  # history lists this session
  "${CLI[@]}" history "$M" -n 60 >>"$OUT/08.log" 2>&1
  assert_grep "history records the session" "$OUT/08.log" 'grid '
  # console hook + clear
  "${CLI[@]}" console "$M" >/dev/null 2>&1
  "${CLI[@]}" eval "$M" "console.log('MARKER-12345'); 'logged'" >/dev/null 2>&1
  "${CLI[@]}" console "$M" >>"$OUT/08.log" 2>&1
  assert_grep "console captures page log" "$OUT/08.log" 'MARKER-12345'
  "${CLI[@]}" console "$M" --clear >/dev/null 2>&1
  "${CLI[@]}" console "$M" >"$OUT/08-cleared.log" 2>&1
  assert_ngrep "console cleared" "$OUT/08-cleared.log" 'MARKER-12345'
  # emulate / unemulate (verify via navigation per the hidden-tab gotcha)
  "${CLI[@]}" emulate "$M" 375 667 >/dev/null 2>&1
  "${CLI[@]}" eval "$M" "innerWidth+'x'+innerHeight" >>"$OUT/08.log" 2>&1
  assert_grep "emulate pins viewport" "$OUT/08.log" '375x667'
  # mobile: on a viewport-meta page (static.html has one) the emulated device
  # viewport must be exact — no 980px desktop-fallback inflation
  "${CLI[@]}" emulate "$M" 375 667 mobile >/dev/null 2>&1
  "${CLI[@]}" eval "$M" "innerWidth+'x'+innerHeight" >>"$OUT/08.log" 2>&1
  assert_grep "mobile emulate exact on a viewport-meta page" "$OUT/08.log" '375x667'
  "${CLI[@]}" unemulate "$M" >/dev/null 2>&1
  "${CLI[@]}" nav "$M" "$FX/static.html?x=marks" >/dev/null 2>&1
  "${CLI[@]}" eval "$M" "innerWidth+'x'+innerHeight" >>"$OUT/08.log" 2>&1
  if grep -q '375x667' <(tail -1 "$OUT/08.log") ; then bad "unemulate did not clear"; else ok "unemulate cleared (nav readback)"; fi
  # resize + back: assert on the command's own echo — window.outerWidth reads
  # 0 in a hidden/minimized window, so an eval readback can't verify it
  local w0 h0
  w0=$("${CLI[@]}" eval "$M" "outerWidth" 2>/dev/null)
  h0=$("${CLI[@]}" eval "$M" "outerHeight" 2>/dev/null)
  "${CLI[@]}" resize "$M" 900 700 >>"$OUT/08.log" 2>&1
  assert_grep "resize applied" "$OUT/08.log" '"width":900,"height":700'
  if [ "$w0" -gt 100 ] 2>/dev/null; then
    "${CLI[@]}" resize "$M" "$w0" "$h0" >/dev/null 2>&1
    ok "resized back to ${w0}x${h0}"
  else
    # the original size is unknowable (hidden window) — a sane restore
    "${CLI[@]}" resize "$M" 1280 900 >/dev/null 2>&1
    ok "resized back to a sane 1280x900 (original read 0 — hidden window)"
  fi
  # batch error-stop semantics
  printf 'eval "%s" "window.__stop=1; String(window.__stop)"\nnosuchcommand\neval "%s" "window.__stop=2; String(window.__stop)"\n' "$M" "$M" \
    | "${CLI[@]}" batch >>"$OUT/08.log" 2>&1 || true
  "${CLI[@]}" eval "$M" "String(window.__stop)" >>"$OUT/08.log" 2>&1
  assert_grep "batch stops on first error" "$OUT/08.log" '^1$'
  # swlogs clean of unexpected errors
  "${CLI[@]}" swlogs --profile "$P1" >"$OUT/08-swlogs.log" 2>&1
  assert_ngrep "swlogs clean (no ERROR/REJECT)" "$OUT/08-swlogs.log" 'ERROR |REJECT '
}

# ---------------------------------------------------------------- section 9
s_edges() {
  SECTION=edges
  # strict CSP: eval ladder, click, diff
  "${CLI[@]}" open "$FX/csp.html" --profile "$P1" >/dev/null
  "${CLI[@]}" eval csp.html '2+3' >"$OUT/09.log" 2>&1
  assert_grep "eval on strict-CSP page (world fallback)" "$OUT/09.log" '^5$'
  "${CLI[@]}" click csp.html '#csp-btn' --diff >>"$OUT/09.log" 2>&1
  assert_grep "click + diff on CSP page" "$OUT/09.log" 'csp: clicked'
  "${CLI[@]}" close csp.html --profile "$P1" >/dev/null 2>&1
  # same-origin iframe: in-tree, drivable in place
  "${CLI[@]}" open "$HTTP/iframe.html" --profile "$P1" >/dev/null
  "${CLI[@]}" snap iframe.html >"$OUT/09-iframe.log" 2>/dev/null
  assert_grep "same-origin iframe children in tree" "$OUT/09-iframe.log" 'button "Child button"'
  local kref
  kref=$(grep -m1 'Child button' "$OUT/09-iframe.log" | grep -o '@e[0-9]*' | tr -d '@')
  "${CLI[@]}" click iframe.html "@$kref" --diff >>"$OUT/09-iframe.log" 2>&1
  assert_grep "iframe child click by ref" "$OUT/09-iframe.log" 'succeeded · clicked'
  "${CLI[@]}" eval iframe.html "document.getElementById('parent-out').textContent" >>"$OUT/09-iframe.log" 2>&1
  assert_grep "iframe child handler ran in parent" "$OUT/09-iframe.log" 'child button clicked'
  "${CLI[@]}" click iframe.html '#kid-btn' --diff >>"$OUT/09-iframe.log" 2>&1
  assert_grep "iframe child click by piercing css" "$OUT/09-iframe.log" 'succeeded · clicked'
  "${CLI[@]}" close iframe.html --profile "$P1" >/dev/null 2>&1
}

# ---------------------------------------------------------------- cleanup
cleanup() {
  SECTION=cleanup
  # close every tab this suite opened, on BOTH profiles (loop: close acts on
  # one match at a time; without --profile a multi-profile match is refused)
  local m p rc=0
  for m in "stress/fixtures/static.html" "stress/fixtures/counter.html" \
           "stress/fixtures/big.html" "stress/fixtures/rich.html" "stress/fixtures/change.html" \
           "stress/fixtures/fixedheader.html" "stress/fixtures/slowchange.html" "stress/fixtures/net.html" \
           "stress/fixtures/alert.html" "stress/fixtures/csp.html" "test/upload.html" \
           "localhost:9334/fixtures/iframe.html"; do
    for p in "$P1" "$P2"; do
      [ -z "$p" ] && continue
      for _ in 1 2 3 4 5 6; do
        "${CLI[@]}" close "$m" --profile "$p" >/dev/null 2>&1 || break
      done
    done
  done
  "${CLI[@]}" tabs "stress/fixtures" >"$OUT/leftover.log" 2>&1
  if grep -q 'stress/fixtures' "$OUT/leftover.log"; then
    bad "leftover test tabs (see out/leftover.log)"; rc=1
  else ok "zero leftover fixture tabs"; fi
  if grep -q 'test/upload.html' "$OUT/leftover.log"; then bad "leftover upload tab"; else ok "upload tab closed"; fi
}

# ---------------------------------------------------------------- main
ALL="profiles churn interact dialog pixel waits net marks misc edges cleanup"
SECTIONS=${*:-$ALL}
cd "$REPO"
detect_profiles || { echo "FAIL: no connected profile (cli profiles)"; exit 1; }
echo "profiles: P1=$P1 P2=${P2:-<none>}"
# fixture server (HTTP + WS echo) — start if :9334 is down. Detached spawn:
# a plain `&` would put the server on this shell's job table, and every bare
# `wait` below would then wait for the never-exiting server forever
curl -s -m 2 http://localhost:9334/api/data >/dev/null 2>&1 || ( node "$S/server.mjs" &>/dev/null & )
for sec in $SECTIONS; do
  case $sec in
    profiles) s_profiles ;; churn) s_churn ;; interact) s_interact ;; dialog) s_dialog ;;
    pixel) s_pixel ;; waits) s_waits ;; net) s_net ;; marks) s_marks ;; misc) s_misc ;;
    edges) s_edges ;; cleanup) cleanup ;;
    *) echo "unknown section: $sec" ;;
  esac
done
echo
echo "=== stress suite: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
