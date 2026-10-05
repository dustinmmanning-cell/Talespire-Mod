# NPCs

TaleForge can fill a build with the people and creatures who belong there. For each one it gives a name, race, role and two lines of notes for the GM, and picks the closest mini from your library. Placing the minis is one click each.

## Turning it on

- **Symbiote:** **Add NPCs** on **Create** is on by default. For a build you already have, open **Result > GM notes** and press **Add NPCs**, optionally with ideas ("the innkeeper is secretly a cultist"). **Write new NPCs** replaces them.
- **CLI:** `--npcs` on `generate` or `community`, or `taleforge npcs <plan.json> ["ideas"]` for an existing plan. The NPCs go in the report and on the preview. To place their minis, paste the plan into the Symbiote (**Result > Plan JSON > Rebuild from JSON**).

## What the AI is given

A second, cheaper call (medium effort by default) runs after the plan. It gets:

- the request;
- the location as a list of places with tile ranges: buildings with their rooms, doors and upper floors; community slabs with their footprint after turning, storeys and door sides; paths and areas;
- the minis you own, grouped by library group, with numbered variants collapsed ("Human Commoner (4 variants)").

It's asked to put people where they belong: the smith at the forge, the barkeep behind the bar, a guard at the gate, monsters and their leader in a dungeon. It scales the cast to the place (1 to 3 per shop or home, more in a tavern or market), up to 40. Each NPC gets:

- name, race and role;
- the tile and floor where they stand, and where that is in words;
- a two-sentence note: something to see or hear, and something to play (a want, a secret, a hook). Hostile creatures get a tactic instead;
- HP for a typical stat block, and whether they're hostile.

A short paragraph ties them together: relationships, tensions, a rumour.

## Matching minis

`resolveMini()` in `src/core/npcs.js`, in order:

1. the mini the AI named, exactly;
2. any variant of it ("Human Commoner" matches "Human Commoner 01" to "04"). Variants take turns, so a crowd doesn't look cloned;
3. the best word match: race counts most, then the role and the AI's description, against each mini's name, tags and group;
4. a plain person (human, commoner, villager…), then anything.

Each NPC's mini is shown in the list. Minis come from `contentPacks.getMoreInfo` in the Symbiote and from the install's `index.json` files in the CLI, and are kept apart from tiles and props, so a mini is never used as a building piece.

## Placing them

Slabs can't carry creatures, so minis are placed one at a time:

1. `TS.creatures.createBlueprint(creatureInfo)` makes a `talespire://creature-blueprint/…` URL. The creature info has the NPC's name, the matched mini (`morphs[0].boardAssetId`, at its default scale), HP as current and max, the campaign's eight stat names (from `creatures.getCreatureStatNamesForThisCampaign`) with zero values, and hidden on or off.
2. `TS.urls.submit(url)` passes it to TaleSpire, which treats it like pasting a copied creature: the mini goes into your hand.
3. You click its marker's spot on the board.

**Place all** walks the list. The Symbiote subscribes to `creatures.onCreatureStateChange`. When a `creatureAdded` event names the NPC you're holding, the next NPC goes into your hand. A mini someone else places doesn't count. **Next NPC** skips ahead by hand, and **Stop** ends the run.

## Limitations

- **Untested in TaleSpire so far.** The calls and the event follow the official Symbiote API docs, and the browser test checks the blueprint TaleForge sends against a fake TaleSpire. Whether TaleSpire accepts a blueprint built from scratch, and how it reports the placed mini, is confirmed only by the first real run. If **Place** fails, the message under **Place all** says why.
- **Positions are a guide.** The AI works from tile ranges, not the finished walls and furniture, so a marker can land on a table or next to a wall. Place the mini on the nearest sensible spot.
- **No stat blocks.** Only HP is set, and the eight stats are left at zero. The notes are for roleplay, not rules.
- **A refine keeps the NPCs as they were.** If buildings move, press **Write new NPCs**.
