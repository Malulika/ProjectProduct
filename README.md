# Steam Iron — 9:16 product animation

A self-contained, programmatically drawn product animation for Instagram
Reels / TikTok: wrinkles vanishing from olive fabric as a compact handheld
steam iron glides across it.

**1080 × 1920 · 30 fps · 12 s · 360 frames.** No images, no fonts, no
frameworks, no build step. Two files do the work: `index.html` draws every
frame to a `<canvas>`, `export.js` drives it frame by frame into an MP4.

---

## Quick start

```bash
# 1. install the headless browser used for export
npm install

# 2. preview in a browser (no server needed — it is a single file)
open index.html                 # macOS
xdg-open index.html             # Linux
start index.html                # Windows

# 3. render 360 PNGs and stitch them into out.mp4
node export.js
```

`node export.js` writes `frames/frame_0000.png … frame_0359.png`, then runs:

```bash
ffmpeg -framerate 30 -i frames/frame_%04d.png -c:v libx264 -pix_fmt yuv420p -crf 18 out.mp4
```

### npm scripts

| command            | what it does                                   |
| ------------------ | ---------------------------------------------- |
| `npm install`      | installs Puppeteer (downloads a Chromium)      |
| `npm run export`   | frames **and** video (`node export.js`)        |
| `npm run frames`   | frames only (`--no-video`)                     |
| `npm run video`    | stitch frames already on disk (`--skip-frames`)|

### export.js options

```
--no-video        render frames, skip ffmpeg
--skip-frames     skip rendering, stitch what is already in frames/
--frames N        render only the first N frames
--scale S         render at S× size (e.g. 0.5 for a fast preview)
--crf N           x264 quality, default 18 (lower = better)
```

### Requirements

- **Node 18+** and **npm** — for Puppeteer.
- **ffmpeg** with `libx264`, on your `PATH`. Install with
  `brew install ffmpeg` (macOS), `sudo apt install ffmpeg` (Debian/Ubuntu),
  or `winget install ffmpeg` (Windows). If it is missing, the frames are
  still written and the exact stitch command is printed so you can run it
  yourself.

Two environment variables let you reuse binaries you already have instead
of downloading more:

```bash
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome   # skip Puppeteer's Chromium
FFMPEG_PATH=/path/to/ffmpeg                 # use a specific ffmpeg
```

(With `PUPPETEER_SKIP_DOWNLOAD=1 npm install` plus
`PUPPETEER_EXECUTABLE_PATH`, no browser download happens at all.)

---

## Dev panel

Append `?debug=1` to the URL — `index.html?debug=1` — for a small overlay:

- **timeline scrubber** bound directly to `window.seek`
- **iron speed** — scales the length of the pass (0.60×–2.00×); the closing
  framing follows it, so the reveal always lands on ironed cloth
- **wrinkle density** — crease clusters per megapixel of cloth (6–40);
  the default of 22 gives ~97 clusters
- **smoothing** — per-wrinkle relax duration (60–900 ms)
- **boundary** — draws the wrinkle boundary at the soleplate's trailing
  edge, the pre-relax edge, and the contact line

It also reads out the frame index, `t`, elapsed seconds, render time per
frame, the live mesh size and the current beat.

Keys: `space` play/pause, `←`/`→` step one frame (`shift` for ten),
`b` toggle the boundary overlay.

The panel is only *created* when `debug=1` is present, and the exporter
reads pixels straight off the canvas, so it can never appear in a frame.

---

## How it works

### One timeline variable

Everything is a pure function of a single normalized `t ∈ [0,1]`:

```js
window.seek(0.25)        // render the exact frame at t = 0.25
window.seekFrame(90)     // same frame, by index
window.snapshot()        // PNG data URL of the current frame
window.setParams({ wrinkleCount: 48, smoothMs: 320 })
window.TOTAL_FRAMES      // 360
```

`seek()` is synchronous and holds no state between calls: no
`Math.random()`, no accumulated physics, no wall-clock time. The seeded
PRNG (`mulberry32`) and the solved-once wrinkle pass times mean two calls
with the same `t` produce identical pixels — which is what makes the export
frame-accurate and the scrubber trustworthy.

### The fabric

The shirt is a parametric surface over `(u,v)`, sampled every frame as a
mesh of quads covering only what the camera can see — 39k–68k quads,
each held at a constant ~7 px on screen. Surface height is

```
h(x,y) = drape(x,y) + gate(x) · wrinkles(x,y)
```

