#!/bin/bash
# chrome-bridge PARALLEL stress — many CLI processes hammering the bridge at once.
# Usage: test/stress/parallel.sh [section ...]   (no args = all sections)
#
# Complements run.sh (sequential e2e): this suite's point is CONCURRENCY —
# same-tab storms, cross-profile storms, open/close churn, big-payload shots,
# honest-timeout isolation, and a server restart mid-storm.
#
# Preconditions (same as run.sh):
#   - two Chrome profiles connected (multi-profile sections SKIP with one)
#   - the profile-1 Chrome window should be VISIBLE (shots on occluded windows
#     can come back blank — payload integrity is still asserted, pixels aren't)
#   - node test/stress/server.mjs on :9334 (started here if down)
# Every URL this suite opens carries ?ps= — cleanup closes by that match.
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
S="$REPO/test/stress"
OUT="$S/out/parallel"; mkdir -p "$OUT"
CLI=(node "$REPO/cli.mjs")
FX="file://$S/fixtures"
PASS=0; FAIL=0; SECTION="?"
# markers that must NEVER appear in worker output (except where a section says so)
NO_BAD='extension timeout|CDP command stuck|disconnected mid-command|seat.taken'

ok()  { echo "PASS [$SECTION] $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL [$SECTION] $1"; FAIL=$((FAIL+1)); }
# wrun <rc-log> <cmd...> — run, append OK / FAIL:<rc> to <rc-log>
wrun() { local rcf=$1; shift; if "$@" >/dev/null 2>&1; then echo OK >>"$rcf"; else echo "FAIL:$?" >>"$rcf"; fi; }
# grep -c prints 0 AND exits 1 on no match — the || true keeps that 0, a naive
# '|| echo 0' would append a second line and break every numeric compare
n_ok()   { local n; n=$(grep -c '^OK' "$1" 2>/dev/null || true); echo "${n:-0}"; }
n_fail() { local n; n=$(grep -c '^FAIL' "$1" 2>/dev/null || true); echo "${n:-0}"; }
assert_all_ok() { # assert_all_ok <name> <rc-log> <want>
  local got; got=$(n_ok "$2")
  if [ "$got" = "$3" ] && [ "$(n_fail "$2")" = 0 ]; then ok "$1 ($got/$3)"; else bad "$1 ($got/$3 ok, $(n_fail "$2") failed)"; fi
}
assert_no_bad() { # assert_no_bad <name> <log-glob>
  if grep -lqE "$NO_BAD" $2 2>/dev/null; then bad "$1 — forbidden marker: $(grep -hoE "$NO_BAD" $2 | sort | uniq -c | tr '\n' ' ')"; else ok "$1"; fi
}
# probe <match> <profile> — one eval, echoes "<ms> <rc>"
probe() { local t0; t0=$(date +%s%N); "${CLI[@]}" eval "$1" "1" --profile "$2" >/dev/null 2>&1; local rc=$?; echo "$(( ($(date +%s%N) - t0) / 1000000 )) $rc"; }
# count_tabs <match> — total across both profiles. tabs prints ONE json array
# on one line: count occurrences, not lines.
count_tabs() { "${CLI[@]}" tabs "$1" 2>/dev/null | grep -o '"url"' | wc -l | tr -d ' '; }
incr() { # incr <match> <profile> <rc-log> — one atomic counter increment
  wrun "$3" "${CLI[@]}" eval "$1" "const el=document.getElementById('c');el.textContent=String(+el.textContent+1);el.textContent" --profile "$2"
}
# head -1: an ambiguous match appends a '⚠ N tabs match' warning line to the
# result — the counter value is the first line, the warning must not poison
# numeric compares.
read_counter() { "${CLI[@]}" eval "$1" "document.getElementById('c').textContent" --profile "$2" 2>/dev/null | head -1; }

P1=""; P2=""
detect_profiles() {
  local profs
  profs=$("${CLI[@]}" profiles 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).map(p=>p.name).join(" "))}catch{console.log("")}})')
  P1=$(echo "$profs" | awk '{print $1}'); P2=$(echo "$profs" | awk '{print $2}')
  [ -n "$P1" ]
}
need2() { [ -n "$P2" ]; }

