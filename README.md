# Puzzle Cube — STL Generator

A browser-based generator of 3D-printable **puzzle cubes**: a hollow cube whose six faces are jigsaw puzzles made of chunky pixel-style pieces. Every piece is guaranteed to be unique, faces interlock with randomized edge teeth, and the whole thing assembles without glue.

**Live demo: <https://zazaulola.github.io/puzzle-cube-generator/>**

Runs entirely in the browser — no server, no dependencies. Outputs binary STL files (one per plate per color) or a single ZIP.

## The puzzle

- The cube is a hollow box of six flat plates; each face is an `d×d` grid of 8×8-cell tiles, and every tile is cut into two **8×4 elements**, with cut orientations alternating in a checkerboard that stays consistent across the cube edges.
- Borders between neighboring elements wander randomly by **−1/0/+1 cells**, so every piece gets a unique pixelated outline (verified against all rotations and reflections — duplicates are regenerated). All teeth are straight, so every joint — in-face or across a cube edge — looks identical; pieces hold by friction (tune the fit with your slicer's XY compensation).
- Along the cube edges each rim cell goes to exactly one of the two meeting faces (**−1/+1**, never flush), forming a random box joint; the plate thickness equals the cell size, so joints are flush and the assembled cube reads as a seamless voxel lattice. Each cube corner cell belongs to one of the three pieces meeting at that corner.
- The faces are assembled flat on the table, then slid together; the edge teeth interlock and hold the cube without glue.

## Parameters

| Parameter | Values | Notes |
|---|---|---|
| Difficulty | 1–4 | 12 / 48 / 108 / 192 pieces (2·d² per face) |
| Colors | 1 or 4 | with 4 colors, adjacent pieces (including across cube edges) always differ — an exact 4-coloring of the adjacency graph |
| Scale | 1×/2×/3× | build plates per color; more plates → bigger pieces |
| Cube edge | auto or manual | auto mode binary-searches the largest cube that fits the planned plates |
| Max cell | mm, default 4 | caps the piece size in auto mode — the cell equals the piece thickness, and bigger cells print much longer |
| Seed | text | deterministic: the same seed always yields the same cutting |

The piece thickness always equals the puzzle cell (`edge / 8d`), which is what makes the edge joints flush.

## Printing

- Pieces lie flat by default, **no supports needed**; 3–4 perimeters, 15–25% infill.
- Optional **45°×45° tilted export**: every piece is rotated 45° about X and Y, so both sides print with the same finish and edges come out symmetric (no elephant-foot bias on one face). Supports are required in this mode.
- One STL per plate per color — print each file in its filament color (AMS/MMU friendly; layouts target a 256×256 mm plate).
- If the fit is too tight or too loose, tune your slicer's XY hole/contour compensation.

## Running locally

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Tech notes

- Vanilla JS, zero dependencies; UI in English, Russian, German, French, Spanish.
- Piece shapes are built on a shared-voxel ownership model (rim cells are voxels shared between faces), followed by local repair of diagonal pinches and disconnected fragments, all constrained to stay within ±1 cell of the nominal borders.
- 4-coloring uses exact DSATUR-ordered backtracking with restarts and a Kempe-chain local search fallback.
- Binary STL meshes are generated with ear-clipping triangulation and are watertight; the “download all” ZIP (store method) is assembled in the browser as well.
