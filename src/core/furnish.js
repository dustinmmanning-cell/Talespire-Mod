// What goes in a room. Each rule places one prop role:
//   at:   'wall'   -- against a wall, long side along it
//         'center' -- away from walls
//         'around' -- next to the previously placed 'center' item (chairs at a table)
//   per:  one item per this many floor tiles (scaled by the furnish level)
//   min/max: bounds on the count
// The roles resolve through the kit, so the same rules work with any asset packs.

export const ROOM_FURNITURE = {
  common: [
    { role: 'fireplace', at: 'wall', max: 1 },
    { role: 'table', at: 'center', per: 14, min: 1, max: 3 },
    { role: 'chair', at: 'around', per: 1, max: 4 },
    { role: 'barrel', at: 'wall', per: 20, max: 2 },
    { role: 'chest', at: 'wall', max: 1 },
  ],
  bar: [
    { role: 'counter', at: 'wall', min: 1, max: 2 },
    { role: 'barrel', at: 'wall', per: 10, min: 2, max: 6 },
    { role: 'table', at: 'center', per: 9, min: 1, max: 6 },
    { role: 'stool', at: 'around', per: 1, max: 3 },
    { role: 'fireplace', at: 'wall', max: 1 },
  ],
  kitchen: [
    { role: 'oven', at: 'wall', min: 1, max: 1 },
    { role: 'table', at: 'center', min: 1, max: 1 },
    { role: 'barrel', at: 'wall', per: 8, max: 2 },
    { role: 'sack', at: 'wall', per: 8, max: 3 },
    { role: 'pottery', at: 'wall', per: 8, max: 3 },
    { role: 'shelf', at: 'wall', max: 1 },
  ],
  bedroom: [
    { role: 'bed', at: 'wall', per: 10, min: 1, max: 2 },
    { role: 'chest', at: 'wall', min: 1, max: 1 },
    { role: 'cabinet', at: 'wall', max: 1 },
    { role: 'rug', at: 'center', max: 1 },
    { role: 'candle', at: 'wall', max: 1 },
  ],
  dormitory: [
    { role: 'bed', at: 'wall', per: 4, min: 2, max: 12 },
    { role: 'chest', at: 'wall', per: 8, max: 6 },
  ],
  storage: [
    { role: 'crate', at: 'wall', per: 4, min: 2, max: 12 },
    { role: 'barrel', at: 'wall', per: 5, min: 1, max: 10 },
    { role: 'sack', at: 'wall', per: 6, max: 8 },
  ],
  cellar: [
    { role: 'barrel', at: 'wall', per: 4, min: 2, max: 12 },
    { role: 'crate', at: 'wall', per: 6, max: 8 },
    { role: 'pottery', at: 'wall', per: 10, max: 4 },
  ],
  shop: [
    { role: 'counter', at: 'wall', min: 1, max: 1 },
    { role: 'shelf', at: 'wall', per: 8, min: 1, max: 4 },
    { role: 'crate', at: 'wall', per: 10, max: 3 },
    { role: 'barrel', at: 'wall', per: 12, max: 2 },
    { role: 'market_stall', at: 'center', per: 30, max: 1 },
  ],
  workshop: [
    { role: 'table', at: 'center', per: 10, min: 1, max: 3 },
    { role: 'crate', at: 'wall', per: 8, max: 3 },
    { role: 'shelf', at: 'wall', max: 2 },
  ],
  forge: [
    { role: 'forge', at: 'wall', min: 1, max: 1 },
    { role: 'anvil', at: 'center', min: 1, max: 2 },
    { role: 'weapon_rack', at: 'wall', per: 12, max: 2 },
    { role: 'barrel', at: 'wall', per: 12, max: 2 },
    { role: 'crate', at: 'wall', per: 15, max: 2 },
  ],
  shrine: [
    { role: 'altar', at: 'wall', min: 1, max: 1 },
    { role: 'statue', at: 'wall', max: 2 },
    { role: 'pew', at: 'center', per: 6, max: 10 },
    { role: 'candle', at: 'wall', per: 10, max: 4 },
    { role: 'banner', at: 'wall', max: 2 },
  ],
  chapel: 'shrine',
  library: [
    { role: 'bookshelf', at: 'wall', per: 3, min: 2, max: 16 },
    { role: 'desk', at: 'center', per: 16, min: 1, max: 3 },
    { role: 'chair', at: 'around', per: 1, max: 1 },
    { role: 'candle', at: 'wall', max: 2 },
  ],
  study: [
    { role: 'desk', at: 'center', min: 1, max: 1 },
    { role: 'chair', at: 'around', max: 1 },
    { role: 'bookshelf', at: 'wall', per: 5, min: 1, max: 4 },
    { role: 'chest', at: 'wall', max: 1 },
    { role: 'candle', at: 'wall', max: 1 },
  ],
  throne: [
    { role: 'throne', at: 'wall', min: 1, max: 1 },
    { role: 'rug', at: 'center', max: 1 },
    { role: 'banner', at: 'wall', per: 10, min: 2, max: 6 },
    { role: 'brazier', at: 'wall', per: 14, min: 2, max: 4 },
    { role: 'pillar', at: 'center', per: 20, max: 6 },
  ],
  hall: [
    { role: 'table', at: 'center', per: 12, min: 1, max: 6 },
    { role: 'bench', at: 'around', per: 1, max: 2 },
    { role: 'banner', at: 'wall', per: 14, max: 6 },
    { role: 'fireplace', at: 'wall', max: 1 },
  ],
  dining: 'hall',
  armory: [
    { role: 'weapon_rack', at: 'wall', per: 4, min: 1, max: 8 },
    { role: 'armor_stand', at: 'wall', per: 6, max: 6 },
    { role: 'chest', at: 'wall', max: 2 },
    { role: 'training_dummy', at: 'center', per: 20, max: 2 },
  ],
  barracks: [
    { role: 'bed', at: 'wall', per: 4, min: 2, max: 12 },
    { role: 'chest', at: 'wall', per: 6, max: 6 },
    { role: 'weapon_rack', at: 'wall', max: 1 },
    { role: 'table', at: 'center', per: 20, max: 1 },
  ],
  treasury: [
    { role: 'chest', at: 'wall', per: 4, min: 2, max: 8 },
    { role: 'pottery', at: 'wall', per: 6, max: 4 },
    { role: 'crystal', at: 'center', per: 12, max: 2 },
  ],
  prison: [
    { role: 'cage', at: 'wall', per: 8, max: 4 },
    { role: 'bones', at: 'center', per: 8, max: 4 },
    { role: 'skeleton', at: 'wall', max: 1 },
    { role: 'torch', at: 'wall', per: 12, max: 3 },
  ],
  crypt: [
    { role: 'coffin', at: 'center', per: 6, min: 1, max: 8 },
    { role: 'bones', at: 'wall', per: 8, max: 4 },
    { role: 'candle', at: 'wall', per: 10, max: 3 },
    { role: 'statue', at: 'wall', max: 1 },
  ],
  corridor: [{ role: 'torch', at: 'wall', per: 10, max: 4 }],
  stable: [
    { role: 'hay', at: 'wall', per: 6, min: 1, max: 6 },
    { role: 'trough', at: 'wall', max: 2 },
    { role: 'barrel', at: 'wall', max: 1 },
  ],
  lair: [
    { role: 'bones', at: 'center', per: 5, min: 2, max: 10 },
    { role: 'skeleton', at: 'wall', max: 2 },
    { role: 'chest', at: 'wall', max: 1 },
    { role: 'rock', at: 'wall', per: 12, max: 4 },
  ],
  cavern: [
    { role: 'rock', at: 'wall', per: 8, min: 1, max: 10 },
    { role: 'mushroom', at: 'center', per: 12, max: 6 },
    { role: 'crystal', at: 'wall', per: 16, max: 3 },
  ],
  empty: [],
  other: [
    { role: 'crate', at: 'wall', max: 1 },
    { role: 'barrel', at: 'wall', max: 1 },
  ],
};