`wrinkles` is a seeded set of sine ridges with randomized amplitude,
wavelength and rotation, each inside an elliptical envelope that is long
along its crest and short across it. They come in three scales, so the
cloth has a hierarchy of folds — a few long dominant creases, a middle
layer, fine crimping — instead of one uniform texture.

Shading is the *gradient* of `h` lit by a directional light, so each ridge
gets light and dark bands running across it and reads as depth rather than
as a drawn line. Valleys pick up a little occlusion. The mesh is drawn to
an offscreen canvas and composited with a small blur, which dissolves the
quad faceting without touching the fold shapes.

### The wrinkle boundary

The ironed region is a band `[L, R]` in world x. `R` is the soleplate's
trailing edge as it travels; `L` opens leftwards while the iron presses
down on landing. `gate(x)` returns creasedness — 1 creased, 0 relaxed —
with a narrow transition, so the boundary is crisp and locked to the plate.

Two things stop it from looking mechanical:

- **Per-wrinkle smoothness.** Each cluster carries `smoothness` 0→1 and
  eases over 250 ms (ease-out cubic) once the pass reaches its centre. The
  crossing times are solved once per rebuild, so this stays a function of
  `t` rather than an accumulation.
- **Pre-relax.** Cloth just ahead of the trailing edge is already easing
  off, so ridges truncated by the boundary fade in over ~150 px instead of
  ending in hard blocks. The "smooth starts here" line itself stays sharp.

Once the iron lifts, `R` runs out to the cloth's edge over ~1 s, so the
camera's pull-back reveals genuinely smooth fabric rather than a leftover
strip at the frame edge.

### The iron

Drawn in a local frame whose origin is the soleplate's contact point:
local `(0,0)` sits on the cloth surface and the plate's bottom edge is
`y = 0`. Contact is therefore structural — `lift` is exactly `0` for the
whole 3–8 s pass and for the closing rest, so the plate cannot drift off
the fabric plane.

Selling that contact:

- a contact shadow drawn **on the cloth plane**, not on the iron, so it
  stays put as the iron rises — a broad ambient pool that spreads and
  lightens with height, plus a tight dark core that tightens as the plate
  presses down;
- the mesh compresses under the plate — vertices pull in toward the plate
  centre by a few percent and settle slightly, and crease amplitude is
  damped there;
- the iron rides the cloth's own macro undulation, so its height drifts
  with the surface instead of tracking a ruled line.

### Steam

A deterministic particle system: wisp *i* is born at a fixed time, so its
whole life is a function of `t`. Each is emitted from the contact point
**as it was at its birth time**, which leaves the plume behind in world
space as the iron moves on. Most escape ahead of the nose and the rest off
the heel, so both rise clear of the body silhouette; each stretches and
thins as it climbs, hot at the plate and cooling to warm white.

---

## Timeline

| time        | beat                                                                  |
| ----------- | --------------------------------------------------------------------- |
| 0.0 – 2.0 s | Macro on wrinkled cloth, slow push-in. No iron. The light rakes across (azimuth sweeps 263°→208°) to make the creases read. |
| 2.0 – 3.0 s | The iron descends and settles. The contact shadow tightens on landing. |
| 3.0 – 8.0 s | The pass. The iron glides left to right, wrinkles vanish behind it, steam rises from the contact point. The camera tracks part of the travel so the iron stays framed and the wake stays legible. |
| 8.0 – 10.0 s| The iron lifts and exits upward; the camera pulls back to reveal the whole smooth shirt. |
| 10.0 – 12.0 s| The iron returns and settles centre frame. A warm bloom comes up behind it. |

The **bottom third is deliberately left clean** through the closing beat —
no marks, no text — for a caption overlay added later.

---

## Palette

| role                  | hex       |
| --------------------- | --------- |
| olive fabric          | `#6B7348` |
| warm cream background | `#F2EBDD` |
| charcoal outlines     | `#2B2B28` |
| hot accent (steam, CTA) | `#E8513A` |

Light is a soft warm morning rake from the upper left: a radial gradient on
the background, a multiply/lighten wash on the cloth, a vignette and a
faint deterministic grain over everything.

---

## Files

```
index.html    the whole animation — inline CSS and JS, nothing external
export.js     Puppeteer + ffmpeg exporter
package.json  one devDependency (puppeteer)
frames/       generated PNGs (gitignored)
out.mp4       generated video (gitignored)
```