# ------------------------------------------------------------- 1 same-tab storm
s_sametab() {
  SECTION=sametab
  "${CLI[@]}" open "$FX/counter.html?ps=st" --profile "$P1" >/dev/null
  sleep 1
  rm -f "$OUT/sametab."{log,rc}
  for _ in $(seq 1 30); do incr "counter.html?ps=st" "$P1" "$OUT/sametab.rc" & done
  wait
  assert_all_ok "30 parallel increments on ONE tab all land" "$OUT/sametab.rc" 30
  local final; final=$(read_counter "counter.html?ps=st" "$P1")
  [ "$final" = 30 ] && ok "counter integrity: final=$final (zero lost/duplicate updates)" || bad "counter final=$final, want 30"
  assert_no_bad "no wedge markers" "$OUT/sametab.rc"
}

# ------------------------------------------------------ 2 same-tab mixed storm
s_mixed() {
  SECTION=mixed
  "${CLI[@]}" open "$FX/rich.html?ps=mix" --profile "$P1" >/dev/null
  sleep 1
  rm -f "$OUT/mixed."{log,rc}
  local m="rich.html?ps=mix"
  for _ in 1 2 3; do wrun "$OUT/mixed.rc" "${CLI[@]}" snap "$m" --profile "$P1" & done
  for _ in 1 2 3; do wrun "$OUT/mixed.rc" "${CLI[@]}" eval "$m" "1+1" --profile "$P1" & done
  for _ in 1 2; do wrun "$OUT/mixed.rc" "${CLI[@]}" click "$m" '#cb' --profile "$P1" & done
  for _ in 1 2; do wrun "$OUT/mixed.rc" "${CLI[@]}" fill "$m" '#name' 'storm' --profile "$P1" & done
  wrun "$OUT/mixed.rc" "${CLI[@]}" scroll "$m" bottom --profile "$P1" &
  wrun "$OUT/mixed.rc" "${CLI[@]}" measure "$m" '#name' --profile "$P1" &
  wrun "$OUT/mixed.rc" "${CLI[@]}" snap "$m" --skeleton --profile "$P1" &
  wait
  assert_all_ok "13 mixed commands on ONE tab (snap/eval/click/fill/scroll/measure)" "$OUT/mixed.rc" 13
  assert_no_bad "no wedge markers" "$OUT/mixed.rc"
}

# ------------------------------------------------------- 3 tab-per-worker storm
s_tabs() {
  SECTION=tabs
  rm -f "$OUT/tabs-"*.rc
  local i j
  for i in $(seq 1 8); do "${CLI[@]}" open "$FX/counter.html?ps=t$i" --profile "$P1" >/dev/null; done
  sleep 1
  for i in $(seq 1 8); do
    ( for j in $(seq 1 10); do incr "counter.html?ps=t$i" "$P1" "$OUT/tabs-$i.rc"; done ) &
  done
  wait
  local allgood=1 i_final
  for i in $(seq 1 8); do
    [ "$(n_ok "$OUT/tabs-$i.rc")" = 10 ] || allgood=0
    i_final=$(read_counter "counter.html?ps=t$i" "$P1")
    [ "$i_final" = 10 ] || { allgood=0; echo "  tab t$i final=$i_final"; }
  done
  [ "$allgood" = 1 ] && ok "8 tabs × 10 increments: every tab a clean 10, zero cross-talk" || bad "tab-per-worker storm corrupted"
}

