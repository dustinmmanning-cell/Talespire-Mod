# Building with community slabs (mod.io)

TaleForge can build a scene from **finished slabs other TaleSpire players have shared**, instead of drawing every building itself. Since late 2023, TaleSpire's in-game slab browser has searched and published slabs on [mod.io](https://mod.io/g/talespire), the official TaleSpire mod repository. TaleForge reads the same repository through mod.io's public API.

## Setup

1. Make a free mod.io account (the same one you'd use to publish slabs), then open **Account > API access** and generate an API key. It is read-only.
2. In the Symbiote: **Settings > Community slabs (mod.io)**, paste the key and save. On the command line: `export MODIO_API_KEY=...`.
3. On **Create**, tick **Build with community slabs from mod.io**, describe the scene, and press **Generate**. On the command line: `taleforge community "a harbour village with a tavern and a lighthouse"`.

## What happens

1. **Searches.** The AI turns your request into two to six short mod.io searches ("tavern", "lighthouse", "fishing hut"), one per building or landmark. This is a cheap call at low effort. On the command line, `--search tavern,lighthouse` skips it.
2. **Search and read.** TaleForge searches TaleSpire's mods tagged as slabs, takes the most popular matches, downloads them, and reads each one (see below). Every slab is checked against **your** asset library. A slab that uses assets you don't have (another pack, or custom assets from mods) is set aside, with the reason shown.
3. **Arrange.** The AI gets the usable slabs. For each it sees the name, creator, footprint, storeys, door sides, genre, main asset groups, tags and summary. It places slabs whole: anywhere on the map, turned 0, 90, 180 or 270 degrees, possibly more than once. It then draws what's missing, such as roads, terrain, walls and small buildings, with the normal builder.
4. **Assemble.** The compiler reserves each slab's footprint so generated buildings, walls, scatter and props stay off it. Generated ground is left out where the slab brings its own floor, and walking surfaces are levelled with the ground around them. The slab is turned and moved into place, everything is merged, and the result is split into pasteable parts as usual.
5. **Credit.** The Result tab and the CLI report list every slab placed, with its creator and mod.io page.

## Reading a slab from mod.io

What a TaleSpire slab upload contains isn't documented. What the first real runs showed:

- Every upload is a **ZIP64** zip. .NET zip writers use the ZIP64 layout even for small files, with 0xFFFFFFFF in the size fields and the real sizes in an extra record.
- The zip holds `README.md` (a screenshot link and the description) and **`slabBin`**, TaleSpire's own slab file. It starts with the magic `0x51ABFACE` (bytes `ce fa ab 51`), a u16 version (1) and a length. The file is almost always that length plus 210 bytes. The rest of the layout isn't public.

`slabFromBytes()` in `src/core/modio.js` doesn't depend on a guess about the rest. For a `slabBin`, `extractSlabs()` decodes the ranges the header's length points at with every likely codec: gzip, zlib, raw DEFLATE, LZ4, or an uncompressed slab. It then scans the whole file for gzip, zlib, LZ4 and slab signatures. Whatever decodes to a valid v2 slab is kept, and several slab parts in one file are merged. The decoders in `src/core/inflate.js` report where each stream ends, so slab data in the middle of a file decodes exactly, whatever comes after it.

Other shapes are read too: slab text in the mod's metadata, a zip holding slab text, a raw or gzip slab binary (also a zip inside a zip), base64 slab text with or without code fences, and JSON with a slab string inside.

Every candidate is checked by decoding it. **Copy mod.io report** (under the error on Create, or on Result) shows how each slab was read, for example `zip entry "slabBin" (TaleSpire slab file v1: gzip at bytes 10-6149 of 6349, 200 bytes after)`. For a slab that couldn't be read, it shows what's inside the file: the header, the first bytes, the bytes after the data, compression signatures and what each decode attempt found. That report is what to send if mod.io slabs don't load.

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

- **The `slabBin` layout is inferred.** The first real runs confirmed that the panel can call mod.io directly, that search and downloads work, and what the zips contain. Reading `slabBin` relies on the header's length and signature scanning, checked against simulated files. A real one decoding is the final test.
- **Search quality is mod.io's.** Results depend on how builders named and described their slabs.
- **Slabs are placed whole.** They can't be resized or edited, and a slab with its own large ground base takes that whole area.
- **Turns are quarter turns only.**
