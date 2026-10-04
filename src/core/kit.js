// The kit: semantic building roles resolved to real assets in the user's catalog.
//
// The AI and the plan speak in roles ("wood wall", "grass", "barrel"). The kit
// turns each role into an asset by trying, in order:
//   1. a user override (role -> exact asset name or id),
//   2. pinned names known to exist in the base game (gathered by the community
//      by building with them; see docs/talespire-modding-guide.md),
//   3. structured searches (group tag, tags, name terms) constrained by shape:
//      floor tiles must be exactly 1x1, walls thin and 1 or 2 long, ...
//   4. a fallback material ("snow" falls back to "grass").
// A constraint on SHAPE is what keeps a wrong-but-similarly-named asset out:
// a 2-wide door can never land in a 1-wide wall slot and drag the board off grid.

export const SURFACES = [
  'grass', 'dirt', 'mud', 'gravel', 'sand', 'snow', 'ice', 'cobblestone', 'flagstone', 'stone_floor',
  'wood_floor', 'plank', 'carpet', 'marble', 'tile', 'cave_floor', 'water', 'deep_water', 'swamp', 'lava', 'field',
  'concrete', 'asphalt', 'metal_floor',
];

export const WALL_MATERIALS = ['stone', 'castle', 'wood', 'plaster', 'brick', 'ruined', 'cave', 'concrete', 'metal', 'industrial'];

// A structure's wall or floor may also be one of the library's own building
// sets, by group name: "kit:Concrete Building". See Catalog.buildingKits().
export const KIT_PREFIX = 'kit:';
export const isKitMaterial = (m) => typeof m === 'string' && m.startsWith(KIT_PREFIX);

// The sci-fi pack's building groups, as they appear in TaleSpire's library.
const SCIFI_CITY = ['Concrete Building', 'Brick Building', 'Construction', 'Street', 'Industrial'];
const SCIFI_TECH = ['Hull', 'Facility', 'Interstellar', 'Outpost', 'Chamber'];

export const PROP_ROLES = [
  'tree', 'conifer', 'dead_tree', 'bush', 'rock', 'boulder', 'flowers', 'tall_grass', 'log', 'stump', 'mushroom',
  'barrel', 'crate', 'sack', 'chest', 'table', 'chair', 'bench', 'stool', 'bed', 'bookshelf', 'shelf', 'cabinet',
  'desk', 'counter', 'fireplace', 'oven', 'anvil', 'forge', 'weapon_rack', 'armor_stand', 'altar', 'statue', 'pillar',
  'fountain', 'well', 'cart', 'boat', 'market_stall', 'tent', 'campfire', 'brazier', 'torch', 'lantern', 'candle',
  'chandelier', 'banner', 'rug', 'bones', 'skeleton', 'coffin', 'cage', 'ladder', 'crystal', 'pottery', 'tankard',
  'food', 'plant', 'tombstone', 'sign', 'hay', 'trough', 'throne', 'cauldron', 'pew', 'training_dummy', 'fence', 'instrument',
  'computer', 'locker', 'vending_machine', 'vehicle', 'streetlight', 'dumpster', 'machine', 'pipes', 'other',
];

// Seasonal pieces never fit a generated build. (Sci-fi versus fantasy is
// handled by genre: see Kit.genreOk.)
const OFF_THEME = ['festive', 'christmas', 'xmas', 'halloween'];

const SURFACE_BASE = { kind: 'tile', footprint: [1, 1], maxHeight: 1.6, excludeTerms: OFF_THEME };

