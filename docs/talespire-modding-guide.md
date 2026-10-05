# The TaleSpire modding guide

This guide covers everything you need to understand, use and build TaleSpire mods, gathered while designing TaleForge. Each claim is labelled by how it was sourced:

- **[verified]** Read directly from source code, official docs, or real data in this project.
- **[reported]** Seen in search results or listings whose full pages we could not open (thunderstore.io, talespire.com and bouncyrock.com were unreachable from our build environment).

Treat [reported] items as leads, and check them against the source before relying on them.

---

## 1. TaleSpire in one page

- **What it is:** a 3D virtual tabletop by Bouncyrock Entertainment, built in Unity, sold on Steam (app 720620), Windows-native. **[verified, Steam ID from search]**
- **Scale:** 1 tile = 5 ft = one creature's space. **[verified]**
- **Boards and campaigns:** a campaign holds boards. A board is a 3D map built from:
  - **tiles** (floors, walls, roofs, stairs; grid-snapped)
  - **props** (free-placed objects: furniture, trees, rocks)
  - **creatures** (minis)

  Content comes in content packs. **[verified, Symbiote API types]**
- **GM vs player:** only clients in GM mode can build. A player-mode client can't receive a slab in hand. **[verified, Symbiote docs: Permissions; `sendSlabToHand` failure `clientIsNotInGmMode`]**
- **Slabs:** copying any selection produces a text **slab**, and pasting it elsewhere rebuilds it. Slabs are how builds are shared (for example on [Tales Tavern](https://talestavern.com), the community slab and board sharing site). Slabs never contain minis. See [slab-format.md](slab-format.md). **[verified]**
- **Board limits:** about 2000 × 2000 grid units and 1,000,000 assets per board. **[reported, citysmith notes]**

---

## 2. Three ways to mod TaleSpire

| | Official Symbiotes | Unofficial BepInEx plugins | External tools |
|---|---|---|---|
| What | Web pages in a side panel, with a JS API into the game | C# DLLs injected into the Unity game | Programs that read or write slabs and assets |
| Language | HTML/CSS/JS | C# (.NET Framework 4.7.2) + HarmonyX | anything |
| Distribution | mod.io, browsable in-game | Thunderstore, installed with r2modman | GitHub, itch.io, websites |
| Survives game updates | yes (versioned API) | often breaks | yes, while the slab format holds |
| Can change the board | only by putting a slab in the GM's hand | anything the game can do | through paste only |

TaleForge is a Symbiote with a companion CLI (an external tool). It also outputs a JSON format for one BepInEx plugin, to bridge all three.

---

## 3. Symbiotes: the official mod API **[verified unless marked]**

Sources: [Bouncyrock/symbiotes-docs](https://github.com/Bouncyrock/symbiotes-docs) (the docs site, also installable as a Symbiote), [Bouncyrock/symbiotes-examples](https://github.com/Bouncyrock/symbiotes-examples), and the site <https://symbiote-docs.talespire.com>.

### What they are

A Symbiote is a folder containing a `manifest.json`. It loads either a local HTML page or a remote website into TaleSpire's embedded **Chromium** (version 111 when the docs were written, updated without notice). With an `api` block in the manifest, TaleSpire injects the **TaleSpire API** as `TS` (alias for `com.bouncyrock.talespire`).

### Installing and developing

- **Manual install folder:** `%AppData%\..\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\<your folder>\manifest.json`. Both settings and the Symbiote panel have an "Open Symbiotes Directory" button.
- **Installed from the in-game mod browser** (mod.io): `...\TaleSpire\primary\Mods\Symbiotes\`. This is a separate location with separate logs and storage, so don't install the same Symbiote both ways with the same interop ID.
- Enable Symbiotes in settings. Turning on **development mode** gives you live reload on file save (files and folders starting with `.` are ignored) and **Chromium devtools at `localhost:8080`**.
- "Create new Symbiote" in the panel (dev mode) scaffolds a template with a fresh interop ID.
- Publishing: upload to mod.io. It then appears in the in-game "Community Mods > Symbiotes" browser.

### Manifest v1 (essentials)

```json
{
  "manifestVersion": 1,
  "name": "My Symbiote",
  "entryPoint": "/index.html",
  "summary": "…", "descriptionFilePath": "/README.md", "version": "1.0", "license": "MIT",
  "about": { "website": "https://…", "authors": ["…"] },
  "api": {
    "version": "0.1",
    "initTimeout": 10,
    "initializeEarly": false,
    "doNotUseNickname": false,
    "subscriptions": { "symbiote": { "onStateChangeEvent": "myHandler" } },
    "interop": { "id": "<uuid v4>" }
  },
  "controls": { "reload": true, "navigation": false },
  "icons": { "64x64": "/icon.png", "notification": "/notify24.png" },
  "environment": {
    "webViewBackgroundColor": "#1c1b22",
    "loadTargetBehavior": "currentTab",
    "capabilities": ["playAudio", "runInBackground"],
    "extras": ["colorStyles", "fonts", "icons", "diceFinder", "/my-injected.js", "/my-injected.css"]
  }
}
```

- Local paths start with `/` and can't leave the Symbiote folder. Remote URLs must be complete (`https://…`).
- Subscription handlers must be **global functions**. A `let foo = function…` in a closure isn't reachable.
- Events arrive as `{ kind, payload }`.
- `runInBackground` keeps the Symbiote alive when another Symbiote takes focus. Otherwise it's shut down, and `willShutdown` delivery is best-effort only.
- `interop.id` is needed for `sync` messages and for `talespire://symbiote/…` URLs. Two installed Symbiotes with the same ID both fail to load.
- `loadTargetBehavior: "popup"` lets OAuth-style logins open in a popup.

### API v0.1 surface

| Namespace | Calls |
|---|---|
| `boards` | whereAmI, getBoardsInThisCampaign, getMoreInfo |
| `bookmarks` | getBookmarksInThisCampaign, getBookmarksInThisBoard, gotoBookmark, sendToBookmark |
| `campaigns` | whereAmI, getMoreInfoAboutCurrentCampaign |
| `chat` | send, multiSend, sendAsCreature, multiSendAsCreature |
| `clients` | whoAmI, getClientsInThisBoard, isMe, getMoreInfo |
| `contentPacks` | getContentPacks, getMoreInfo, findBoardObjectInPacks, createThumbnailElementForBoardObject |
| `creatures` | getUniqueCreaturesInThisCampaign, getCreaturesOwnedByPlayer, getSelectedCreatures, getMoreInfo, getCreatureStatNamesForThisCampaign, createBlueprint |
| `debug` | log |
| `dice` | isValidRollString, makeRollDescriptors, evaluateDiceResultsGroup, sendDiceResult, putDiceInTray |
| `initiative` | getQueue |
| `localStorage.global` / `.campaign` | setBlob, getBlob, deleteBlob (one string blob each, up to 5 MB, scoped to the Symbiote) |
| `parties` | getParties, getCreaturesInParty |
| `picking` | startPicking (let the user click something on the board) |
| `players` | whoAmI, isMe, getPlayersInThisCampaign, getPlayersInThisBoard, getMoreInfo |
| `rulers` | getRulers, startRuler, getLocalRuler, getMoreInfo |
| `slabs` | **unpack, pack, getDataSize, sendSlabToHand, getSlabInActiveSelection, getMaxSlabSizeInBytes** |
| `symbiote` | getIfThisSymbioteIsVisible, sendNotification |
| `sync` | send, multiSend, getClientsConnected |
| `system.clipboard` | setText |
| `units` | getDistanceUnitsForThisCampaign |
| `urls` | submit (a `talespire://` URL, sent directly), createUrlPrefixForThisSymbiote |

Subscriptions (event sources):

- `urls.onUrlMessage`
- `rulers.onRulerEvent`
- `chat.onChatMessage`
- `creatures.onCreatureStateChange`, `creatures.onCreatureSelectionChange`
- `campaigns.current.onInfoChanged`, `.onBoardEvent`, `.onSettingsChanged`
- `sync.onSyncMessage`, `sync.onClientEvent`
- `dice.onRollResults`
- `slabs.onSlabCopied` (payload: slab, status `success` or `oversized`, and dataSize)
- `contentPacks.onContentPackChange`
- `clients.onClientEvent`
- `symbiote.onVisibilityEvent`, `.onStateChangeEvent` (`hasInitialized`, `willShutdown`), `.onNotificationEvent`
- `players.onCampaignPlayerEvent`, `.onBoardPlayerEvent`
- `initiative.onInitiativeEvent`
- `picking.onPickingEvent`

**Failure handling:** calls can fail with named causes, for example `sendSlabToHand` returns `notInBoard`, `clientIsNotInGmMode`, `invalidSlabString`, `dataOversized` or `spawnFailed`. Calls can also be rate-limited (`rateLimited`). The official examples check `result.cause !== undefined` and also use `.catch`, so handle both.

**What Symbiotes can't do (yet):** the FAQ says the API deliberately excludes anything that changes saved board state. The one building-related exception is **putting a slab in the GM's hand**, which the GM then places. TaleForge is built around exactly that.

**Minis:** a Symbiote can't spawn creatures directly either, but `creatures.createBlueprint(creatureInfo)` builds a `talespire://creature-blueprint/…` URL from a creature info object. That object can be made from scratch: the docs say its `id` is ignored. It holds the name, `morphs: [{ boardAssetId, scale }]`, `hp` and `stats` (`{ name, value, max }`), hidden, flying and torch flags, and more. `urls.submit(url)` hands the URL straight to TaleSpire, which treats it like a pasted creature. `creatures.onCreatureStateChange` reports `creatureAdded` with the new creature's fragment. TaleForge's NPCs use this (see [npcs.md](npcs.md)). **[documented, untested in-game]** Pack details list minis under `creatures` as `{ id, name, groupTag, tags, miniAsset, baseAsset, defaultScale, icon }`, with no collider bounds.

### The content-pack catalog

`contentPacks.getMoreInfo` returns every tile, prop and creature the client has loaded. Each placeable element is `{ id, name, isDeprecated, groupTag, tags[], assets[], isInteractable, colliderBoundsBound: { center, width, height, depth }, icon }`. That's enough to build an asset catalog at runtime, with no hardcoded GUIDs, and it includes any modded content packs. `findBoardObjectInPacks(id, packs)` combined with `createThumbnailElementForBoardObject(obj, size)` gives you the library thumbnail as a DOM element.

**What the game actually returns differs from the docs** (seen in TaleSpire in October 2026, in a web view reporting Chrome 111):

- `tiles` and `props` are **objects keyed by asset GUID**, not arrays. Each value still carries its own `id`.
- Pack details have **no `id`**: the keys are `optionalName`, `tiles`, `props`, `creatures` and `music`, and `optionalName` was empty. Take pack names from `getContentPacks()` and match them up by order.
- `icon` is `{ atlas, region }`, not `{ atlasIndex, region }`.
- In one install, 26 packs came back, but only 2 had tiles or props: 1,396 + 1,035 and 364 + 494, for 3,289 in all.

Code that does `for (const t of pack.tiles)` fails with "object is not iterable". Read the values instead (`Object.values(pack.tiles)`), and accept arrays too in case a later build follows the docs.

### Theme extras

- `colorStyles` injects CSS variables: `--ts-color-primary`, `--ts-background-primary` / `-secondary` / `-tertiary`, `--ts-accent-primary` / `-hover` / `-background`, `--ts-button-background` / `-hover`, `--ts-color-danger`, `--ts-link`, and `--ts-accessibility-border` / `-focus`.
- `fonts` provides OptimusPrinceps.
- `icons` provides `ts-icon-*` classes and sizes.

---

## 4. BepInEx plugins (unofficial)

**Stack [verified from LordAshes' template and search results]:**

- **BepInEx 5.4** via the `BepInExPack` for TaleSpire (Thunderstore: *bbepisTaleSpire/BepInExPack*), installed and managed with **r2modman**.
- Plugins live in `BepInEx/plugins` (advanced Mono.Cecil patchers in `BepInEx/patchers`).
- A plugin is a .NET Framework 4.7.2 class library deriving from `BaseUnityPlugin`, with `[BepInPlugin(Guid, Name, Version)]`, and `[BepInDependency(...)]` for other plugins. It patches game code with HarmonyX (`new Harmony(Guid).PatchAll()`).
- It references the game's assemblies from `TaleSpire_Data/Managed`: `Bouncyrock.TaleSpire.Runtime.dll`, `Bouncyrock.TaleSpire.DataModel.Runtime.dll`, `Bouncyrock.TaleSpire.AssetManagement.dll`, `Bouncyrock.BouncePackage.*`, `Bouncyrock.TaleSpire.3rdParty.Runtime.dll`, Unity's DLLs, and so on.
- Settings use `Config.Bind(section, key, default)`. These are editable in r2modman.

**Common snippets** (from [LordAshes/TaleSpire-CommonCodeSnippets](https://github.com/LordAshes/TaleSpire-CommonCodeSnippets)):

```csharp
bool IsBoardLoaded() =>
    CameraController.HasInstance && BoardSessionManager.HasInstance &&
    BoardSessionManager.HasBoardAndIsInNominalState && !BoardSessionManager.IsLoading;

foreach (CreatureBoardAsset asset in CreaturePresenter.AllCreatureAssets.ToArray()) { /* minis */ }
var pos = asset.BaseLoader.gameObject.transform.position;   // a mini's base position
```

**Caveats:**

- Plugins depend on game internals and break when TaleSpire updates.
- Modded clients should be flagged for bug reports. The *SetInjectionFlag* plugin (TaleSpire-Modding org) exists for this.
- Bouncyrock's public issue tracker asks for reports from **unmodded** clients.

### Key libraries and community

- **HolloFox** maintains:
  - **RadialUIPlugin**, which adds entries to the radial menus.
  - **Extra Assets Library (EAL)**.
  - **BoardPersistencePlugin**.
  - **ThunderManPlugin**. **[reported]**
- The **TaleSpire-Modding** GitHub org hosts:
  - RadialUIPlugin
  - SetInjectionFlag
  - AutoInitiative
  - MaxDrawDistance
  - CharacterRuler
  - AutoDiceCleanup
  - RPCPlugin (Photon messaging)
  - PluginTemplate
  - a BepInEx fork **[verified listing]**
- Custom content migrated from **EAR/EAL** to the **Custom Assets Library Plugin (CALP)**, by LordAshes and HolloFox, with **CALPIE** for auras, effects, filters, animations and sound. **[reported]**
- The `#talespire-modding` channel on the official Discord. **[verified, docs]**

---

## 5. LordAshes: the most prolific modder

LordAshes publishes as **LordAshes** on Thunderstore and on GitHub. A few patterns run through his work:

- He builds shared **dependency plugins** that other plugins reuse:
  - **FileAccessPlugin**: uniform file and URL access, searching the `CustomData` folders of all installed packs.
  - **StatMessaging**: client-to-client messages via synchronized creature data.
  - **RadialUI** (HolloFox).
- He follows a convention of showing a plugin's name on the main menu only when it gives the user a feature.

### Plugins [GitHub verified unless marked]

| Plugin | What it does |
|---|---|
| TaleSpire-GUIMenuPlugin | Hierarchical GUI menus for other plugins |
| TaleSpire-ReplicatorPlugin | Copy a custom asset along a line, polyline or circle |
| TaleSpire-AssetDownloaderPlugin | GM tells clients to download assets |
| Talespire-LookupPlugin | Look things up from chat |
| TaleSpire-ChatRollerPlugin / AutoRollPlugin | Roll from chat; auto-roll dice sent via `talespire://dice` |
| TaleSpire-Dnd5EMacrosPlugin | D&D 5E rules automation |
| TaleSpire-BeyondLinkPlugin / BeyondLinkViaChrome | D&D Beyond to TaleSpire sync |
| MultiPasteSlabsPlugin / SlabPlugin_CCM | Paste several slabs at stated positions from one JSON document (LCtrl+B) **[reported, Thunderstore]** |
| SymbioteApiPlugin, SymbioteManagerPlugin, ModIoPlugin, InvisibilityPlugin | Thunderstore listings **[reported]** |
| Custom Mini Plugin (CMP), Extra Assets Registration (EAR), Custom Assets Library Plugin (CALP, with HolloFox) | Custom minis, effects and assets (OBJ/MTL or Unity asset bundles) **[reported]** |
| **TalespireDungeonMaker** | Converts Watabou's one-page-dungeon JSON into a slab via an ASCII grid and pattern-rewrite rules (`Translations.txt`) for wall pieces, corners and doors. This is the ancestor of TaleForge's trace and auto-wall approach. |

### His developer conventions (from CommonCodeSnippets)

- **Asset names:** creator initials + content name + sequence number (`laAssassin01`). Register your initials with LordAshes.
- **Sizes:** build assets as medium (1×1) creatures and scale them with the base. Set `size` in `info.txt`.
- **Materials:** use one material per asset. Effects should loop or end static; use `timeToLive` to auto-remove.
- **Library groups:** reuse core TaleSpire groups. Don't create one group per creator.
- **Thunderstore pack layout:**
  - Root: `icon.png`, `LICENSE.txt`, `manifest.json`, `README.md` and the plugin DLL.
  - Non-plugin files go under `plugins/`.
  - Files other plugins should see go under `plugins/CustomData/<Minis|Slabs|Images|…>/`. For example: `plugins/CustomData/Slabs/temple01/temple01.slab`, plus `info.txt` and `portrait.png`.
- **Dependencies:** content-only packs shouldn't hard-depend on a plugin. Say "compatible with EAR" instead.

---

## 6. Assets on disk

TaleSpire ships a readable `index.json` per content pack at `<install>/Taleweaver/<pack-uuid>/index.json` **[verified, citysmith and SlabelFish read it]**. The base pack's UUID is `d71427a1-5535-4fa7-82d7-4ca1e75edbfd` **[reported, SlabelFish]**. The file has `Tiles`, `Props`, `Creatures`, `Music` and `IconsAtlases` arrays. A placeable entry contains:

- `Id`, `Name`, `GroupTag`, `Tags`, `Folder`, `IsDeprecated`
- `ColliderBoundsBound: { m_Center, m_Extent }`, where extents are half sizes, as in Unity's `Bounds`
- the asset loaders

Older builds (2021) kept per-asset `*.boardAsset` JSON files under `TaleSpire_Data/Taleweaver/boardAssets/Tiles`, with `GUID`, `boardAssetName`, `boardAssetGroup`, `Tags` and `colliderBounds` **[verified, brcoding/TaleSpireHtmlSlabGeneration]**.

**Asset names are inconsistent.** A loose name search for "floor" can return "Tavern no floor". A tag search for stone walls returned 117 assets, including a floor. Pin known asset names, filter by structured fields (group, tags), and constrain by **shape**: 1×1 floors, thin 1-long walls.

Base-game names TaleForge pins (gathered by the community from real builds):

- **Ground:** `Grass 1x1`, `Dirt 1x1`, `gravel_1x1_01`, `CobbleStone Floor Small`, `tempWater1x1`/`2x2`, `Swamp floor 1x1`, `Cave Floor - Rock 2`, `Tilled Earth` (2×2)
- **Floors:** `castle floor 1x1`, `Castle Ruins floor stone 1x1`, `Tavern Floor 01`, `Rural Floor 02`, `Moorgoth Floor - Carpet Centre`
- **Walls:** `castle wall 1x1`, `castle wall 1x1 window`, `Tavern Wall - Small 01`, `Rural Wall 01`
- **Doors and stairs:** `Door -Peasant`, `Door - Fancy`, `Door - Portcullis`, `Castle Ruins Stair`, `md_stairs_01`
- **Roof kits:** `Thatched Roof 01`, `Thatched Roof Corner 01`, `Thatched Roof Inner Corner 01`, `Thatched roof flat 01`; the `Village Roof …` kit; `Haunted roof …`
- **Props:** `Tree 01`, `Dead Tree 02`/`03`, `Well 01`, `Lantern -Small`, `Lantern on hook 01`, `Harbor Fence 02`

---

## 7. The slab format and placement rules

See [slab-format.md](slab-format.md) for the byte layout, GUID order, size limit, our empirical checks, the placement conventions, and how pasting behaves. The short version:

- base64(gzip(binary)), at most 30,720 bytes compressed
- u64 per placement: x/y/z at 1/100 tile (y up), 18 bits each, plus rot (15° steps)
- positions are asset **origins**: the min corner for tiles, the center for props
- props with overlapping colliders are dropped on paste
- multi-part builds need a shared bounding box (registration markers) or a multi-paste plugin

---

## 8. The `talespire://` URL scheme

**[reported, search snippets of talespire.com/url-scheme, plus the Symbiote docs]**

- `talespire://dice/<roll>` puts dice in the tray (for example `talespire://dice/d12`).
- `talespire://creature-blueprint/<base64>` is what copying a creature produces. Paste it to spawn.
- `talespire://symbiote/<system_segment>/<user_segment>` delivers text to a Symbiote. Get the prefix from `TS.urls.createUrlPrefixForThisSymbiote()` (requires an interop ID).
- The official Slab Stats example opens `talespire://asset/<id>` from a Symbiote **[verified, example code]**.
- There is **no** URL that imports a board or slab. Pasting is the only way to bring in a build.
- Since October 2023 the in-game **slab browser** searches and publishes community slabs on mod.io (the official TaleSpire repository). Slabs spawn without subscribing; TaleSpire downloads them to a temporary file on first use. **[reported, Bouncyrock news and dev logs]** TaleForge reads the same repository through the mod.io API; see [community-slabs.md](community-slabs.md).

---

## 9. Community tools for slabs

| Tool | What it does |
|---|---|
| [Bouncyrock/DumbSlabStats](https://github.com/Bouncyrock/DumbSlabStats) | Official C# reference reader and format doc |
| [LuPro/SlabelFish](https://github.com/LuPro/SlabelFish) | Python slab ⇄ JSON converter with asset-index lookup (no license file) |
| [brcoding/TaleSpireHtmlSlabGeneration](https://github.com/brcoding/TaleSpireHtmlSlabGeneration) | JS generator for the *old* v1 float format (center/extents per asset); historical |
| [LordAshes/TalespireDungeonMaker](https://github.com/LordAshes/TalespireDungeonMaker) | Watabou one-page dungeon to slab, via ASCII pattern rules |
| [jchallenger/citysmith](https://github.com/jchallenger/citysmith) | Python: Watabou MFCG / Fantasy Town Generator GeoJSON to chunked town slabs, with a catalog from `index.json`, in-game-measured conventions, multi-slab output and an optional Claude "translation layer" (Apache-2.0) |
| **TaleForge** (this repo) | AI planner + compiler + Symbiote; see [architecture.md](architecture.md) |

---

## 10. Gotchas worth knowing before your first build

1. **Run TaleSpire windowed** when automating or screenshotting. Exclusive fullscreen captures black frames.
2. **Hold the click:** a pasted slab commits on a left press held for about 0.2 s. A right-click tap clears the hand; a held right-click drags.
3. **Camera discipline for multi-part pastes:** point the camera straight down and don't move it. Pastes anchor on the cursor's ray hit.
4. **Modifier keys mean different things** with an empty hand versus holding something. With a slab in hand: `Ctrl` + scroll lifts it, `Shift` + scroll slides it, `Alt` + scroll rotates it.
5. **Overlapping props vanish** on paste. Don't stack multi-piece trees.
6. **Normalize by whole tiles.** Shifting a build by a fractional minimum (one overhanging prop) moves every tile off the grid that minis snap to.
7. **Two install locations for Symbiotes** (manual and mod.io) mean two separate storage areas.
8. **Bug reports go from unmodded clients.** Disable BepInEx before reporting to Bouncyrock.
9. **Don't trust the Symbiote API types blindly.** `contentPacks.getMoreInfo` returns objects where the docs say arrays; see [the content-pack catalog](#the-content-pack-catalog). Treat API data defensively and log its shape when something fails.
10. **The Symbiote web view is not a current Chrome.** It reported Chrome 111, so check newer JavaScript and CSS features (for example `Object.groupBy`, the `Set` methods, async iteration of a `fetch` body, CSS nesting) before using them.

---

## Sources

**Read directly**

- [Bouncyrock/symbiotes-docs](https://github.com/Bouncyrock/symbiotes-docs) (API v0.1 and manifest v1)
- [Bouncyrock/symbiotes-examples](https://github.com/Bouncyrock/symbiotes-examples)
- [Bouncyrock/DumbSlabStats](https://github.com/Bouncyrock/DumbSlabStats)
- [LordAshes/TaleSpire-CommonCodeSnippets](https://github.com/LordAshes/TaleSpire-CommonCodeSnippets)
- [LordAshes/TalespireDungeonMaker](https://github.com/LordAshes/TalespireDungeonMaker)
- [LuPro/SlabelFish](https://github.com/LuPro/SlabelFish)
- [brcoding/TaleSpireHtmlSlabGeneration](https://github.com/brcoding/TaleSpireHtmlSlabGeneration)
- [jchallenger/citysmith](https://github.com/jchallenger/citysmith) (docs: `slab-format-v2.md`, `asset-conventions.md`, `pasting-into-talespire.md`)
- [TaleSpire-Modding org](https://github.com/TaleSpire-Modding)

**Search results only** (pages unreachable from our environment)

- [Thunderstore TaleSpire](https://thunderstore.io/c/talespire/)
- [MultiPasteSlabsPlugin](https://thunderstore.io/c/talespire/p/LordAshes/MultiPasteSlabsPlugin/)
- [SlabPlugin_CCM](https://thunderstore.io/c/talespire/p/LordAshes/SlabPlugin_CCM/)
- [SymbioteApiPlugin](https://thunderstore.io/c/talespire/p/LordAshes/SymbioteApiPlugin/)
- [Custom Assets Library Plugin](https://thunderstore.io/c/talespire/p/PluginMasters/Custom_Assets_Library_Plugin/)
- [BepInExPack](https://thunderstore.io/c/talespire/p/bbepisTaleSpire/BepInExPack/)
- [TaleSpire URL scheme](https://talespire.com/url-scheme)
- [Symbiotes docs site](https://symbiote-docs.talespire.com/)
- [Dev Log 390: Symbiotes documentation](https://bouncyrock.com/news/articles/talespire-dev-log-390-symbiotes-documentation)
- [Dev Log 379](https://bouncyrock.com/news/articles/talespire-dev-log-379)
- [Tales Tavern](https://talestavern.com)
