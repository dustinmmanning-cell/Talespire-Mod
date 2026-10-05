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

What a TaleSpire slab upload contains isn't documented. mod.io stores every upload as a zip, so `slabFromBytes()` in `src/core/modio.js` tries every likely shape:

- slab text carried in the mod's metadata
- a zip holding slab text, a raw slab binary or a gzip slab, including a zip inside a zip. ZIP64 zips are read too: .NET zip writers use the ZIP64 layout even for small files, with 0xFFFFFFFF in the size fields and the real sizes in an extra record. The first real run showed mod.io's slab zips need this.
- gzip
- base64 slab text, with or without code fences
- JSON with a slab string inside

Every candidate is checked by decoding it. **Result > Copy mod.io report** shows how each slab was read, and why any couldn't be. That report is what to send if mod.io slabs don't load.

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

- **Untested against real mod.io data so far.** The client follows the mod.io v1 API, cross-checked against the open-source modio-rs client, and is tested against a fake mod.io. The slab file format and whether the panel can call mod.io directly are confirmed only by the first real run.
- **Search quality is mod.io's.** Results depend on how builders named and described their slabs.
- **Slabs are placed whole.** They can't be resized or edited, and a slab with its own large ground base takes that whole area.
- **Turns are quarter turns only.**