const SURFACE_DEFS = {
  grass: { q: [{ name: 'Grass 1x1' }, { group: 'grassland' }, { anyTerms: ['grass'], excludeTerms: ['sparse', 'road', 'wall', 'tall', 'dead'] }], fallback: 'dirt' },
  dirt: { q: [{ name: 'Dirt 1x1' }, { anyTerms: ['dirt', 'earth', 'soil'], excludeTerms: ['tilled', 'road', 'wall'] }], fallback: 'gravel' },
  mud: { q: [{ anyTerms: ['mud', 'muddy'] }], fallback: 'dirt' },
  gravel: { q: [{ name: 'gravel_1x1_01' }, { anyTerms: ['gravel'] }], fallback: 'dirt' },
  sand: { q: [{ anyTerms: ['sand', 'sandy'], excludeTerms: ['sandstone wall'] }, { name: 'Desert Ground Dry 01' }, { terms: ['desert'], excludeTerms: ['fence', 'wall'] }], fallback: 'dirt' },
  snow: { q: [{ anyTerms: ['snow', 'snowy'] }], fallback: 'grass' },
  ice: { q: [{ anyTerms: ['ice', 'frozen'], excludeTerms: ['dice', 'slice', 'police'] }], fallback: 'snow' },
  cobblestone: { q: [{ name: 'CobbleStone Floor Small' }, { anyTags: ['cobblestone', 'cobble', 'pavement'] }, { anyTerms: ['cobble', 'cobblestone'] }], fallback: 'flagstone' },
  flagstone: { q: [{ name: 'Castle Ruins Floor - Small' }, { name: 'Castle Ruins floor stone 1x1' }, { anyTerms: ['flagstone', 'paving', 'paved'] }], fallback: 'stone_floor' },
  stone_floor: { q: [{ name: 'castle floor 1x1' }, { name: 'Castle Ruins floor stone 1x1' }, { group: 'floor', tags: ['stone'] }, { anyTerms: ['stone floor', 'stone'], group: 'floor' }], fallback: 'dirt' },
  wood_floor: { q: [{ name: 'Tavern Floor 01' }, { name: 'Rural Floor 02' }, { group: 'floor', tags: ['wood'] }, { group: 'floor', anyTerms: ['wood', 'wooden', 'plank'] }], fallback: 'stone_floor' },
  plank: { q: [{ anyTerms: ['plank', 'planks', 'boards', 'boardwalk'] }], fallback: 'wood_floor' },
  carpet: { q: [{ name: 'Moorgoth Floor - Carpet Centre' }, { anyTerms: ['carpet'] }], fallback: 'wood_floor' },
  marble: { q: [{ anyTerms: ['marble'], group: 'floor' }, { anyTerms: ['marble'] }], fallback: 'stone_floor' },
  tile: { q: [{ anyTerms: ['tiled', 'tiles', 'mosaic'] }], fallback: 'stone_floor' },
  cave_floor: { q: [{ name: 'Cave Floor - Rock 2' }, { anyTerms: ['cave'], group: 'floor' }, { anyTerms: ['cave'] }], fallback: 'dirt' },
  water: { q: [{ name: 'tempWater1x1' }, { anyTerms: ['water'], excludeTerms: ['fall', 'boat', 'well', 'barrel', 'bucket', 'deep'] }], fallback: null },
  deep_water: { q: [{ terms: ['deep', 'water'] }], fallback: 'water' },
  swamp: { q: [{ name: 'Swamp floor 1x1' }, { anyTerms: ['swamp', 'bog', 'marsh'] }], fallback: 'mud' },
  lava: { q: [{ anyTerms: ['lava', 'magma'] }], fallback: 'cave_floor' },
  concrete: { q: [{ group: SCIFI_CITY, anyTerms: ['floor', 'ground', 'concrete', 'pavement', 'sidewalk', 'tile', 'slab'] }, { anyTerms: ['concrete', 'pavement', 'sidewalk', 'cement'] }], maxHeight: 0.75, fallback: 'stone_floor' },
  asphalt: { q: [{ group: 'Street', anyTerms: ['road', 'asphalt', 'street'] }, { anyTerms: ['asphalt', 'road'], excludeTerms: ['sign', 'cone'] }, { group: 'Street' }], maxHeight: 0.75, fallback: 'concrete' },
  metal_floor: { q: [{ group: SCIFI_TECH, anyTerms: ['floor', 'ground', 'plate', 'grate', 'grating', 'deck'] }, { anyTerms: ['metal floor', 'grate', 'grating', 'deck plate', 'steel floor'] }, { group: SCIFI_TECH }], maxHeight: 0.75, fallback: 'concrete' },
  field: { q: [{ anyTerms: ['tilled', 'farmland', 'crop', 'field'] }], big: [{ name: 'Tilled Earth' }, { anyTerms: ['tilled', 'farmland'] }], fallback: 'dirt' },
};

const WALL_BASE = { kind: 'tile', thin: true, minHeight: 1.2, excludeTerms: [...OFF_THEME, 'door', 'arch', 'corner', 'roof', 'half', 'broken', 'stair'] };
const WINDOW_BASE = { kind: 'tile', thin: true, minHeight: 1.2, excludeTerms: [...OFF_THEME, 'door', 'roof', 'corner'] };