# ------------------------------------------------------- 4 cross-profile storm
s_profiles() {
  SECTION=profiles; need2 || { bad "two profiles required"; return; }
  "${CLI[@]}" open "$FX/counter.html?ps=pr" --profile "$P1" >/dev/null
  "${CLI[@]}" open "$FX/counter.html?ps=pr" --profile "$P2" >/dev/null
  sleep 1
  rm -f "$OUT/prof-p1.rc" "$OUT/prof-p2.rc"
  for _ in $(seq 1 20); do incr "counter.html?ps=pr" "$P1" "$OUT/prof-p1.rc" & done
  for _ in $(seq 1 20); do incr "counter.html?ps=pr" "$P2" "$OUT/prof-p2.rc" & done
  wait
  assert_all_ok "20 parallel increments on $P1" "$OUT/prof-p1.rc" 20
  assert_all_ok "20 parallel increments on $P2" "$OUT/prof-p2.rc" 20
  local f1 f2; f1=$(read_counter "counter.html?ps=pr" "$P1"); f2=$(read_counter "counter.html?ps=pr" "$P2")
  { [ "$f1" = 20 ] && [ "$f2" = 20 ]; } && ok "both profiles exact (same URL, pinned seats)" || bad "profile counters $f1/$f2, want 20/20"
}

# ------------------------------------------- 5 unpinned multi-profile routing
s_unpinned() {
  SECTION=unpinned; need2 || { bad "two profiles required"; return; }
  "${CLI[@]}" open "$FX/counter.html?ps=u1" --profile "$P1" >/dev/null
  "${CLI[@]}" open "$FX/counter.html?ps=u2" --profile "$P2" >/dev/null
  sleep 1
  rm -f "$OUT/unpinned.rc"
  # no --profile: every command pays the probe fan-out to BOTH seats
  for _ in $(seq 1 10); do wrun "$OUT/unpinned.rc" "${CLI[@]}" eval "counter.html?ps=u1" "const el=document.getElementById('c');el.textContent=String(+el.textContent+1);el.textContent" & done
  for _ in $(seq 1 10); do wrun "$OUT/unpinned.rc" "${CLI[@]}" eval "counter.html?ps=u2" "const el=document.getElementById('c');el.textContent=String(+el.textContent+1);el.textContent" & done
  wait
  assert_all_ok "20 unpinned commands routed by probe (10 per profile)" "$OUT/unpinned.rc" 20
  local f1 f2
  f1=$(read_counter "counter.html?ps=u1" "$P1"); f2=$(read_counter "counter.html?ps=u2" "$P2")
  { [ "$f1" = 10 ] && [ "$f2" = 10 ]; } && ok "probe routing never crossed the streams" || bad "unpinned counters $f1/$f2, want 10/10"
  # refusals under concurrency: unmatchable-by-probe command must refuse, not guess
  "${CLI[@]}" open "$FX/static.html?ps=both" --profile "$P1" >/dev/null
  "${CLI[@]}" open "$FX/static.html?ps=both" --profile "$P2" >/dev/null
  sleep 1
  "${CLI[@]}" eval "static.html?ps=both" "1" >"$OUT/unpinned-refuse.log" 2>&1 && bad "ambiguous unpinned eval must fail" || true
  grep -qE "matches tabs in 2 profiles" "$OUT/unpinned-refuse.log" && ok "ambiguous match refused, names both profiles" || bad "ambiguity refusal text: $(head -1 "$OUT/unpinned-refuse.log")"
  "${CLI[@]}" eval counter.html "1" >"$OUT/unpinned-refuse2.log" 2>&1 && bad "multi-match unpinned eval must fail" || true
  grep -qE "matches tabs in [0-9]+ profiles|multiple profiles" "$OUT/unpinned-refuse2.log" && ok "multi-match refused cleanly" || bad "multi-match refusal: $(head -1 "$OUT/unpinned-refuse2.log")"
}

