# Whiteboard Script API

This document is the complete reference for writing lesson scripts. It is given verbatim to the
model that writes lessons, and it is the contract the renderer in `public/board.js` implements.

You are writing a lesson that a program performs live: your words are spoken aloud by a
high-quality text-to-speech voice, and your drawing commands are drawn on a whiteboard, in sync
with the speech, while the student watches. You have complete freedom over how you use the board
and how you structure the lesson. This document only explains what the instruments do.

---

## 1. Shape of a script

A script is JSON:

```json
{
  "steps": [
    { "say": "Let's start with a single photon hitting the panel.", "draw": [ ...ops ] },
    { "say": "...", "draw": [ ... ] }
  ]
}
```

- A **step** is one beat of the lesson: something spoken plus the drawing that goes with it.
- `say` (string, may be empty) is spoken aloud. A step can be a single word or a paragraph.
- `draw` (array, may be empty or omitted) is a list of **ops**.
- Steps play strictly in order. The next step starts when the current step's speech has finished
  and its drawing has finished.

### Timing within a step

Ops in a step are performed **in order, one after another**, spread across the time the speech takes.

- By default each op is placed in time **in proportion to where it appears in the list**: with 4
  ops and 8 seconds of speech, they start at roughly 0s, 2s, 4s, 6s.
- To pin an op to a word, give it `"at": "<word or phrase from say>"` (not inside a `[cue]`). It starts at the moment
  that phrase is spoken (first occurrence, case-insensitive). Example:
  `{"say": "Light hits the cell, and an electron breaks free.", "draw": [{"op":"path", ..., "at":"Light"}, {"op":"dot", ..., "at":"electron"}]}`
  Ops without `at` that follow an `at` op are spaced evenly after it.
- `"wait": <seconds>` on an op delays it that long after the previous op instead of auto-spacing.
- Each op has a natural drawing duration (a stroke takes ~0.3-1.5s depending on length; text is
  written at handwriting speed). Override with `"dur": <seconds>` (`0` = appears instantly).
- If a step has drawing but no speech, the ops play back to back at their natural durations.
  This is useful for a silent build-up or a pause to look.

## 2. The board

- Coordinate space: **1600 wide x 900 tall**, origin top-left, x to the right, y down.
  The visible area is exactly this rectangle; anything outside is cut off.
- Background is a white whiteboard. Strokes look like marker: rounded caps, slightly
  hand-drawn wobble (applied automatically; you draw clean geometry).
- Text is rendered in a handwriting font. Approximate text width is
  `0.48 x size x number_of_characters`. Line height is about `1.2 x size`.
- The board does **not** scroll or auto-layout. What you draw stays where you put it until you
  erase it, move it, or clear the board. You decide the composition.

### Colors

Any of these names: `black`, `blue`, `red`, `green`, `orange`, `purple`, `brown`, `gray`,
`teal`, `pink`, `yellow`. They are marker colors tuned to read well on the board
(yellow is a highlighter: use it as a fill or under text, not for thin lines).
Any CSS hex color (`"#1a7f37"`) also works.

### Common fields (all drawable ops)

| field     | meaning |
|-----------|---------|
| `id`      | Name for the element, so later ops can refer to it. Ids are global for the whole lesson; reusing an id replaces the old element. |
| `color`   | Stroke/text color. Default `black`. |
| `width`   | Stroke width in board units. Default 4. |
| `fill`    | Fill color for closed shapes, or `"none"` (default). Fills are drawn semi-transparent like a marker wash. Use `"fillOpacity"` (0-1, default 0.25) to change. |
| `dash`    | `true` for a dashed line. |
| `group`   | A group id; puts the element into that group (see `group` op). |
| `at`, `wait`, `dur` | Timing, see above. |

## 3. Ops

### `clear`
`{"op":"clear"}` - wipe the whole board (with a quick eraser sweep). Stops all animations.