const WALL_DEFS = {
  castle: {
    plain: [{ name: 'castle wall 1x1' }, { group: 'wall', tags: ['stone'], excludeTerms: ['window', 'ruin'] }],
    window: [{ name: 'castle wall 1x1 window' }, { group: 'wall', tags: ['stone'], anyTerms: ['window'] }],
    fallback: 'stone',
  },
  stone: {
    plain: [{ group: 'wall', tags: ['stone'], excludeTerms: ['window', 'ruin'] }, { name: 'castle wall 1x1' }, { group: 'wall', anyTerms: ['stone'], excludeTerms: ['window'] }],
    window: [{ group: 'wall', tags: ['stone'], anyTerms: ['window'] }, { name: 'castle wall 1x1 window' }],
    fallback: 'wood',
  },
  wood: {
    plain: [{ name: 'Tavern Wall - Small 01' }, { name: 'Rural Wall 01' }, { group: 'wall', tags: ['wood'], excludeTerms: ['window'] }, { group: 'wall', anyTerms: ['wood', 'wooden', 'tavern', 'rural', 'plank'], excludeTerms: ['window'] }],
    window: [{ group: 'wall', tags: ['wood'], anyTerms: ['window'] }, { group: 'wall', anyTerms: ['tavern', 'rural'], terms: ['window'] }],
    fallback: 'stone',
  },
  plaster: {
    plain: [{ group: 'wall', anyTerms: ['plaster', 'stucco', 'timber', 'tudor', 'village', 'white'], excludeTerms: ['window'] }],
    window: [{ group: 'wall', anyTerms: ['plaster', 'stucco', 'timber', 'tudor', 'village'], terms: ['window'] }],
    fallback: 'wood',
  },
  brick: {
    plain: [{ group: 'wall', anyTerms: ['brick'], excludeTerms: ['window'] }, { group: 'Brick Building', excludeTerms: ['window'] }, { anyTerms: ['brick'], excludeTerms: ['window'] }],
    window: [{ group: 'wall', anyTerms: ['brick'], terms: ['window'] }, { group: 'Brick Building', anyTerms: ['window'] }, { anyTerms: ['brick'], terms: ['window'] }],
    fallback: 'stone',
  },
  concrete: {
    plain: [{ group: ['Concrete Building', 'Construction'], excludeTerms: ['window'] }, { anyTerms: ['concrete', 'cement'], excludeTerms: ['window'] }],
    window: [{ group: ['Concrete Building', 'Construction'], anyTerms: ['window'] }, { anyTerms: ['concrete'], terms: ['window'] }],
    fallback: 'brick',
  },
  metal: {
    plain: [{ group: SCIFI_TECH, excludeTerms: ['window'] }, { anyTerms: ['metal', 'steel', 'hull', 'bulkhead', 'panel'], excludeTerms: ['window', 'fence', 'gate'] }],
    window: [{ group: SCIFI_TECH, anyTerms: ['window'] }, { anyTerms: ['metal', 'steel', 'hull'], terms: ['window'] }],
    fallback: 'concrete',
  },
  industrial: {
    plain: [{ group: ['Industrial', 'Construction'], excludeTerms: ['window'] }, { anyTerms: ['industrial', 'corrugated', 'warehouse', 'factory'], excludeTerms: ['window'] }],
    window: [{ group: ['Industrial', 'Construction'], anyTerms: ['window'] }],
    fallback: 'metal',
  },
  ruined: {
    plain: [{ group: 'wall', anyTerms: ['ruin', 'ruins', 'ruined'], excludeTerms: ['window'] }],
    window: [{ group: 'wall', anyTerms: ['ruin', 'ruins'], terms: ['window'] }],
    fallback: 'castle',
  },
  cave: {
    plain: [{ group: 'wall', anyTerms: ['cave', 'rock', 'cliff'], excludeTerms: ['window'] }],
    window: [],
    fallback: 'stone',
  },
};

const DOOR_BASE = { kind: 'tile', thin: true, minHeight: 1.2, length: 1, excludeTerms: [...OFF_THEME, 'double', 'portcullis', 'gate', 'trap', 'frame'] };
const DOOR_Q = [{ name: 'Door -Peasant' }, { name: 'Door - Fancy' }, { group: 'door' }, { group: 'Doors (Modern)' }, { anyTerms: ['door'] }];
const GATE_Q = [{ name: 'Door - Portcullis' }, { name: 'Door - Metal Gate double' }, { name: 'Door - Portcullis double' }, { anyTerms: ['portcullis', 'gate'] }];
const STAIR_Q = [{ name: 'Castle Ruins Stair' }, { name: 'md_stairs_01' }, { group: 'stairs' }, { group: 'stair' }, { anyTerms: ['stair', 'stairs'], excludeTerms: ['block', 'ladder'] }];
const FLAT_ROOF_Q = [{ name: 'Tavern Roof flat 01' }, { name: 'Thatched roof flat 01' }, { name: 'haunted roof 1x1 flat' }, { group: 'roof', anyTerms: ['flat'] }, { anyTerms: ['roof'], excludeTerms: ['corner', 'edge', 'side', 'inner', 'tip', 'ridge'] }];
const CRENEL_Q = [{ name: 'Castle Ruins Crenellation - Small' }, { anyTerms: ['crenellation', 'battlement', 'merlon'] }];
const POST_Q = [{ anyTerms: ['pillar', 'column', 'post', 'pole'], maxFootprint: 0.75, minHeight: 1.5, excludeTerms: [...OFF_THEME, 'sign', 'lamp', 'lantern', 'fence', 'broken'] }];

// Pitched roof kits. Rotation tables were measured in-game by the citysmith
// project against hand-built community roofs; they are a property of the art.
// Keys are world edges / corners, values rotation steps.
export const ROOF_KITS = [
  { id: 'thatched', side: 'Thatched Roof 01', corner: 'Thatched Roof Corner 01', inner: 'Thatched Roof Inner Corner 01', cap: 'Thatched roof flat 01' },
  { id: 'village', side: 'Village Roof Side 01', corner: 'Village Roof Corner 01', inner: 'Village Roof Inner Corner 01', cap: 'Tavern Roof flat 01' },
  { id: 'slate', side: 'Haunted roof 1x1', corner: 'haunted roof corner out tip', inner: 'haunted roof corner inner tip', cap: 'haunted roof 1x1 flat' },
];
export const ROOF_EDGE_ROT = { zMin: 6, xMax: 0, zMax: 18, xMin: 12 };
export const ROOF_CORNER_ROT = { 'xMin,zMin': 12, 'xMax,zMin': 6, 'xMin,zMax': 18, 'xMax,zMax': 0 };

