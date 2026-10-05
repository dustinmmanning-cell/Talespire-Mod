# Building with community slabs (mod.io)

TaleForge can build a scene from **finished slabs other TaleSpire players have shared**, instead of drawing every building itself. Since late 2023, TaleSpire's in-game slab browser has searched and published slabs on [mod.io](https://mod.io/g/talespire), the official TaleSpire mod repository. TaleForge reads the same repository through mod.io's public API.

## Setup

1. Make a free mod.io account (the same one you'd use to publish slabs), then open **Account > API access** and generate an API key. It is read-only.
2. In the Symbiote: **Settings > Community slabs (mod.io)**, paste the key and save. On the command line: `export MODIO_API_KEY=...`.
3. On **Create**, tick **Build with community slabs from mod.io**, describe the scene, and press **Generate**. On the command line: `taleforge community "a harbour village with a tavern and a lighthouse"`.

## Options

| Create tab | CLI | What it does |
|---|---|---|
| **Every building from slabs** (on by default) | default; `--mixed` turns it off | The AI can't draw buildings: every building is a slab, repeated and turned where needed (a row of homes from one house slab). TaleForge draws only what joins them: ground, roads, plazas, terrain, fences, trees and outdoor props. Off, the AI draws any building no slab covers. |
| **Slab creators: One creator's set** (default) | `--creator one` (default) | All slabs come from one builder, for a consistent look. TaleForge picks the creator whose slabs match the most of your searches, then looks through that creator's whole mod.io catalog (not just the top search results) for each building. If none of their slabs can be used, it tries the runner-up. |
| **Best match from anyone** | `--creator any` | The best match for each building, whoever made it. |
| **A creator I name** | `--creator LemurianSettler` | Only that creator's slabs. Any case, and part of the name works ("lemurian"). |

The Result tab says whose slabs were used, and which buildings that creator had nothing for. A refine keeps the build's setting.

## What happens

1. **Searches.** The AI turns your request into two to six short mod.io searches, one per building or landmark: just the word that names it ("tavern", "house", "lighthouse"). For each it also lists other words builders use for the same thing (tavern: inn, alehouse, pub). This is a cheap call at low effort. On the command line, `--search tavern,lighthouse` skips it.
2. **Search, rank and pick.** mod.io's search matches *any* word and sorts by popularity, so "large tavern" also finds "Large Mountain with Cave". TaleForge re-ranks the results by the words in each slab's name, tags and summary:
   - names are split on capitals, so "LemurianTownHouse6x6" reads as Lemurian, Town, House;
   - rarer words count for more ("magic" outweighs "shop" in "magic shop");
   - a slab that fits another search better ranks lower here (a tavern called "…TownHouse…" isn't the best house).

   It then takes slabs from each search in turn, so every building gets its share of the 18 slabs it downloads. Before, the first searches could use them all; in an early test, "village house" got none, and the AI drew the homes itself.
3. **Read and check.** Each picked slab is downloaded and read (see below), and checked against **your** asset library. A slab that uses assets you don't have (another pack, or custom assets from mods) is set aside, with the reason shown.
4. **Arrange.** The AI gets the usable slabs, grouped by creator. For each it sees the name, creator, which search it was found for, footprint, storeys, door sides, genre, main asset groups, tags and summary. It is told to keep to one creator or series, and to repeat and turn a slab rather than mix styles. It places slabs whole: anywhere on the map, turned 0, 90, 180 or 270 degrees, possibly more than once. It then draws what's missing (roads, terrain, walls, and with **Every building from slabs** off, small buildings) with the normal builder.
5. **Assemble.** The compiler reserves each slab's footprint so generated buildings, walls, scatter and props stay off it. Generated ground is left out where the slab brings its own floor, and walking surfaces are levelled with the ground around them. The slab is turned and moved into place, everything is merged, and the result is split into pasteable parts as usual.
6. **Credit.** The Result tab and the CLI report list every slab placed, with its creator and mod.io page.

## Reading a slab from mod.io

What a TaleSpire slab upload contains isn't documented. What the first real runs showed:

- Every upload is a **ZIP64** zip. .NET zip writers use the ZIP64 layout even for small files, with 0xFFFFFFFF in the size fields and the real sizes in an extra record.
- The zip holds `README.md` (a screenshot link and the description) and **`slabBin`**, TaleSpire's own slab file:
  - the magic `0x51ABFACE` (bytes `ce fa ab 51`), a u16 version (1) and a u32 length;
  - a **zlib** stream of that length holding an ordinary v2 slab, the same binary as a clipboard slab;
  - usually 200 more bytes. In one file these held a second zlib v2 slab, an empty one, and a few files are longer there. The rest of this part isn't public.

`slabFromBytes()` in `src/core/modio.js` doesn't depend on a guess about the rest. For a `slabBin`, `extractSlabs()` decodes the ranges the header's length points at with every likely codec: gzip, zlib, raw DEFLATE, LZ4, or an uncompressed slab. It then scans the whole file for gzip, zlib, LZ4 and slab signatures. Whatever decodes to a valid v2 slab is kept, and several slab parts in one file are merged. The decoders in `src/core/inflate.js` report where each stream ends, so slab data in the middle of a file decodes exactly, whatever comes after it.

Other shapes are read too: slab text in the mod's metadata, a zip holding slab text, a raw or gzip slab binary (also a zip inside a zip), base64 slab text with or without code fences, and JSON with a slab string inside.

Every candidate is checked by decoding it. **Copy mod.io report** (under the error on Create, or on Result) shows how each slab was read, for example `zip entry "slabBin" (TaleSpire slab file v1: zlib at bytes 10-6149 of 6349, 200 bytes after)`. For a slab that couldn't be read, it shows what's inside the file: the header, the first bytes, the bytes after the data, compression signatures and what each decode attempt found. That report is what to send if mod.io slabs don't load.

## Turning slabs

`transformPrefab()` in `src/core/prefab.js` turns a slab clockwise in quarter turns:

- a point (x, z) in a slab W wide becomes (z, W − x), and each piece's `rot` goes up by 6;
- rotation happens around each piece's collider centre, so tiles (anchored at the min corner of their rotated footprint) and props (anchored at their centre) both land right.

The rotation sense comes from conventions measured in the game: the pitched-roof tables put a roof side on the east edge at 0 and on the south edge at 6. A test turns a compiled cottage one, two and three times and checks it matches the same cottage compiled already turned, piece for piece, roof rotations included.

## The proxy

If TaleSpire's panel can't reach mod.io directly (a cross-origin block), run `taleforge proxy` and set **mod.io API base URL** to `http://127.0.0.1:8787/modio/v1`:

- `GET /modio/v1/...` is relayed to the mod.io API. A key of `proxy` uses `MODIO_API_KEY`.
- `GET /modio/download?url=...` fetches a mod.io file. Only `mod.io`, `modapi.io` and `modcdn.io` HTTPS URLs are allowed.

## Rules and courtesy

- **Use your own key.** mod.io's API terms require it, along with mod.io branding where the content is shown, no scraping, and no competing service. TaleForge only searches and downloads what one build needs, a few files at a time, and keeps what it downloaded so rebuilds don't fetch again.
- **Creators own their slabs.** mod.io's terms leave ownership with the creator. Assembled builds are fine for your own games, but don't republish them as your own work. TaleForge keeps each creator's name and link with every build.
- **Other sites:** Tales Tavern and Tales Bazaar have no public API. TaleForge doesn't scrape them.

## Limitations

- **Part of the `slabBin` layout is unknown.** Real runs confirmed the header and the zlib slab after it: all 18 test slabs read. What the trailing bytes mean isn't known. Slab parts found there are merged in, and the report lists each part with its asset count.
- **Door sides are detected, not declared.** TaleForge looks for door pieces on the building's edge, then on the ground storey near an edge of the slab. Some slabs still show no doors, and the AI then orients them by footprint alone.
- **Search quality is mod.io's.** Results depend on how builders named and described their slabs.
- **Slabs are placed whole.** They can't be resized or edited, and a slab with its own large ground base takes that whole area.
- **Turns are quarter turns only.**