### `text`
`{"op":"text","id":"title","x":800,"y":120,"text":"How solar cells work","size":64,"color":"blue","align":"middle"}`
- `x`,`y`: anchor point; `y` is the **baseline**.
- `size`: font size in board units (default 40).
- `align`: `"start"` (default, x is the left edge), `"middle"`, or `"end"`.
- `text` may contain `\n` for multiple lines.
- `underline`: true draws a hand-drawn underline after the text.
- `bold`: true for a heavier stroke.
- Written letter by letter at handwriting speed.
- Unicode is fine: subscripts/superscripts (H₂O, x²), arrows (→), Greek letters (λ, Δ), math symbols (≈, ∝).

### `line`
`{"op":"line","id":"ray","x1":100,"y1":100,"x2":400,"y2":300,"color":"orange","arrow":"end"}`
- `arrow`: `"end"`, `"start"`, `"both"`, or omitted / `false`. `true` means `"end"`.

### `rect`
`{"op":"rect","id":"box","x":200,"y":300,"w":300,"h":160,"r":12,"color":"black","fill":"blue"}`
- `x`,`y` is the top-left corner. `r` is corner radius.

### `circle`
`{"op":"circle","id":"sun","cx":200,"cy":180,"r":70,"color":"orange","fill":"yellow"}`

### `ellipse`
`{"op":"ellipse","id":"e","cx":800,"cy":450,"rx":200,"ry":80}`

### `path`
`{"op":"path","id":"wave","d":"M 100 500 Q 200 400 300 500 T 500 500","color":"purple","arrow":"end"}`
- `d` is standard SVG path data in board coordinates (M, L, H, V, C, S, Q, T, A, Z; absolute or relative).
  Use it for curves, waves, free-form shapes, outlines of objects, graphs.