const PROP_DEFS = {
  tree: { pin: ['Tree 01'], any: ['tree'], ex: ['dead', 'stump', 'stackable', 'top', 'middle', 'fallen', 'log', 'branch', 'trunk', 'root', 'house', 'street'], max: 4.5 },
  conifer: { any: ['pine', 'spruce', 'fir', 'conifer'], ex: ['stackable', 'stump', 'top', 'middle', 'cone', 'log', 'needle'], max: 4.5 },
  dead_tree: { pin: ['Dead Tree 03', 'Dead Tree 02'], all: ['dead', 'tree'], max: 4.5 },
  bush: { any: ['bush', 'shrub', 'hedge'], ex: ['wall'], max: 3 },
  rock: { any: ['rock', 'stone', 'boulder'], ex: ['floor', 'wall', 'stair', 'tile', 'throne', 'path', 'road', 'pillar', 'statue', 'circle', 'bridge', 'grave', 'tomb', 'altar', 'well', 'fence', 'arch'], max: 3 },
  boulder: { any: ['boulder', 'rock'], ex: ['floor', 'wall', 'stair', 'path', 'road', 'small', 'pebble'], max: 4 },
  flowers: { any: ['flower', 'flowers', 'blossom'], max: 2 },
  tall_grass: { any: ['grass', 'reeds', 'reed', 'weeds'], ex: ['floor'], max: 2 },
  log: { any: ['log', 'logs'], ex: ['logo'], max: 4 },
  stump: { any: ['stump'], max: 2 },
  mushroom: { any: ['mushroom', 'mushrooms', 'fungus', 'fungi', 'toadstool'], max: 2 },
  barrel: { any: ['barrel', 'barrels', 'keg'], max: 2 },
  crate: { any: ['crate', 'crates', 'box'], ex: ['sandbox', 'mailbox'], max: 2 },
  sack: { any: ['sack', 'sacks', 'bag', 'grain'], max: 1.5 },
  chest: { any: ['chest'], ex: ['chestnut', 'chest plate'], max: 1.5 },
  table: { any: ['table'], ex: ['tablet', 'vegetable', 'stable', 'portable'], max: 3 },
  chair: { any: ['chair'], ex: ['wheelchair', 'high chair'], max: 1.2 },
  bench: { any: ['bench'], max: 3 },
  stool: { any: ['stool'], max: 1 },
  bed: { any: ['bed'], ex: ['flowerbed', 'riverbed', 'seabed', 'bedrock'], max: 3 },
  bookshelf: { any: ['bookshelf', 'bookcase', 'book shelf', 'books'], max: 3 },
  shelf: { any: ['shelf', 'shelves'], max: 3 },
  cabinet: { any: ['cabinet', 'cupboard', 'dresser', 'wardrobe'], max: 3 },
  desk: { any: ['desk', 'writing'], max: 3 },
  counter: { any: ['counter', 'bar'], ex: ['crowbar', 'barrel', 'bars', 'barbarian', 'barn'], max: 4 },
  fireplace: { any: ['fireplace', 'hearth'], max: 3 },
  oven: { any: ['oven', 'stove', 'kitchen'], max: 3 },
  anvil: { any: ['anvil'], max: 2 },
  forge: { any: ['forge', 'furnace', 'smelter', 'bellows'], max: 3 },
  weapon_rack: { all: ['rack'], any: ['weapon', 'sword', 'spear', 'rack'], max: 3 },
  armor_stand: { any: ['armor', 'armour', 'mannequin'], max: 2 },
  altar: { any: ['altar', 'shrine'], ex: ['evil'], max: 4 },
  statue: { any: ['statue', 'idol', 'bust'], max: 4 },
  pillar: { any: ['pillar', 'column'], ex: ['broken'], max: 2 },
  fountain: { any: ['fountain'], max: 5 },
  well: { pin: ['Well 01'], any: ['well'], ex: ['wellington'], max: 4 },
  cart: { any: ['cart', 'wagon', 'wheelbarrow'], max: 5 },
  boat: { any: ['boat', 'rowboat', 'canoe', 'raft'], max: 8 },
  market_stall: { any: ['stall', 'market', 'stand'], ex: ['armor', 'armour', 'candle', 'torch', 'lamp', 'stand-in'], max: 5 },
  tent: { any: ['tent'], max: 6 },
  campfire: { any: ['campfire', 'fire pit', 'firepit', 'bonfire', 'fire'], ex: ['fireplace', 'firewood', 'fire place'], max: 2.5 },
  brazier: { any: ['brazier'], max: 1.5 },
  torch: { any: ['torch'], max: 1 },
  lantern: { pin: ['Lantern -Small', 'Lantern on hook 01'], any: ['lantern', 'lamp'], max: 1.5 },
  candle: { any: ['candle', 'candles', 'candelabra'], max: 1 },
  chandelier: { any: ['chandelier'], max: 3 },
  banner: { any: ['banner', 'flag', 'tapestry', 'pennant'], max: 3 },
  rug: { any: ['rug', 'carpet', 'mat'], ex: ['mattress'], max: 4 },
  bones: { any: ['bone', 'bones', 'skull', 'skulls'], ex: ['skeleton'], max: 2 },
  skeleton: { any: ['skeleton', 'corpse', 'remains'], max: 2.5 },
  coffin: { any: ['coffin', 'sarcophagus', 'casket'], max: 3 },
  cage: { any: ['cage', 'cell'], max: 3 },
  ladder: { any: ['ladder'], max: 2 },
  crystal: { any: ['crystal', 'crystals', 'gem', 'gems'], max: 2.5 },
  pottery: { any: ['pot', 'pots', 'vase', 'urn', 'jar', 'jug', 'amphora'], ex: ['potion', 'potato', 'spot', 'teapot'], max: 1.2 },
  tankard: { any: ['tankard', 'mug', 'goblet', 'cup', 'bottle'], max: 0.6 },
  food: { any: ['food', 'bread', 'cheese', 'meat', 'fruit', 'plate', 'bowl'], max: 1.5 },
  plant: { any: ['plant', 'potted', 'fern', 'ivy'], ex: ['power plant'], max: 2 },
  tombstone: { any: ['tombstone', 'gravestone', 'grave', 'headstone'], ex: ['digger'], max: 2 },
  sign: { any: ['sign', 'signpost', 'signboard'], max: 2 },
  hay: { any: ['hay', 'haystack', 'straw'], max: 3 },
  trough: { any: ['trough'], max: 3 },
  throne: { any: ['throne'], max: 3 },
  cauldron: { any: ['cauldron'], max: 2 },
  pew: { any: ['pew'], max: 4 },
  training_dummy: { any: ['dummy', 'target'], max: 2 },
  instrument: { any: ['lute', 'harp', 'lyre', 'drum', 'drums', 'fiddle', 'violin', 'flute', 'mandolin', 'bagpipe', 'bagpipes', 'piano', 'organ', 'instrument'], ex: ['eardrum'], max: 2.5 },
  fence: { pin: ['Harbor Fence 02', 'Desert fence low'], any: ['fence'], ex: ['gate'], max: 3 },
  computer: { any: ['computer', 'terminal', 'console', 'monitor', 'screen', 'laptop', 'keyboard', 'server'], ex: ['screenshot'], max: 2.5 },
  locker: { any: ['locker', 'lockers'], max: 2 },
  vending_machine: { any: ['vending', 'soda machine', 'arcade'], max: 2 },
  vehicle: { any: ['car', 'van', 'truck', 'vehicle', 'motorcycle', 'motorbike', 'scooter', 'hovercar', 'bike'], ex: ['cart', 'carpet', 'card', 'carrot', 'scar', 'carved', 'caravan'], max: 6 },
  streetlight: { any: ['streetlight', 'street light', 'lamp post', 'lamppost', 'light pole', 'street lamp'], max: 1.5 },
  dumpster: { any: ['dumpster', 'trash', 'garbage', 'rubbish', 'bin'], ex: ['cabinet', 'robin', 'binoc'], max: 3 },
  machine: { any: ['machine', 'generator', 'engine', 'pump', 'reactor', 'turbine', 'machinery'], max: 4 },
  pipes: { any: ['pipe', 'pipes', 'duct', 'vent'], ex: ['pipeweed', 'bagpipe'], max: 4 },
  other: { any: [], max: 6 },
};

