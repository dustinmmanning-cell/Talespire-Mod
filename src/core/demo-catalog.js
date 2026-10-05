// A SYNTHETIC catalog for tests and offline previews.
//
// Names mirror real base-game assets so kit resolution behaves as it would in
// TaleSpire, but the GUIDs are fake and the sizes approximate. Slabs built from
// it would paste nothing in the game; the CLI refuses to write them.

import { Catalog, makeAsset } from './catalog.js';
import { hashString } from './util.js';

function fakeGuid(name) {
  const h = (n) => hashString(`${name}#${n}`).toString(16).padStart(8, '0');
  const s = h(1) + h(2) + h(3) + h(4);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

// [name, kind, group, tags, sx, sy, sz]
const TILES = [
  ['Grass 1x1', 'grassland', 'grass,nature', 1, 0.5, 1],
  ['Grass - Sparse', 'grassland', 'grass', 2, 0.5, 2],
  ['Dirt 1x1', 'floor', 'dirt,nature', 1, 0.5, 1],
  ['gravel_1x1_01', 'floor', 'gravel', 1, 0.25, 1],
  ['CobbleStone Floor Small', 'floor', 'cobblestone,stone,floor', 1, 0.25, 1],
  ['Castle Ruins Floor - Small', 'floor', 'stone,floor,ruins', 1, 0.25, 1],
  ['castle floor 1x1', 'floor', 'stone,floor,castle', 1, 0.5, 1],
  ['castle floor 2x2', 'floor', 'stone,floor,castle', 2, 0.5, 2],
  ['Tavern Floor 01', 'floor', 'wood,floor,tavern', 1, 0.25, 1],
  ['Rural Floor 02', 'floor', 'wood,floor,rural', 1, 0.25, 1],
  ['Moorgoth Floor - Carpet Centre', 'floor', 'carpet,floor', 1, 0.25, 1],
  ['Desert Ground Dry 01', 'floor', 'desert,sand', 1, 0.5, 1],
  ['Snow Ground 1x1', 'floor', 'snow,winter', 1, 0.5, 1],
  ['Cave Floor - Rock 2', 'floor', 'cave,rock,floor', 1, 0.5, 1],
  ['Swamp floor 1x1', 'floor', 'swamp', 1, 0.5, 1],
  ['Tilled Earth', 'floor', 'field,farm', 2, 0.5, 2],
  ['tempWater1x1', 'water', 'water', 1, 0.25, 1],
  ['tempWater2x2', 'water', 'water', 2, 0.25, 2],
  ['castle wall 1x1', 'wall', 'stone,wall,castle', 1, 2, 0.5],
  ['castle wall 1x1 window', 'wall', 'stone,wall,window,castle', 1, 2, 0.5],
  ['castle wall 2x2', 'wall', 'stone,wall,castle', 2, 2, 0.5],
  ['Tavern Wall - Small 01', 'wall', 'wood,wall,tavern', 1, 2, 0.25],
  ['Tavern Wall - Window 01', 'wall', 'wood,wall,window,tavern', 1, 2, 0.25],
  ['Rural Wall 01', 'wall', 'wood,wall,rural', 0.5, 2, 1],
  ['Castle Ruins Wall 01', 'wall', 'stone,wall,ruins', 1, 2, 0.5],
  ['Cave Wall 01', 'wall', 'cave,rock,wall', 1, 2, 0.5],
  ['Door -Peasant', 'door', 'wood,door', 1, 2, 0.25],
  ['Door - Fancy', 'door', 'wood,door', 1, 2, 0.25],
  ['Door - Portcullis', 'door', 'metal,gate', 1, 2, 0.25],
  ['Castle Ruins Stair', 'stairs', 'stone,stairs', 1, 1, 2],
  ['Tavern Roof flat 01', 'roof', 'roof,flat', 1, 0.25, 1],
  ['Thatched Roof 01', 'roof', 'roof,thatched', 1, 1, 1],
  ['Thatched Roof Corner 01', 'roof', 'roof,thatched', 1, 1, 1],
  ['Thatched Roof Inner Corner 01', 'roof', 'roof,thatched', 1, 1, 1],
  ['Thatched roof flat 01', 'roof', 'roof,thatched,flat', 1, 0.25, 1],
  ['Castle Ruins Crenellation - Small', 'wall', 'stone,crenellation', 1, 0.5, 0.5],
];

// [name, group, tags, sx, sy, sz]  (props are centred on their origin)
const PROPS = [
  ['Tree 01', 'Trees', 'tree,nature', 1.4, 4, 1.4],
  ['Tree 02', 'Trees', 'tree,nature', 1.6, 4.5, 1.6],
  ['Pine Tree 01', 'Trees', 'tree,pine,nature', 1.2, 5, 1.2],
  ['Dead Tree 02', 'Trees', 'tree,dead', 1.2, 3.5, 1.2],
  ['Dead Tree 03', 'Trees', 'tree,dead', 1.3, 3.5, 1.3],
  ['Bush 01', 'Plants', 'bush,nature', 0.9, 0.8, 0.9],
  ['Rock 01', 'Rocks', 'rock,stone', 0.8, 0.5, 0.7],
  ['Boulder Large', 'Rocks', 'rock,boulder', 1.8, 1.4, 1.6],
  ['Flowers Red', 'Plants', 'flower', 0.5, 0.3, 0.5],
  ['Mushroom Cluster', 'Plants', 'mushroom', 0.5, 0.4, 0.5],
  ['Barrel', 'Containers', 'barrel', 0.6, 0.9, 0.6],
  ['Barrel, Wine', 'Containers', 'barrel,wine', 0.7, 1, 0.7],
  ['Crate 01', 'Containers', 'crate,box', 0.7, 0.7, 0.7],
  ['Sack of Grain', 'Containers', 'sack', 0.5, 0.6, 0.4],
  ['Chest 01', 'Containers', 'chest', 0.9, 0.6, 0.5],
  ['Table Round', 'Furniture', 'table', 1.2, 0.8, 1.2],
  ['Table Long', 'Furniture', 'table', 2, 0.8, 0.9],
  ['Chair 01', 'Furniture', 'chair', 0.5, 1, 0.5],
  ['Stool', 'Furniture', 'stool', 0.4, 0.5, 0.4],
  ['Bench 01', 'Furniture', 'bench', 1.6, 0.5, 0.4],
  ['Bed Single', 'Furniture', 'bed', 0.9, 0.6, 1.9],
  ['Bookshelf 01', 'Furniture', 'bookshelf,books', 1.4, 2, 0.45],
  ['Shelf 01', 'Furniture', 'shelf', 1, 1.6, 0.4],
  ['Cabinet 01', 'Furniture', 'cabinet', 1, 1.8, 0.5],
  ['Desk 01', 'Furniture', 'desk', 1.4, 0.8, 0.7],
  ['Bar Counter', 'Furniture', 'counter,bar', 2, 1.1, 0.6],
  ['Fireplace Stone', 'Furniture', 'fireplace', 1.8, 2, 0.6],
  ['Stove 01', 'Furniture', 'oven,kitchen', 1, 1, 0.8],
  ['Anvil', 'Smithing', 'anvil', 0.8, 0.6, 0.4],
  ['Forge', 'Smithing', 'forge', 1.6, 1.4, 1.2],
  ['Weapon Rack', 'Smithing', 'weapon,rack', 1.2, 1.5, 0.4],
  ['Armor Stand', 'Smithing', 'armor', 0.7, 1.8, 0.5],
  ['Altar 01', 'Religious', 'altar', 1.6, 1, 0.8],
  ['Statue Knight', 'Religious', 'statue', 0.9, 2.4, 0.9],
  ['Pew', 'Religious', 'pew', 2, 0.9, 0.6],
  ['Candle Stand', 'Lights', 'candle', 0.3, 1.2, 0.3],
  ['Lantern -Small', 'Lights', 'lantern', 0.3, 0.5, 0.3],
  ['Torch Wall', 'Lights', 'torch', 0.3, 0.8, 0.2],
  ['Brazier', 'Lights', 'brazier', 0.7, 1, 0.7],
  ['Well 01', 'Structures', 'well', 1.6, 2.2, 1.6],
  ['Fountain Stone', 'Structures', 'fountain', 3, 1.5, 3],
  ['Cart 01', 'Vehicles', 'cart,wagon', 2.2, 1.4, 1.2],
  ['Rowboat', 'Vehicles', 'boat', 1, 0.6, 2.5],
  ['Market Stall', 'Structures', 'stall,market', 2, 2.2, 1.4],
  ['Campfire', 'Lights', 'campfire,fire', 1, 0.4, 1],
  ['Banner Red', 'Decor', 'banner,flag', 0.8, 2.5, 0.2],
  ['Rug Ornate', 'Decor', 'rug', 2, 0.05, 1.4],
  ['Skull Pile', 'Bones', 'bones,skull', 0.7, 0.4, 0.7],
  ['Skeleton Sitting', 'Bones', 'skeleton', 0.8, 1, 0.8],
  ['Coffin', 'Bones', 'coffin', 0.8, 0.6, 2],
  ['Throne', 'Furniture', 'throne', 1.2, 2, 1],
  ['Hay Bale', 'Farm', 'hay', 1.2, 0.8, 0.8],
  ['Trough', 'Farm', 'trough', 1.6, 0.5, 0.6],
  ['Harbor Fence 02', 'Fences', 'fence,wood', 2, 1, 0.25],
  ['Tombstone 01', 'Graveyard', 'tombstone,grave', 0.6, 1, 0.25],
  ['Crystal Cluster', 'Cave', 'crystal', 0.8, 1, 0.8],
  ['Pillar Stone', 'Structures', 'pillar,column', 0.6, 3, 0.6],
  ['Tree, Festive', 'Trees', 'tree,christmas', 1.4, 3, 1.4],
];

// A small stand-in for the "Cyberpunk and Sci-Fi" pack, using its group names.
const SCIFI_TILES = [
  ['concrete wall 1x1', 'Concrete Building', 'concrete,wall', 1, 2, 0.25],
  ['concrete wall 2x1', 'Concrete Building', 'concrete,wall', 2, 2, 0.25],
  ['concrete wall window 1x1', 'Concrete Building', 'concrete,wall,window', 1, 2, 0.25],
  ['concrete floor 1x1', 'Concrete Building', 'concrete,floor', 1, 0.25, 1],
  ['brick wall modern 1x1', 'Brick Building', 'brick,wall', 1, 2, 0.25],
  ['brick wall modern window', 'Brick Building', 'brick,wall,window', 1, 2, 0.25],
  ['city roof 1x1', 'Brick Building', 'roof', 1, 0.25, 1],
  ['hull wall 1x1', 'Hull', 'metal,wall', 1, 2.2, 0.3],
  ['hull wall window', 'Hull', 'metal,wall,window', 1, 2.2, 0.3],
  ['hull floor 1x1', 'Hull', 'metal,floor', 1, 0.25, 1],
  ['hull door 1x1', 'Hull', 'door', 1, 2.2, 0.3],
  ['sliding door', 'Doors (Modern)', 'door', 1, 2, 0.2],
  ['road asphalt 1x1', 'Street', 'road', 1, 0.25, 1],
  ['sidewalk 1x1', 'Street', 'pavement', 1, 0.3, 1],
  ['metal stairs', 'Outpost', 'stairs', 1, 1, 2],
];
const SCIFI_PROPS = [
  ['sci fi chest 02', 'Chest (Modern)', 'chest', 0.9, 0.6, 0.5],
  ['computer terminal', 'Facility', 'computer', 0.8, 1.4, 0.5],
  ['office desk modern', 'Office', 'desk', 1.4, 0.8, 0.7],
  ['office chair', 'Office', 'chair', 0.6, 1, 0.6],
  ['modern table', 'Office', 'table', 1.2, 0.8, 0.8],
  ['metal locker', 'Facility', 'locker', 0.6, 2, 0.5],
  ['bunk bed metal', 'Facility', 'bed', 1, 1.6, 2],
  ['street light', 'Street', 'streetlight', 0.4, 4, 0.4],
  ['dumpster', 'Street', 'dumpster', 1.8, 1.3, 1],
  ['generator', 'Industrial', 'machine', 1.5, 1.5, 1],
  ['barrel metal', 'Industrial', 'barrel', 0.6, 0.9, 0.6],
  ['crate metal', 'Industrial', 'crate', 0.8, 0.8, 0.8],
  ['neon sign bar', 'Street', 'sign', 1, 0.6, 0.1],
];

// Minis: name, group, tags.
const MINIS = [
  ['Human Commoner 01', 'Townsfolk', 'human,commoner'],
  ['Human Commoner 02', 'Townsfolk', 'human,commoner'],
  ['Human Guard', 'Townsfolk', 'human,guard,soldier'],
  ['Barkeep', 'Townsfolk', 'human,barkeep,innkeeper'],
  ['Merchant', 'Townsfolk', 'human,merchant,shopkeeper'],
  ['Farmer', 'Townsfolk', 'human,farmer,peasant'],
  ['Noble Woman', 'Townsfolk', 'human,noble'],
  ['Priest', 'Townsfolk', 'human,priest,cleric'],
  ['Bard', 'Townsfolk', 'human,bard,musician'],
  ['Dwarf Blacksmith', 'Humanoid', 'dwarf,smith'],
  ['Dwarf Fighter', 'Humanoid', 'dwarf,fighter'],
  ['Elf Wizard', 'Humanoid', 'elf,wizard,mage'],
  ['Elf Ranger', 'Humanoid', 'elf,ranger'],
  ['Halfling Rogue', 'Humanoid', 'halfling,rogue'],
  ['Gnome Tinkerer', 'Humanoid', 'gnome,artificer'],
  ['Tiefling Warlock', 'Humanoid', 'tiefling,warlock'],
  ['Goblin', 'Monster', 'goblin'],
  ['Goblin Boss', 'Monster', 'goblin,boss'],
  ['Orc Warrior', 'Monster', 'orc,warrior'],
  ['Skeleton', 'Undead', 'skeleton,undead'],
  ['Wolf', 'Beast', 'wolf,beast'],
  ['Cyber Mercenary', 'Sci-Fi Characters', 'human,mercenary,cyberpunk'],
  ['Android', 'Sci-Fi Characters', 'robot,android'],
];

export function demoCatalog() {
  const assets = [];
  for (const [name, group, tags] of MINIS) assets.push(makeAsset({ id: fakeGuid(`mini ${name}`), name, kind: 'creature', group, tags: tags.split(','), pack: 'synthetic' }));
  for (const [name, group, tags, sx, sy, sz] of TILES) {
    assets.push(makeAsset({ id: fakeGuid(name), name, kind: 'tile', group, tags: tags.split(','), size: { x: sx, y: sy, z: sz }, pack: 'synthetic' }));
  }
  for (const [name, group, tags, sx, sy, sz] of PROPS) {
    assets.push(makeAsset({
      id: fakeGuid(name), name, kind: 'prop', group, tags: tags.split(','),
      size: { x: sx, y: sy, z: sz }, center: { x: 0, y: sy / 2, z: 0 }, pack: 'synthetic',
    }));
  }
  for (const [name, group, tags, sx, sy, sz] of SCIFI_TILES) {
    assets.push(makeAsset({ id: fakeGuid(name), name, kind: 'tile', group, tags: tags.split(','), size: { x: sx, y: sy, z: sz }, pack: 'synthetic sci-fi' }));
  }
  for (const [name, group, tags, sx, sy, sz] of SCIFI_PROPS) {
    assets.push(makeAsset({
      id: fakeGuid(name), name, kind: 'prop', group, tags: tags.split(','),
      size: { x: sx, y: sy, z: sz }, center: { x: 0, y: sy / 2, z: 0 }, pack: 'synthetic sci-fi',
    }));
  }
  return new Catalog(assets, { source: 'synthetic', synthetic: true, note: 'fake GUIDs: previews and tests only' });
}
