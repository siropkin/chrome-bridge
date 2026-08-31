# Design-eye: comparing implementation vs mockup without missing details

Eyeballing two full screenshots misses alignment and containment details (that's
how "tiles are centered" and "slider sits in a rounded pill with a bg" slip
through). Procedure, in order of reliability:

## 1. Measure, don't eyeball
- Impl: `node cli.mjs measure <match> <selector>` → x/y/w/h, alignItems,
  justifyContent, textAlign, gap, padding, radius, bg, color, font per element.
- Figma: select the node (node-id URL), then eval-read the right Properties
  panel — Layout (W/H/radius) and Colors are plain DOM text.
- Compare numbers. Alignment questions ("are tile contents centered?") are
  answered by `alignItems`/`textAlign`, never by looking.

## 2. Crop to the component before comparing
Full-screen shots dilute attention. Crop both sides to the same region:
`node cli.mjs shot <match> out.png --crop x,y,w,h`
(get the region from `measure` output on the impl side; mockup side from the
Figma selection's Layout values × screenshot scale).

## 3. Rubric for the comparing subagent — force one line each
- **Copy**: exact strings, case, punctuation.
- **Alignment**: per container — items start/center? text left/center?
- **Containment**: does each control sit inside a visible container (pill/card)?
  bg color, radius, padding of that container.
- **Spacing**: order + gaps between siblings.
- **Color**: bg/text/icon per element.
- **Typography**: size/weight per text run.
- **States**: capture default + active + disabled/hover separately; mockups show
  states side by side, so capture the same set.

## 4. Overlay guides when alignment is suspect
`node cli.mjs grid <match>` toggles an 8px red grid over the impl page;
screenshot with it on to check alignment against spacing tokens.

## 5. Report format
Diff list only, each line: element — mockup vs impl — severity (blocker /
polish / ok-to-differ). "Looks the same" is not a finding; numbers are.