// genre: which half of the library a style draws on (see Kit.genreOk).
export const STYLE_PRESETS = {
  medieval: { genre: 'fantasy', ground: 'grass', path: 'cobblestone', wall: 'wood', floor: 'wood_floor', roof: 'pitched' },
  castle: { genre: 'fantasy', ground: 'grass', path: 'flagstone', wall: 'castle', floor: 'stone_floor', roof: 'flat' },
  tavern: { genre: 'fantasy', ground: 'none', path: 'wood_floor', wall: 'wood', floor: 'wood_floor', roof: 'none' },
  dungeon: { genre: 'fantasy', ground: 'none', path: 'stone_floor', wall: 'stone', floor: 'stone_floor', roof: 'none' },
  cave: { genre: 'fantasy', ground: 'none', path: 'cave_floor', wall: 'cave', floor: 'cave_floor', roof: 'none' },
  ruins: { genre: 'fantasy', ground: 'grass', path: 'flagstone', wall: 'ruined', floor: 'flagstone', roof: 'none' },
  desert: { genre: 'fantasy', ground: 'sand', path: 'gravel', wall: 'plaster', floor: 'tile', roof: 'flat' },
  swamp: { genre: 'fantasy', ground: 'swamp', path: 'plank', wall: 'wood', floor: 'plank', roof: 'pitched' },
  winter: { genre: 'fantasy', ground: 'snow', path: 'cobblestone', wall: 'stone', floor: 'wood_floor', roof: 'pitched' },
  wilderness: { genre: 'fantasy', ground: 'grass', path: 'dirt', wall: 'wood', floor: 'wood_floor', roof: 'pitched' },
  modern: { genre: 'scifi', ground: 'concrete', path: 'asphalt', wall: 'brick', floor: 'concrete', roof: 'flat' },
  cyberpunk: { genre: 'scifi', ground: 'asphalt', path: 'asphalt', wall: 'concrete', floor: 'concrete', roof: 'flat' },
  scifi: { genre: 'scifi', ground: 'none', path: 'metal_floor', wall: 'metal', floor: 'metal_floor', roof: 'flat' },
};
export const STYLES = Object.keys(STYLE_PRESETS);

