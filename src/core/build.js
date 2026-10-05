// One call from plan to everything a user needs: slabs, preview, report.

import { compilePlan } from './compile.js';
import { chunkPlacements, multiSlabJson, DEFAULT_CHUNK_BUDGET } from './chunk.js';
import { renderPreviewSvg } from './preview.js';
import { describeKitReport } from './kit.js';
import { planStats } from './plan.js';
import { npcLine } from './npcs.js';

// A plain 1x1 tile to use as a registration marker.
export function markerTile(kit) {
  for (const m of ['stone_floor', 'dirt', 'grass', 'wood_floor', 'cobblestone', 'gravel']) {
    const r = kit.surface(m);
    if (r) return r.base;
  }
  return kit.catalog.find({ kind: 'tile', footprint: [1, 1] })[0] || null;
}

// -> compile result + { chunks, registered, multiSlab, svg }
// prefabs: community slabs the plan places, ref -> analyzed prefab (prefab.js).
export async function buildSlabs(plan, kit, { seed, maxBytes = DEFAULT_CHUNK_BUDGET, multiSlab = true, furnitureFacing, previewScale, prefabs } = {}) {
  const result = compilePlan(plan, kit, { seed, furnitureFacing, prefabs });
  if (result.placements.length === 0) throw new Error('The plan produced nothing to place. Is the asset catalog loaded?');
  const assetOf = (id) => kit.catalog.get(id);
  const vanilla = await chunkPlacements(result.placements, {
    maxBytes, register: true, markerAsset: markerTile(kit), gridHeight: result.plan.height, assetOf,
  });
  let multi = null;
  if (multiSlab && vanilla.chunks.length > 1) {
    const m = await chunkPlacements(result.placements, { maxBytes, register: false, gridHeight: result.plan.height, assetOf });
    multi = multiSlabJson(m.chunks);
  }
  const scale = previewScale || Math.max(6, Math.min(24, Math.floor(1100 / Math.max(result.plan.width, result.plan.height))));
  const svg = renderPreviewSvg(result, { scale, chunks: vanilla.chunks.length > 1 ? vanilla.chunks : null });
  return { ...result, chunks: vanilla.chunks, registered: vanilla.registered, multiSlab: multi, svg };
}

export const PASTE_HELP = {
  single: [
    'In TaleSpire, open a board in build mode (GM).',
    'Copy the slab text, then press Ctrl+V: the build appears in your hand at the cursor.',
    'Hold the left mouse button briefly to place it. Right-click to empty your hand.',
  ],
  multi: [
    'This build is split into several slabs (TaleSpire limits one slab to 30 KB).',
    'Every part carries the same two marker tiles outside opposite corners, so the parts line up when each is placed at the SAME spot.',
    'Point the camera straight down and do not move it. Paste part 1 (Ctrl+V), place it with a short left-press hold, right-click to empty your hand.',
    'Paste each remaining part and place it on exactly the same grid cell.',
    'Delete the stacked marker tiles at the two corners afterwards.',
    'With LordAshes\' MultiPasteSlabsPlugin (BepInEx) you can instead paste the .multislab file in one go.',
  ],
};

export function textReport(build) {
  const lines = [];
  const p = build.plan;
  lines.push(`# ${p.title}`, '');
  if (p.summary) lines.push(p.summary, '');
  const s = planStats(p);
  lines.push(`Map ${s.size} tiles (${p.width * 5} x ${p.height * 5} ft), style ${p.style}: ${s.structures} structures, ${s.rooms} rooms, ${s.props} props, ${s.scatter} scatter areas.`);
  lines.push(`Assets: ${build.stats.total} (${build.stats.tiles} tiles, ${build.stats.props} props, ${build.stats.distinctAssets} distinct).`);
  lines.push(`Slabs: ${build.chunks.length} (${build.chunks.map((c) => `${c.compressedBytes} B`).join(', ')}).`, '');
  if (p.notes) lines.push('## GM notes', p.notes, '');
  if (p.npcs && p.npcs.length) {
    lines.push('## NPCs', 'Numbers match the markers on the preview. Place their minis from the TaleForge Symbiote (Result > GM notes > Place).', '', ...p.npcs.map(npcLine), '');
    if (p.npcNotes) lines.push(p.npcNotes, '');
  }
  lines.push('## How to paste', ...(build.chunks.length > 1 ? PASTE_HELP.multi : PASTE_HELP.single).map((l, i) => `${i + 1}. ${l}`), '');
  if (build.credits && build.credits.length) {
    lines.push('## Community slabs', 'From mod.io. They belong to their creators: fine for your games, but don\'t republish them as your own.');
    lines.push(...build.credits.map((c) => `- ${c.name}${c.creator ? ` by ${c.creator}` : ''}${c.url ? ` (${c.url})` : ''}`), '');
  }
  if (build.warnings.length) lines.push('## Warnings', ...build.warnings.map((w) => `- ${w}`), '');
  lines.push('## Assets used for each role', describeKitReport(build.kitReport));
  return lines.join('\n');
}