# ------------------------------------------------------------ 6 open/close churn
s_churn() {
  SECTION=churn
  local round i
  for round in 1 2 3; do
    rm -f "$OUT/churn-open.rc" "$OUT/churn-close.rc"
    # zero-padded i: 'i=1' is a substring of 'i=11' — unpadded, two closes can
    # resolve to the SAME tab (one wins, the other errors, the twin leaks)
    for i in $(seq -w 1 15); do wrun "$OUT/churn-open.rc" "${CLI[@]}" open "$FX/static.html?ps=ch&r=$round&i=$i" --profile "$P1" & done
    wait
    assert_all_ok "round $round: 15 parallel opens" "$OUT/churn-open.rc" 15
    local n; n=$(count_tabs "ps=ch&r=$round")
    [ "$n" = 15 ] && ok "round $round: 15 tabs visible" || bad "round $round: $n tabs, want 15"
    for i in $(seq -w 1 15); do wrun "$OUT/churn-close.rc" "${CLI[@]}" close "static.html?ps=ch&r=$round&i=$i" --profile "$P1" & done
    wait
    assert_all_ok "round $round: 15 parallel closes" "$OUT/churn-close.rc" 15
    n=$(count_tabs "ps=ch&r=$round")
    [ "$n" = 0 ] && ok "round $round: zero leftover" || bad "round $round: $n leftover"
  done
  # group sanity after churn: no duplicate 🟣 Bridge groups in the window
  "${CLI[@]}" open "$FX/static.html?ps=chgrp" --profile "$P1" >/dev/null
  sleep 1
  local g; g=$("${CLI[@]}" eval "static.html?ps=chgrp" "1" --profile "$P1" >/dev/null 2>&1; "${CLI[@]}" tabs "ps=chgrp" --profile "$P1" 2>/dev/null | grep -c '🟣 Bridge')
  [ "$g" -ge 1 ] && ok "churned tabs still group under one 🟣 Bridge group" || bad "no Bridge group after churn"
}

# ----------------------------------------------------------------- 7 shot storm
s_shots() {
  SECTION=shots
  "${CLI[@]}" open "$FX/big.html?ps=shot" --profile "$P1" >/dev/null
  "${CLI[@]}" open "$FX/static.html?ps=shot2" --profile "$P1" >/dev/null
  "${CLI[@]}" open "$FX/rich.html?ps=shot3" --profile "$P1" >/dev/null
  sleep 1
  rm -f "$OUT/shots.rc" "$OUT/shots.log" "$OUT"/ps-*.png
  # 6 parallel viewport shots across 3 tabs (same-tab pairs serialize on withCdp)
  wrun "$OUT/shots.rc" "${CLI[@]}" shot "big.html?ps=shot" "$OUT/ps-a1.png" --profile "$P1" &
  wrun "$OUT/shots.rc" "${CLI[@]}" shot "big.html?ps=shot" "$OUT/ps-a2.png" --profile "$P1" &
  wrun "$OUT/shots.rc" "${CLI[@]}" shot "static.html?ps=shot2" "$OUT/ps-b1.png" --profile "$P1" &
  wrun "$OUT/shots.rc" "${CLI[@]}" shot "static.html?ps=shot2" "$OUT/ps-b2.png" --profile "$P1" &
  wrun "$OUT/shots.rc" "${CLI[@]}" shot "rich.html?ps=shot3" "$OUT/ps-c1.png" --profile "$P1" &
  wrun "$OUT/shots.rc" "${CLI[@]}" shot "rich.html?ps=shot3" "$OUT/ps-c2.png" --profile "$P1" &
  # 4 parallel full-page shots on the tall fixture — multi-MB WS frames both ways
  for i in 1 2 3 4; do wrun "$OUT/shots.rc" "${CLI[@]}" shot "big.html?ps=shot" "$OUT/ps-full$i.png" --full --profile "$P1" & done
  # 2 parallel --diff sequences on one tab (baseline churn)
  ( wrun "$OUT/shots.rc" "${CLI[@]}" shot "static.html?ps=shot2" "$OUT/ps-d1.png" --diff --profile "$P1"; \
    wrun "$OUT/shots.rc" "${CLI[@]}" shot "static.html?ps=shot2" "$OUT/ps-d2.png" --diff --profile "$P1" ) &
  ( wrun "$OUT/shots.rc" "${CLI[@]}" shot "static.html?ps=shot2" "$OUT/ps-d3.png" --diff --profile "$P1"; \
    wrun "$OUT/shots.rc" "${CLI[@]}" shot "static.html?ps=shot2" "$OUT/ps-d4.png" --diff --profile "$P1" ) &
  wait
  assert_all_ok "14 parallel shots (viewport + full-page + diff pairs)" "$OUT/shots.rc" 14
  local badpng=0 f
  for f in "$OUT"/ps-*.png; do
    [ "$(head -c4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' ')" = "89504e47" ] || { badpng=1; echo "  not a PNG: $f"; }
  done
  [ "$badpng" = 0 ] && ok "every shot file is a valid PNG" || bad "corrupt shot files"
  assert_no_bad "no wedge markers under shot load" "$OUT/shots.rc"
}