- `arrow` as for `line` (arrowhead follows the path's direction at its ends).
- `fill` works for closed paths.

### `polyline`
`{"op":"polyline","id":"graph","points":[[100,800],[300,600],[500,650],[700,300]],"color":"green","smooth":true}`
- Draws through the points in order. `smooth: true` draws a smooth curve through them.
  Handy for plotted data and graphs. `arrow` as for `line`.

### `brace`
`{"op":"brace","x1":100,"y1":600,"x2":500,"y2":600,"color":"gray","label":"band gap","side":"below"}`
- A curly brace spanning two points, with an optional label. `side`: `"above"`/`"below"` for
  horizontal braces, `"left"`/`"right"` for vertical ones.

### `label`
`{"op":"label","target":"sun","text":"the Sun","side":"below","color":"orange","size":32}`
- Writes text next to an existing element. `side`: `above`, `below`, `left`, `right`
  (default `below`). Optional `offset` (default 16). Optional `id`.

### `dot` (animated particle)
`{"op":"dot","id":"e1","path":"M 300 500 L 900 500 L 900 700","color":"red","r":10,"speed":200,"repeat":true,"label":"e⁻"}`
- A small filled circle that travels along `path` (SVG path data, not drawn itself).
- `speed` in board units per second (default 200), or `dur` = seconds for one pass.
- `repeat`: `true` loops forever (until `stop`, `clear`, or `erase`); a number loops that many times.
  Default: one pass, then the dot stays at the end.
- `delay`: seconds before it starts moving (stagger several dots on the same path for a stream).
- `count` + `spacing`: shorthand for a stream, e.g. `"count":6,"spacing":0.5` makes six dots
  0.5 s apart (ids `e1-0`..`e1-5`, all also addressable as `e1`).
- `label`: tiny text that rides along with the dot. `shape`: `"circle"` (default), `"square"`, `"star"`.
- A dot op does not hold up the timeline; the next op starts right away.

### `move`
`{"op":"move","target":"box","dx":300,"dy":0,"dur":1.5}` or `{"op":"move","target":"box","to":[1000,300]}`
- Slides an element (or a group). `to` moves its reference point (x/y for text/rect, center for
  circles/ellipses, start point for lines/paths) to that location.

### `scale`, `rotate`
`{"op":"scale","target":"atom","factor":1.5,"dur":1}` - grow/shrink around the element's center.
`{"op":"rotate","target":"arm","deg":45,"about":[800,450],"dur":1,"repeat":false}` - rotate
by `deg` around `about` (default: element center). `repeat: true` spins continuously.

### `highlight`
`{"op":"highlight","target":"title","style":"pulse"}`
- `style`: `"pulse"` (default, brief grow-and-glow), `"circle"` (draws a loose marker circle
  around it, which stays until erased; give it an `id` if you want to erase it), `"underline"`, `"box"`.
- `color` for the mark (default red).

### `color`
`{"op":"color","target":"cell","color":"green","fill":"green"}` - recolor an element.

### `fade`
`{"op":"fade","target":"oldDiagram","opacity":0.25}` - dim an element (or restore with 1).

### `erase`
`{"op":"erase","target":"box"}` - wipe one element (or group). `target` may also be an array of ids.

### `stop`
`{"op":"stop","target":"e1"}` - stop an animated dot/rotation where it is.

### `group`
`{"op":"group","id":"atom","children":["nucleus","shell1","e-a"]}` - make existing elements
movable/erasable together. You can also tag elements with `"group":"atom"` as you create them.

### `pause`
`{"op":"pause","dur":1.5}` - hold before the next op (in a step with no speech, a beat of silence).

### `image`-like icons: `icon`
`{"op":"icon","name":"sun","x":200,"y":200,"size":120,"color":"orange"}`
- Quick hand-drawn pictograms when you don't want to build one from paths.
  Names: `sun`, `bulb`, `battery`, `person`, `house`, `cloud`, `atom`, `gear`, `magnet`,
  `leaf`, `water-drop`, `flame`, `question`, `check`, `cross`, `star`, `clock`, `globe`, `heart`.
  `x`,`y` is the center. You can always draw your own instead.

## 4. Speech (`say`)

- Spoken by a natural, expressive voice. Write the way a great lecturer talks: contractions,
  rhetorical questions, emphasis through word choice. Punctuation shapes delivery: commas
  and ellipses add pauses, question marks lift the tone, exclamation adds energy.
- It is audio only: no markdown, emoji, bullet points, or URLs. Formulas are read aloud, so write
  them in words in `say` ("E equals m c squared") and in symbols on the board.
- Abbreviations are read literally; write them the way they should be pronounced.

### Delivery cues (audio tags)

The voice model (ElevenLabs v3) takes stage directions in square brackets inside `say`. They are
not spoken; they shape how the following words are delivered, until the next cue or the end of the step.
Captions hide them.

- Emotion / attitude: `[excited]`, `[curious]`, `[amazed]`, `[thoughtful]`, `[serious]`, `[warmly]`,
  `[playfully]`, `[sarcastic]`, `[reassuring]`, `[mischievously]`
- Delivery: `[whispers]`, `[softly]`, `[emphatically]`, `[slowly]`, `[quickly]`, `[dramatically]`
- Non-verbal: `[laughs]`, `[chuckles]`, `[sighs]`, `[exhales]`, `[gasps]`, `[clears throat]`
- Timing: `[pause]`, `[short pause]`, `[long pause]`

Free-form cues also work (`[like revealing a secret]`). Example:
`"say": "[curious] So where does the electron go? [pause] [excited] It goes... everywhere!"`

Use them the way a great lecturer varies their voice: to land a reveal, build suspense, share a
joke, slow down for the key idea. Without any cues the delivery is fine but flatter. Capitalization
("this is REALLY important") and ellipses also shape delivery.

## 5. Robustness

- Unknown ops and fields are ignored, so a typo will not break the lesson; it just won't draw.
- Referencing an id that doesn't exist is ignored.
- The board clips to 1600x900; anything outside it is invisible.
- Output must be valid JSON (no comments, no trailing commas).