// A structure without rooms is furnished as one room of this kind.
export const STRUCTURE_ROOM = {
  house: 'house', cottage: 'house', manor: 'house',
  tavern: 'bar', inn: 'bar', shop: 'shop', smithy: 'forge', temple: 'shrine', chapel: 'shrine',
  tower: 'storage', keep: 'hall', castle: 'hall', barracks: 'barracks', barn: 'stable', stable: 'stable',
  warehouse: 'storage', hall: 'hall', library: 'library', guildhall: 'hall', mill: 'storage',
  ruin: 'lair', dungeon: 'lair', cave: 'cavern', crypt: 'crypt', mine: 'cavern', room: 'other', other: 'other',
};

// A one-room house gets a bit of everything.
ROOM_FURNITURE.house = [
  { role: 'bed', at: 'wall', min: 1, max: 2, per: 16 },
  { role: 'fireplace', at: 'wall', max: 1 },
  { role: 'table', at: 'center', min: 1, max: 1 },
  { role: 'chair', at: 'around', max: 2 },
  { role: 'chest', at: 'wall', max: 1 },
  { role: 'barrel', at: 'wall', per: 20, max: 1 },
];

export const FURNISH_FACTOR = { none: 0, sparse: 0.5, normal: 1, dense: 1.6 };

export function furnitureRules(roomKind) {
  let rules = ROOM_FURNITURE[roomKind];
  if (typeof rules === 'string') rules = ROOM_FURNITURE[rules];
  return rules || ROOM_FURNITURE.other;
}

// How many of a rule's role to place in a room of `area` tiles.
export function ruleCount(rule, area, level) {
  const f = FURNISH_FACTOR[level] ?? 1;
  if (f === 0) return 0;
  const max = rule.max ?? 1;
  const min = Math.min(rule.min || 0, max);
  let n;
  if (rule.per) n = Math.round((area / rule.per) * f);
  else n = f >= 1 ? max : Math.floor(max * f);
  return Math.max(min, Math.min(max, n));
}