# ------------------------------------------------- 8 honest-timeout isolation
s_timeout() {
  SECTION=timeout
  "${CLI[@]}" open "$FX/counter.html?ps=to" --profile "$P1" >/dev/null
  "${CLI[@]}" open "$FX/static.html?ps=to2" --profile "$P1" >/dev/null
  sleep 1
  rm -f "$OUT/timeout."{log,rc} "$OUT/timeout-wait.log"
  # a doomed 8s wait must not poison 10 good evals on the SAME tab
  "${CLI[@]}" wait "counter.html?ps=to" '.never-there' --timeout 8000 >"$OUT/timeout-wait.log" 2>&1 &
  local wpid=$!
  sleep 0.5
  for _ in $(seq 1 10); do incr "counter.html?ps=to" "$P1" "$OUT/timeout.rc" & done
  wait
  wait $wpid 2>/dev/null
  assert_all_ok "10 evals concurrent with a doomed wait on the same tab" "$OUT/timeout.rc" 10
  grep -q 'timeout after 8000ms' "$OUT/timeout-wait.log" && ok "doomed wait fails honestly" || bad "wait error text: $(head -1 "$OUT/timeout-wait.log")"
  # wait --pixel-change holds the tab's CDP lock for its duration — shots behind
  # it must QUEUE and succeed, never die as 'CDP command stuck'
  rm -f "$OUT/timeout2.rc"
  "${CLI[@]}" wait "static.html?ps=to2" --pixel-change --timeout 12000 >"$OUT/timeout2-wait.log" 2>&1 &
  wpid=$!
  sleep 1
  for i in 1 2 3; do wrun "$OUT/timeout2.rc" "${CLI[@]}" shot "static.html?ps=to2" "$OUT/ps-t$i.png" --profile "$P1" & done
  wait
  wait $wpid 2>/dev/null
  assert_all_ok "3 shots queued behind a 12s pixel-wait all land" "$OUT/timeout2.rc" 3
  grep -qE 'timeout after 12000ms|pixels changed' "$OUT/timeout2-wait.log" && ok "pixel wait resolves honestly" || bad "pixel wait: $(head -1 "$OUT/timeout2-wait.log")"
  assert_no_bad "no 'stuck' from queued CDP commands" "$OUT/timeout2.rc"
}

# ------------------------------------------------------------------ 9 error storm
s_errors() {
  SECTION=errors
  rm -f "$OUT/errors-good.rc" "$OUT/errors-bad.log"
  local i
  for i in $(seq 1 5); do wrun "$OUT/errors-good.rc" "${CLI[@]}" eval "counter.html?ps=st" "1" --profile "$P1" & done
  for i in $(seq 1 5); do ( "${CLI[@]}" eval "ps=nope-$i" "1" --profile "$P1" >>"$OUT/errors-bad.log" 2>&1; echo "rc:$?" >>"$OUT/errors-bad.log" ) & done
  for i in $(seq 1 5); do ( "${CLI[@]}" click "counter.html?ps=st" ".no-such-$i" --profile "$P1" >>"$OUT/errors-bad.log" 2>&1; echo "rc:$?" >>"$OUT/errors-bad.log" ) & done
  for i in $(seq 1 5); do ( "${CLI[@]}" click "counter.html?ps=st" "@e999$i" --profile "$P1" >>"$OUT/errors-bad.log" 2>&1; echo "rc:$?" >>"$OUT/errors-bad.log" ) & done
  for i in $(seq 1 5); do ( "${CLI[@]}" fill "counter.html?ps=st" '#c' "x$i" --profile "$P1" >>"$OUT/errors-bad.log" 2>&1; echo "rc:$?" >>"$OUT/errors-bad.log" ) & done
  wait
  assert_all_ok "5 good commands survive a 20-command error storm" "$OUT/errors-good.rc" 5
  [ "$(grep -c 'rc:1' "$OUT/errors-bad.log")" = 20 ] && ok "all 20 bad commands fail with rc=1" || bad "error storm rc mix: $(grep -o 'rc:[0-9]*' "$OUT/errors-bad.log" | sort | uniq -c | tr '\n' ';')"
  grep -qE "$NO_BAD" "$OUT/errors-bad.log" && bad "error storm produced a wedge marker" || ok "error storm produced only clean errors"
  local p; p=$(probe "counter.html?ps=st" "$P1")
  [ "${p#* }" = 0 ] && [ "${p% *}" -lt 3000 ] && ok "post-storm probe healthy (${p% *}ms)" || bad "post-storm probe: ${p% *}ms rc=${p#* }"
}

