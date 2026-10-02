# TaleForge

Describe a place, or show TaleForge a map, and it builds it in your board from **your own** tiles and props.

## Quick start

1. Open **Settings** and paste an Anthropic API key (get one at console.anthropic.com). It is stored only in this Symbiote's folder on your computer and sent only to the Claude API.
2. On **Create**, describe what you want, pick a size, and press **Generate**.
3. On **Result**, check the preview, then press **Send to hand** (you must be in GM mode on a board) and click to place it.

Large builds come in several parts. Place every part on the **same grid cell** without moving the camera: they carry matching corner markers so they line up. Delete the stacked marker tiles at the two corners afterwards.

## Ways to build

- **Create**: a description, optionally with a reference image. "Mood" uses the image for inspiration; "Layout" reproduces a top-down map or floor plan.
- **Trace**: turns a top-down battle map image into floors, walls, water and trees cell by cell, with Claude labelling what each colour means.
- **Refine**: after a build, describe a change ("add a stable east of the inn") and TaleForge redraws the plan.
- **Plan JSON**: edit the plan by hand and rebuild instantly, no AI needed.

## Kit

TaleForge never hardcodes asset ids: it looks up walls, floors and furniture in the content packs your TaleSpire has loaded. The **Kit** tab shows which asset fills each role and lets you override any of them.

## Calibrate

Furniture orientation is not documented by the game. Use **Settings > Probes** to place small test builds and pick the facing that looks right.
