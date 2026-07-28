# ◐ Focus Presenter

A single-file, fully **offline** tool for presenting flows, charts and slides while keeping
the audience focused on exactly the part you're talking about — nothing more.

When you present a process (user journey, data flow, architecture…), anything visible that
you're *not* discussing pulls listeners' minds forward. Focus Presenter lets you hide or
dim everything except the current step, and move that focus forward or backward live as the
conversation moves.

## Getting started

1. Open `FocusPresenter.html` in any browser (double-click it — no internet, no install,
   no server; nothing is ever uploaded anywhere).
2. Load your content:
   - **PDF** — drag & drop or `Open`. Best option: PDFs are vector, so they stay sharp at
     any zoom.
   - **Images** — drop one or many (each becomes a slide).
   - **Paste** — press `Ctrl+V` with a screenshot on the clipboard. This is the "works with
     any tool" path: screenshot anything (Miro, Figma, a website, Excel) and paste it.
   - **PowerPoint / Keynote / Google Slides** — export the deck as PDF
     (*File → Export / Download → PDF*), then open that.

## The three focus modes

| Mode | Key | What it does |
|---|---|---|
| **Slate** | `S` | An opaque panel hiding one area. Spawn as many as you like. |
| **Curtain** | `C` | A full-width slate hiding everything below a line. Drag its top edge down the flow to reveal step by step — the classic "sliding slate". |
| **Tear** | `T` | Tear holes in a slate to *let light in* exactly where you want. Drag on a slate to tear; each tear is a live window you can drag and resize; seam it closed again with its `⊕` button (or a click while tear mode is on). |
| **Spotlight** | `L` | Dims the whole document except one movable window. Best for non-linear charts where the relevant part isn't simply "next". |

Every slate and the spotlight can be:
- **moved** — drag it, or nudge with arrow keys (`Shift` = big steps; the view follows it
  automatically along a long flow),
- **reshaped / widened at will** — drag any edge or corner,
- **torn open and seamed back** — holes belong to their slate and move with it, so a torn
  slate stays one physical object you're in full charge of,
- **killed** — its `×` button, or select it and press `Delete`; `X` clears everything,
- **re-spawned** — `S` / `C` / `L` at any time.

Slate styles: **paper** (invisible on white slides), **dark**, or **frosted glass** (blur —
the audience sees *something* is there without reading it). The slider sets shade strength.

## Presenting

`F` fullscreen · `H` hide the toolbar · `Ctrl+wheel` or `+`/`−` zoom · `W` fit width ·
`?` full shortcut list.

## Why it stays sharp on long, magnified flows

Long exported flow charts (one tall PDF page) are the worst case for most viewers: they
rasterize the page once and stretch the bitmap, so zooming in turns text to mush — or the
page exceeds the browser's canvas size limit and goes blank.

Focus Presenter instead treats the PDF as what it is — vector data:

- Every page is sliced into **tiles**; each tile is its own canvas, kept safely under
  browser texture limits (8192 px per side), so page height is unlimited.
- On every zoom change, tiles are **re-rendered from the vector source** at
  `zoom × devicePixelRatio` — never bitmap-stretched. Text is pixel-perfect at 1000%+.
- Tiles render **lazily** around the visible area and far-away tiles are **evicted**, so
  even huge documents stay fast and memory-bounded.

(Images can't beat their source resolution — for deep zooming, export PDF rather than PNG.)

## Development

```
focus-presenter/
├── FocusPresenter.html   ← the shippable single file (give people just this)
├── build.sh              ← assembles it
├── src/part1.html        ← UI shell + styles
├── src/app.js            ← application logic
└── vendor/               ← pdf.js 3.11.174 (inlined at build time; worker loads from a blob URL, so no network is ever needed)
```

Edit `src/`, run `./build.sh`, done.