# -------------------------------------------------------------- 10 sustained storm
s_storm() {
  SECTION=storm
  local i
  for i in $(seq 1 6); do
    "${CLI[@]}" open "$FX/counter.html?ps=sw$i" --profile "$P1" >/dev/null
    [ -n "$P2" ] && "${CLI[@]}" open "$FX/counter.html?ps=sw$i" --profile "$P2" >/dev/null
  done
  "${CLI[@]}" open "$FX/counter.html?ps=shared" --profile "$P1" >/dev/null
  sleep 1
  rm -f "$OUT"/storm-w*.log
  local prof
  storm_worker() { # <worker> <profile> <match> — 30s of random read/write mix
    local w=$1 prof=$2 m=$3 log="$OUT/storm-w$1.log" end=$((SECONDS + 30))
    while [ $SECONDS -lt $end ]; do
      case $((RANDOM % 3)) in
        0) "${CLI[@]}" eval "$m" "const el=document.getElementById('c');el.textContent=String(+el.textContent+1);el.textContent" --profile "$prof" >>"$log" 2>&1 && echo INC-OK >>"$log" ;;
        1) "${CLI[@]}" snap "$m" --profile "$prof" >>"$log" 2>&1 ;;
        2) "${CLI[@]}" snap "$m" --skeleton --profile "$prof" >>"$log" 2>&1 ;;
      esac
      sleep 0.$((RANDOM % 3))
    done
  }
  for i in $(seq 1 6); do storm_worker "$i" "$P1" "counter.html?ps=sw$i" & done
  if [ -n "$P2" ]; then for i in $(seq 1 6); do storm_worker "p$i" "$P2" "counter.html?ps=sw$i" & done; fi
  storm_worker shared "$P1" "counter.html?ps=shared" &           # owner: increments
  ( local end=$((SECONDS + 30)); while [ $SECONDS -lt $end ]; do  # reader: read-only pressure on the SAME tab
      "${CLI[@]}" eval "counter.html?ps=shared" "document.getElementById('c').textContent" --profile "$P1" >>"$OUT/storm-shared-r.log" 2>&1
      sleep 0.1
    done ) &
  wait
  local bad_found=0 w inc final
  for w in 1 2 3 4 5 6; do
    inc=$(grep -c 'INC-OK' "$OUT/storm-w$w.log" 2>/dev/null || echo 0)
    final=$(read_counter "counter.html?ps=sw$w" "$P1")
    [ "$inc" -gt 0 ] && [ "$final" = "$inc" ] || { bad_found=1; echo "  $P1 sw$w: inc-ok=$inc final=$final"; }
    if [ -n "$P2" ]; then
      inc=$(grep -c 'INC-OK' "$OUT/storm-wp$w.log" 2>/dev/null || echo 0)
      final=$(read_counter "counter.html?ps=sw$w" "$P2")
      [ "$inc" -gt 0 ] && [ "$final" = "$inc" ] || { bad_found=1; echo "  $P2 sw$w: inc-ok=$inc final=$final"; }
    fi
  done
  inc=$(grep -c 'INC-OK' "$OUT/storm-wshared.log" 2>/dev/null || echo 0)
  final=$(read_counter "counter.html?ps=shared" "$P1")
  { [ "$inc" -gt 0 ] && [ "$final" = "$inc" ]; } || { bad_found=1; echo "  shared: inc-ok=$inc final=$final"; }
  [ "$bad_found" = 0 ] && ok "30s storm: every tab's counter == its landed increments (shared tab under concurrent reads too)" || bad "storm counter drift"
  grep -lhE "$NO_BAD" "$OUT"/storm-w*.log >/dev/null 2>&1 && bad "storm produced wedge markers: $(grep -hoE "$NO_BAD" "$OUT"/storm-w*.log | sort | uniq -c | tr '\n' ' ')" || ok "30s storm: zero wedge markers"
  local p; p=$(probe "counter.html?ps=shared" "$P1")
  [ "${p#* }" = 0 ] && [ "${p% *}" -lt 3000 ] && ok "post-storm probe healthy (${p% *}ms)" || bad "post-storm probe: ${p% *}ms rc=${p#* }"
}