// ---------------------------------------------------------------------------

export class Kit {
  // overrides: { 'surface:grass': 'Grass 1x1', 'wall:wood': 'Rural Wall 01', 'door': '<guid>', 'prop:barrel': 'Barrel 02', ... }
  constructor(catalog, { style = 'medieval', overrides = {} } = {}) {
    this.catalog = catalog;
    this.style = STYLE_PRESETS[style] ? style : 'medieval';
    this.preset = STYLE_PRESETS[this.style];
    this.genre = this.preset.genre || 'fantasy';
    this.overrides = {};
    for (const [k, v] of Object.entries(overrides || {})) this.overrides[k.toLowerCase()] = v;
    this.cache = new Map();
    this.log = new Map();
  }

  memo(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key);
  }

  record(role, asset, source) {
    this.log.set(role, { role, asset: asset ? asset.name : null, id: asset ? asset.id : null, source });
  }

  // Look up a user override. Accepts a GUID or an exact name; still checks shape.
  override(role, base) {
    const v = this.overrides[role.toLowerCase()];
    if (!v) return null;
    const a = this.catalog.get(v) || this.catalog.byName(v);
    if (!a) return null;
    if (base && !shapeOk(a, base)) return null;
    return a;
  }

  // Fantasy builds never use sci-fi assets. Sci-fi builds prefer their own and
  // fall back to anything (grass, trees and barrels are much the same).
  genreOk(a, strict) {
    if (this.genre === 'fantasy') return a.genre !== 'scifi';
    return !strict || a.genre === this.genre;
  }

  // anyGenre: for an explicit library kit, whose group already decides.
  first(role, queries, base, { anyGenre = false } = {}) {
    const o = this.override(role, base);
    if (o) {
      this.record(role, o, 'override');
      return o;
    }
    const passes = anyGenre ? [null] : this.genre === 'fantasy' ? [true] : [true, false];
    for (const strict of passes) {
      for (const q of queries) {
        const merged = mergeQuery(base, q);
        const hits = this.catalog.find(merged).filter((a) => strict === null || this.genreOk(a, strict));
        if (hits.length) {
          this.record(role, hits[0], q.name ? 'pinned' : 'search');
          return hits[0];
        }
      }
    }
    this.record(role, null, 'missing');
    return null;
  }

  // -> { material, base, big: [{ asset, n }] } or null when nothing (even
  // fallbacks) resolves.
  surface(material) {
    return this.memo(`surface:${material}`, () => {
      if (isKitMaterial(material)) {
        const group = material.slice(KIT_PREFIX.length);
        const base = this.first(`surface:${material}`, [{ group, excludeTerms: ['wall', 'door', 'roof', 'stair', 'corner', 'window', 'pillar', 'column', 'post'] }], { ...SURFACE_BASE, maxHeight: 0.75 }, { anyGenre: true });
        if (base) return { material, base, big: this.bigVariants(base), requested: material };
        const fb = this.surface(this.preset.floor);
        return fb ? { ...fb, requested: material } : null;
      }
      const seen = new Set();
      let m = material;
      while (m && !seen.has(m)) {
        seen.add(m);
        const def = SURFACE_DEFS[m];
        if (!def) break;
        const base = this.first(`surface:${m}`, def.q, def.maxHeight ? { ...SURFACE_BASE, maxHeight: def.maxHeight } : SURFACE_BASE);
        if (base) {
          return { material: m, base, big: this.bigVariants(base), requested: material };
        }
        // Some surfaces only exist as 2x2 blocks (tilled fields): use the block
        // where it fits and the fallback material's 1x1 tile for the fringe.
        if (def.big) {
          const block = this.first(`surface:${m}:2x2`, def.big, { ...SURFACE_BASE, footprint: [2, 2] });
          const fringe = def.fallback ? this.surface(def.fallback) : null;
          if (block && fringe) return { material: m, base: fringe.base, big: [{ asset: block, n: 2 }], requested: material };
        }
        m = def.fallback;
      }
      return null;
    });
  }

  // "castle floor 1x1" -> "castle floor 2x2" when the game has it.
  bigVariants(base) {
    const out = [];
    if (!/1x1/i.test(base.name)) return out;
    for (const n of [3, 2]) {
      const name = base.name.replace(/1x1/i, `${n}x${n}`);
      const a = this.catalog.byName(name, 'tile');
      if (a && Math.abs(a.size.x - n) < 0.05 && Math.abs(a.size.z - n) < 0.05 && Math.abs(a.size.y - base.size.y) < 0.3) out.push({ asset: a, n });
    }
    return out;
  }

  // -> { material, plain1, plain2, window, height, thickness } or null.
  wall(material) {
    return this.memo(`wall:${material}`, () => {
      if (isKitMaterial(material)) {
        const group = material.slice(KIT_PREFIX.length);
        const opt = { anyGenre: true };
        const plain1 = this.first(`wall:${material}`, [{ group, excludeTerms: ['window'] }], { ...WALL_BASE, length: 1 }, opt);
        if (!plain1) {
          const fb = this.wall(this.preset.wall);
          return fb ? { ...fb, requested: material } : null;
        }
        const h = { maxHeight: plain1.size.y + 0.3, minHeight: plain1.size.y - 0.3 };
        return {
          material,
          requested: material,
          plain1,
          plain2: this.first(`wall:${material}:long`, [{ group, excludeTerms: ['window'] }], { ...WALL_BASE, length: 2, ...h }, opt),
          window: this.first(`wall:${material}:window`, [{ group, anyTerms: ['window'] }], { ...WINDOW_BASE, length: 1, ...h }, opt),
          door: this.first(`door:${material}`, [{ group, anyTerms: ['door'] }], { ...DOOR_BASE, ...h }, opt),
          height: plain1.size.y,
          thickness: Math.min(plain1.size.x, plain1.size.z),
        };
      }
      const seen = new Set();
      let m = material;
      while (m && !seen.has(m)) {
        seen.add(m);
        const def = WALL_DEFS[m];
        if (!def) break;
        const plain1 = this.first(`wall:${m}`, def.plain, { ...WALL_BASE, length: 1 });
        if (plain1) {
          const plain2 = this.first(`wall:${m}:long`, def.plain, { ...WALL_BASE, length: 2, maxHeight: plain1.size.y + 0.3, minHeight: plain1.size.y - 0.3 });
          const window = this.first(`wall:${m}:window`, def.window, { ...WINDOW_BASE, length: 1, maxHeight: plain1.size.y + 0.3, minHeight: plain1.size.y - 0.3 });
          return {
            material: m,
            requested: material,
            plain1,
            plain2,
            window,
            height: plain1.size.y,
            thickness: Math.min(plain1.size.x, plain1.size.z),
          };
        }
        m = def.fallback;
      }
      return null;
    });
  }

  // A library kit's own door when it has one; otherwise the style's door.
  door(material) {
    if (material) {
      const w = this.wall(material);
      if (w && w.door) return w.door;
    }
    return this.memo('door', () => this.first('door', DOOR_Q, DOOR_BASE));
  }

  gate() {
    return this.memo('gate', () => this.first('gate', GATE_Q, { kind: 'tile', thin: true, minHeight: 1.2, maxFootprint: 2.05, excludeTerms: OFF_THEME }));
  }

  stairs() {
    return this.memo('stairs', () => this.first('stairs', STAIR_Q, { kind: 'tile', maxFootprint: 2.05, minHeight: 0.5, excludeTerms: OFF_THEME }));
  }

  flatRoof() {
    return this.memo('roof:flat', () => this.first('roof:flat', FLAT_ROOF_Q, { kind: 'tile', footprint: [1, 1], maxHeight: 1.5, excludeTerms: OFF_THEME }));
  }

  crenellation() {
    return this.memo('crenellation', () => this.first('crenellation', CRENEL_Q, { kind: 'tile', thin: true, length: 1, excludeTerms: OFF_THEME }));
  }

  post() {
    return this.memo('post', () => {
      const o = this.override('post');
      if (o) {
        this.record('post', o, 'override');
        return o;
      }
      for (const kind of ['tile', 'prop']) {
        const hits = this.catalog.find({ ...POST_Q[0], kind });
        if (hits.length) {
          this.record('post', hits[0], 'search');
          return hits[0];
        }
      }
      this.record('post', null, 'missing');
      return null;
    });
  }

  // A complete pitched kit (all four pieces, 1x1 footprints) or null.
  roofKit() {
    return this.memo('roof:pitched', () => {
      const o = this.overrides['roof:pitched'];
      const kits = o ? ROOF_KITS.filter((k) => k.id === o) : ROOF_KITS;
      for (const k of kits) {
        const pieces = {};
        let ok = true;
        for (const part of ['side', 'corner', 'inner', 'cap']) {
          const a = this.catalog.byName(k[part], 'tile');
          if (!a || a.size.x > 1.05 || a.size.z > 1.05) {
            ok = false;
            break;
          }
          pieces[part] = a;
        }
        if (ok) {
          for (const part of ['side', 'corner', 'inner', 'cap']) this.record(`roof:pitched:${part}`, pieces[part], 'pinned');
          return { id: k.id, ...pieces, rise: pieces.side.size.y };
        }
      }
      this.record('roof:pitched:side', null, 'missing');
      return null;
    });
  }

  // Candidates for a prop role, best first. A hint (exact asset name from the
  // AI, or free text) is tried before the role's defaults.
  props(role, hint) {
    const key = `prop:${role}:${hint || ''}`;
    return this.memo(key, () => {
      const def = PROP_DEFS[role] || PROP_DEFS.other;
      const out = [];
      const push = (a) => {
        if (a && !out.includes(a) && !a.deprecated && this.genreOk(a, false) && Math.max(a.size.x, a.size.z) <= (def.max || 6) + 1e-6) out.push(a);
      };
      const o = this.override(`prop:${role}`);
      if (o) out.push(o);
      let exact = null;
      if (hint) {
        exact = this.catalog.byName(hint, 'prop') || this.catalog.byName(hint, 'tile');
        if (exact) out.push(exact);
        else for (const a of this.catalog.fuzzy(hint, { kind: 'prop', limit: 3, exclude: OFF_THEME })) push(a);
      }
      for (const name of def.pin || []) push(this.catalog.byName(name, 'prop') || this.catalog.byName(name, 'tile'));
      const terms = def.any || [];
      // the role's word as a whole word of the name or a tag ("street" is not a tree)
      const strong = (a) => {
        const lname = a.name.toLowerCase();
        const words = new Set([...lname.split(/[^a-z0-9]+/), ...a.tags]);
        return [...terms, ...(def.all || [])].some((t) => words.has(t) || words.has(`${t}s`) || (t.includes(' ') && lname.includes(t)));
      };
      if (terms.length || def.all) {
        for (const kind of ['prop', 'tile']) {
          if (kind === 'tile' && out.length) break;
          const hits = this.catalog.find({ kind, anyTerms: terms.length ? terms : undefined, terms: def.all, excludeTerms: [...OFF_THEME, ...(def.ex || [])] });
          // A term in the NAME beats one only in the tags; shorter (plainer) names first.
          const score = (a) => {
            const words = a.name.toLowerCase().split(/[^a-z0-9]+/);
            let s = 0;
            for (const t of [...terms, ...(def.all || [])]) if (words.includes(t) || words.includes(`${t}s`)) s += 2;
            return s - a.name.length / 100;
          };
          // ...and, for sci-fi builds, sci-fi assets that name the role first
          const own = (a) => (this.genre !== 'fantasy' && a.genre === this.genre && strong(a) ? 10 : 0);
          hits.sort((p, q) => own(q) + score(q) - own(p) - score(p));
          for (const a of hits.slice(0, 8)) push(a);
        }
      }
      if (this.genre !== 'fantasy') {
        // own-genre candidates first, after the override and the AI's exact pick
        const head = out.filter((a) => a === o || a === exact);
        const rest = out.filter((a) => a !== o && a !== exact);
        const mine = (a) => a.genre === this.genre && strong(a);
        out.splice(0, out.length, ...head, ...rest.filter(mine), ...rest.filter((a) => !mine(a)));
      }
      this.record(`prop:${role}`, out[0] || null, out[0] ? (o ? 'override' : hint && out[0].name === hint ? 'ai' : 'search') : 'missing');
      return out;
    });
  }

  report() {
    return [...this.log.values()].sort((a, b) => a.role.localeCompare(b.role));
  }
}

