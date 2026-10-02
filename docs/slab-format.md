# TaleSpire slab format v2 and placement conventions

A **slab** is TaleSpire's copy/paste unit: the tiles and props inside a selection, as text. It is the only way to bring an externally generated build into a board, whether by `Ctrl+V` or by a Symbiote calling `TS.slabs.sendSlabToHand`. This page covers what TaleForge's encoder relies on, and how sure we are of each fact.

The authoritative spec is Bouncyrock's [`DumbSlabStats/format.md`](https://github.com/Bouncyrock/DumbSlabStats/blob/master/format.md). The Symbiote API docs link to it from `slabs.pack` and `slabs.unpack`.

## Encoding

Slab text is the base64 of a gzip stream. People often wrap it in triple backticks when sharing; strip those and any whitespace before decoding. The compressed payload, after base64 decoding, may be at most **30,720 bytes**. The Symbiote API reports the current limit via `TS.slabs.getMaxSlabSizeInBytes()`.

Decompressed, all integers are little-endian:

| Bytes | Type | Field |
|---|---|---|
| 4 | u32 | magic `0xD1CEFACE` |
| 2 | u16 | version, `2` |
| 2 | u16 | layout count (distinct assets) |
| 2 | u16 | creature count, always `0` in v2 (slabs never carry minis) |
| 20 × layouts | | per layout: 16-byte asset GUID, `u16` instance count, `u16` reserved |
| 8 × instances | u64 | placements, grouped by layout in layout order |
| 2 | u16 | trailer `0x0000` |

The 2-byte trailer is not in the published spec, but every slab copied out of the game ends with it (35 of 35 real slabs checked). TaleForge writes it.

### GUID byte order

GUIDs use .NET `Guid` byte order: the first three groups are little-endian and the last two are written as-is. `32cfd208-c363-4434-b817-8ba59faeed17` is stored as `08 d2 cf 32 63 c3 34 44 b8 17 8b a5 9f ae ed 17`. If you read it as a plain big-endian UUID, you get a valid-looking ID that matches no asset.

### Placement word

```
 most significant ------------------------------------------- least significant
| 5 bits unused | 5 bits rot | 18 bits z | 18 bits y | 18 bits x |
```

- `x`, `y`, `z` are `round(value × 100)`, so positions have 1/100-tile precision and range from 0 to 2621.43. **y is vertical.**
- `rot` is a step index from 0 to 23; degrees = `rot × 15`.
- Coordinates must be ≥ 0. Normalize a build before encoding.

### Verification

`test/slab.test.js` builds the binary by hand from the spec and compares it with the encoder's output. Run with `TALEFORGE_SLAB_FIXTURES=dir1:dir2`, it also decodes real slabs copied out of TaleSpire and checks that decode → encode reproduces the game's binary **byte for byte**. All 35 slabs we tested passed, including a 265-asset build and several hand-built community roofs. The base64 differs from the original because .NET's deflate makes different choices than zlib's; only the decompressed bytes matter.

## Placement conventions

These rules determine whether generated geometry lines up. Most were measured in-game by the [citysmith](https://github.com/jchallenger/citysmith) project (Apache-2.0); we reproduce their ground-truth cases in `test/geometry.test.js`.

| Rule | Detail | Confidence |
|---|---|---|
| Units | 1 world unit = 1 tile = 5 ft; one creature per tile | official |
| Stored position = asset **origin** | Tiles are authored with the collider's min corner at the origin, and a rotated tile is re-anchored to the min corner of its rotated footprint. Props are authored with the collider centered on the origin. Both cases reduce to `stored = colliderCentre − offset(rot)`, where the offset's x/z swap on odd quarter turns. | measured (citysmith), our ground-truth test |
| Footprint rotation | Odd quarter turns (rot 6, 18) swap the x/z sizes | measured |
| Wall edges | A wall piece along a cell edge uses rot 0/6/12/18 for the zMin/xMax/zMax/xMin edge. A piece modelled along z (its z size larger than its x size) takes one extra quarter turn. | measured |
| Hip roofs (Thatched/Village kits) | edge rot `{zMin: 6, xMax: 0, zMax: 18, xMin: 12}`; outer corner `{xMin,zMin: 12, xMax,zMin: 6, xMin,zMax: 18, xMax,zMax: 0}`; inner (reflex) corners take the opposite corner's rotation; one cell in and one rise up per course | measured from community builds |
| Grid | Real slabs place quarter-turned tiles only at x/z fractions .0 or .5. Floors sit on whole tiles. | our analysis of real slabs |
| Surfaces | Ground tiles differ in thickness (cobble 0.25, grass 0.5). Align them by their **top** so streets don't sit in trenches. | measured |
| Props | TaleSpire **silently drops props whose colliders overlap** when pasting | measured |

### Things we have not verified in-game

- **Thin walls.** TaleForge keeps every wall inside its building's cells, flush against the boundary. A wall thinner than half a tile on a cell's far edge therefore lands on a .25 or .75 coordinate. Hand builders snap to the half grid instead. Slabs keep exact positions, so this pastes fine, but check it with `taleforge probe house` (or **Settings > Probes**) on your kit.
- **Furniture "front".** No source documents which way a prop faces at rot 0. TaleForge exposes this as the `furnitureFacing` setting (0, 6, 12 or 18 steps). The facing probe places one test prop per option so you can pick the right one.
- **Symbiote bounds units.** The API's `colliderBoundsBound` gives `width`, `height` and `depth` without saying whether those are full sizes or half extents. Tiles have their collider center at half their size, so TaleForge infers the scale from the whole catalog (`inferBoundsScale`) instead of assuming.

## Pasting behaviour

From the game's own UI and citysmith's in-game measurements:

- `Ctrl+V` (or `sendSlabToHand`) puts the slab **in hand at the cursor**, snapped to the grid. The absolute coordinates inside the slab don't decide where it lands; its own bounding box anchors it.
- Commit with a left press held for about 0.2 s. A zero-length synthetic click is swallowed. A right-click tap empties the hand; `Escape` does not.
- **Multi-part builds:** TaleForge gives every part the same two registration tiles just outside opposite corners of the whole build. All parts then share one bounding box and line up when each is placed on the same cell with the camera unmoved. Delete the stacked markers afterwards.
- LordAshes' **MultiPasteSlabsPlugin** / **SlabPlugin_CCM** (BepInEx) read a JSON document instead: `{"autoDrop": true, "dropX": 0, "dropY": 0, "dropZ": 0, "slabs": [{"code": "<base64>", "offsetX": 0, "offsetY": 0, "offsetZ": 0}]}`. TaleForge writes this as `*.multislab.slab` from unregistered chunks that keep their true coordinates.
- There is no URL, file-drop or API path that imports a whole board. Slabs are it.