# ------------------------------------------- malformed-input robustness (F1)
s_robust() {
  SECTION=robust
  # {"type":"shot",...,"crop":"z"} used to crash the WHOLE server: pushAct ran
  # outside the route try/catch and CLI_LINES.shot did m.crop.join on a string
  # — the throw, inside an async 'end' handler, was an unhandled rejection.
  curl -s -m 5 -X POST http://127.0.0.1:9333/cmd -d '{"type":"shot","urlMatch":"nope","crop":"z"}' >"$OUT/robust.log" 2>&1
  grep -q '"ok":false' "$OUT/robust.log" && ok "malformed crop gets a clean error" || bad "malformed crop response: $(head -c 120 "$OUT/robust.log")"
  curl -s -m 5 -X POST http://127.0.0.1:9333/cmd -d '{"type":"eval","urlMatch":"x"}' >>"$OUT/robust.log" 2>&1   # no code field
  curl -s -m 5 -X POST http://127.0.0.1:9333/cmd -d 'not json at all' >>"$OUT/robust.log" 2>&1
  curl -s -m 5 -X POST http://127.0.0.1:9333/cmd -d '{"type":"bogus"}' >>"$OUT/robust.log" 2>&1
  curl -s -m 5 -X POST http://127.0.0.1:9333/cmd -d '{"type":"wait","urlMatch":"x","text":123}' >>"$OUT/robust.log" 2>&1
  local h; h=$(curl -s -m 2 http://127.0.0.1:9333/health | grep -c '"ok":true')
  [ "$h" = 1 ] && ok "server survives a 5-hit malformed-input burst" || bad "server died on malformed input"
}

# ------------------------------------------------------- 11 server restart mid-storm
s_restart() {
  SECTION=restart
  "${CLI[@]}" open "$FX/counter.html?ps=rs" --profile "$P1" >/dev/null
  sleep 1
  rm -f "$OUT"/restart-w*.rc "$OUT"/restart-w*.log
  local i j
  for i in $(seq 1 10); do
    ( for j in $(seq 1 25); do
        if "${CLI[@]}" eval "counter.html?ps=rs" "const el=document.getElementById('c');el.textContent=String(+el.textContent+1);el.textContent" --profile "$P1" >>"$OUT/restart-w$i.log" 2>&1; then
          echo OK >>"$OUT/restart-w$i.rc"
        else echo "FAIL:$?" >>"$OUT/restart-w$i.rc"; fi
      done ) &
  done
  sleep 2
  "${CLI[@]}" stop >/dev/null 2>&1
  "${CLI[@]}" start >/dev/null 2>&1
  # wait for BOTH seats back (SW reconnect is ~500ms hot, 30s alarm backstop)
  local t0=$SECONDS seats=0
  while [ $SECONDS -lt $((t0 + 40)) ]; do
    seats=$(curl -s -m 2 http://127.0.0.1:9333/health 2>/dev/null | grep -o '"id"' | wc -l | tr -d ' ')
    [ "$seats" -ge 2 ] && break
    sleep 1
  done
  [ "$seats" -ge 2 ] && ok "both seats reconnected after restart ($((SECONDS - t0))s)" || bad "only $seats seat(s) back after 40s"
  wait
  local okc=0 failc=0
  for i in $(seq 1 10); do okc=$((okc + $(n_ok "$OUT/restart-w$i.rc"))); failc=$((failc + $(n_fail "$OUT/restart-w$i.rc"))); done
  echo "  restart: $okc landed, $failc failed during the outage window"
  # the outage window (stop→start→seat reconnect ≈ 2-4s) MUST eat the commands
  # that were in flight or arrived mid-gap — the assertion is majority + recovery
  [ "$okc" -gt 150 ] && ok "most of 250 increments landed through a server restart ($okc)" || bad "only $okc/250 increments landed"
  # failures must ALL be the expected connection-shaped ones (incl. the honest
  # seat-reconnect window: server up, named profile not yet re-seated)
  local weird
  weird=$(grep -h . "$OUT"/restart-w*.log | grep -vE '^[0-9]+$' | grep -viE 'not running|dropped the connection|not connected|no connected profile matching|disconnected mid-command|fetch failed' | head -3)
  [ -z "$weird" ] && ok "every failure is connection-shaped (no corruption errors)" || bad "unexpected errors: $weird"
  # the counter can only exceed the landed count by replies lost mid-flight (applied, ack lost)
  local final; final=$(read_counter "counter.html?ps=rs" "$P1")
  local drift=$((final - okc))
  [ "$drift" -ge 0 ] && [ "$drift" -le 10 ] && ok "counter drift $drift (≤ in-flight-at-kill window)" || bad "counter drift $drift (final=$final ok=$okc)"
  # post-restart latency: no pending-map clog, no zombie seat
  local p; p=$(probe "counter.html?ps=rs" "$P1")
  [ "${p#* }" = 0 ] && [ "${p% *}" -lt 3000 ] && ok "post-restart probe healthy (${p% *}ms)" || bad "post-restart probe: ${p% *}ms rc=${p#* }"
}

# -------------------------------------------------------------------- cleanup
cleanup() {
  SECTION=cleanup
  local p
  for p in "$P1" "$P2"; do
    [ -z "$p" ] && continue
    # close acts on ONE match at a time and this suite opens ~25 tabs per
    # profile — a 6-iteration cap leaves most of them behind (run-1 bug:
    # stale tabs then made every later run's matches ambiguous)
    for _ in $(seq 1 60); do
      "${CLI[@]}" close "ps=" --profile "$p" >/dev/null 2>&1 || break
    done
  done
  local n; n=$(count_tabs "ps=")
  [ "$n" = 0 ] && ok "zero leftover ps= tabs" || bad "$n leftover ps= tabs"
  "${CLI[@]}" swlogs --profile "$P1" >"$OUT/cleanup-swlogs.log" 2>&1
  grep -qE 'ERROR |REJECT ' "$OUT/cleanup-swlogs.log" && bad "swlogs show errors after the storm" || ok "swlogs clean after the storm"
}

# ------------------------------------------------------------------------ main
ALL="sametab mixed tabs profiles unpinned churn shots timeout errors robust storm restart cleanup"
SECTIONS=${*:-$ALL}
cd "$REPO"
detect_profiles || { echo "FAIL: no connected profile (cli profiles)"; exit 1; }
echo "profiles: P1=$P1 P2=${P2:-<none>}"
curl -s -m 2 http://localhost:9334/api/data >/dev/null 2>&1 || ( node "$S/server.mjs" &>/dev/null & )
for sec in $SECTIONS; do
  case $sec in
    sametab) s_sametab ;; mixed) s_mixed ;; tabs) s_tabs ;; profiles) s_profiles ;;
    unpinned) s_unpinned ;; churn) s_churn ;; shots) s_shots ;; timeout) s_timeout ;;
    errors) s_errors ;; robust) s_robust ;; storm) s_storm ;; restart) s_restart ;; cleanup) cleanup ;;
    *) echo "unknown section: $sec" ;;
  esac
done
echo
echo "=== parallel stress: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