function mergeQuery(base, q) {
  if (!base) return q;
  const out = { ...base, ...q };
  if (base.excludeTerms || q.excludeTerms) out.excludeTerms = [...(base.excludeTerms || []), ...(q.excludeTerms || [])];
  return out;
}

function shapeOk(a, base) {
  const q = { ...base };
  delete q.excludeTerms;
  delete q.group;
  delete q.tags;
  // reuse catalog matching for the geometric constraints only
  const sx = a.size.x;
  const sz = a.size.z;
  if (q.kind && a.kind !== q.kind) return false;
  if (q.footprint) {
    const [fx, fz] = q.footprint;
    const near = (p, r) => Math.abs(p - r) <= 0.05;
    if (!((near(sx, fx) && near(sz, fz)) || (near(sx, fz) && near(sz, fx)))) return false;
  }
  if (q.thin && Math.min(sx, sz) > 0.6) return false;
  if (q.length !== undefined && Math.abs(Math.max(sx, sz) - q.length) > 0.05) return false;
  return true;
}

export function isSurface(m) {
  return SURFACES.includes(m);
}

export function describeKitReport(report) {
  return report.map((r) => `${r.role.padEnd(28)} ${r.asset ? `${r.asset} (${r.source})` : '-- not found --'}`).join('\n');
}

