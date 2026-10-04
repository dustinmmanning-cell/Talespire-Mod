# TaleForge

Describe a place, or show TaleForge a map, and it builds it in your board from **your own** tiles and props.

## Quick start

1. Open **Settings** and set up the AI:
   - **Provider**: Anthropic (Claude) or OpenAI (GPT), whichever you have an API key for (console.anthropic.com or platform.openai.com).
   - **API key**: stored only in this Symbiote's folder on your computer and sent only to that provider's API. Each provider keeps its own key, so you can switch back and forth.
   - **Model**: each option shows an estimated cost per build. After you've built with a model, the estimate becomes your own average.
   - Press **Save settings**.
2. On **Create**, describe what you want, pick a size, and press **Generate**. The line under the button shows which model will be used.
3. On **Result**, check the preview, then press **Send to hand** (you must be in GM mode on a board) and click to place it. The result shows the model, tokens used and what the build cost.

Large builds come in several parts. Place every part on the **same grid cell** without moving the camera: they carry matching corner markers so they line up. Delete the stacked marker tiles at the two corners afterwards.

## Ways to build

- **Create**: a description, optionally with a reference image. "Mood" uses the image for inspiration; "Layout" reproduces a top-down map or floor plan.
- **Trace**: turns a top-down battle map image into floors, walls, water and trees cell by cell, with the AI labelling what each colour means.
- **Refine**: after a build, describe a change ("add a stable east of the inn") and TaleForge redraws the plan.
- **Plan JSON**: edit the plan by hand and rebuild instantly, no AI needed.

Buildings can have several floors, each with its own shape, rooms and furniture. Ask for it in the description ("a three-storey inn with guest rooms upstairs", "like shipping containers stacked askew"). The preview shows each upper floor as its own panel under the map.

## Kit

TaleForge never hardcodes asset ids: it looks up walls, floors and furniture in the content packs your TaleSpire has loaded. The **Kit** tab shows which asset fills each role and lets you override any of them.

## Calibrate

Furniture orientation is not documented by the game. Use **Settings > Probes** to place small test builds and pick the facing that looks right.

## Troubleshooting

- **The badge at the top right says "assets unavailable".** The banner under it says why. Click the badge to try again. Asset packs that TaleSpire can't describe (usually ones added by mods) are skipped and listed on the **Kit** tab, so everything else still loads. To report a problem, use **Kit > Copy pack diagnostics** and paste the result: it describes the shape of what TaleSpire sent, not your assets.
