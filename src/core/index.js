// TaleForge public API. Everything here also ships in the Symbiote bundle as
// window.TaleForge.

export {
  SLAB_MAGIC, SLAB_VERSION, MAX_SLAB_BYTES, SlabError, encodeSlab, decodeSlab, encodeSlabBinary, decodeSlabBinary,
  guidToBytes, bytesToGuid, normalizePlacements, slabBounds, cleanSlabText, bytesToBase64, base64ToBytes,
} from './slab.js';
export { Catalog, makeAsset, assetsFromIndexJson, assetsFromContentPacks, inferBoundsScale, readContentPacks, describePackShapes, listOf, assignGenres, tileClass, CATALOG_FORMAT } from './catalog.js';
export { placeCentered, placeInCell, placeOnEdge, placedBounds, rotatedFootprint, edgeRotation, EDGE_ROT, QUARTER } from './geometry.js';
export { Kit, STYLES, STYLE_PRESETS, SURFACES, WALL_MATERIALS, PROP_ROLES, ROOF_KITS, KIT_PREFIX, isKitMaterial, describeKitReport } from './kit.js';
export { PLAN_SCHEMA, PLAN_VERSION, MAX_MAP_TILES, normalizePlan, planStats, planSchema, STRUCTURE_KINDS, ROOM_KINDS } from './plan.js';
export { compilePlan, groupRuns } from './compile.js';
export { chunkPlacements, multiSlabJson, DEFAULT_CHUNK_BUDGET } from './chunk.js';
export { renderPreviewSvg, MATERIAL_COLORS } from './preview.js';
export { buildSlabs, textReport, markerTile, PASTE_HELP } from './build.js';
export { callClaude, collectStream, ClaudeError, DEFAULT_MODEL, compactSchema, SCHEMA_STEPS } from './claude.js';
export { ApiError, readSse, parseJsonText } from './http.js';
export { callOpenAI, collectOpenAIStream, toResponsesInput, OPENAI_DEFAULT_MODEL } from './openai.js';
export { callModel } from './ai.js';
export {
  PROVIDERS, PROVIDER_IDS, PRICES_AS_OF, TYPICAL_BUILD, providerOf, findModel, normalizeUsage, costOf,
  estimateBuildCost, formatCost, modelOptionLabel,
} from './providers.js';
export {
  generatePlan, labelTrace, remapTraceLabels, systemPrompt, buildUserContent, SIZE_PRESETS, traceSchema,
} from './planner.js';
export { traceImage, heuristicLabels, traceToPlan, autoGridSize, resizeRgba, rgbToLab, TRACE_MEANINGS } from './trace.js';
export { decodePng, encodePng, sniffImageType } from './png.js';
export { demoCatalog } from './demo-catalog.js';
export { probePlan, facingProbe } from './probe.js';
export { isZip, zipEntries, zipEntryData, unzip, zip, crc32 } from './zip.js';
export { ModioClient, MODIO_BASE, summarizeMod, slabFromBytes, slabFromText, slabFromBinary, extractSlabs, slabFileHeader, SLAB_FILE_MAGIC, describeSlabFile } from './modio.js';
export { inflateRaw, gunzipAt, zlibAt, lz4BlockAt, lz4FrameAt } from './inflate.js';
export { analyzePrefab, prefabFromSlab, transformPrefab, rotatedSize, rotatedEntrances, rotatedGround, describePrefab } from './prefab.js';
export { planSearches, gatherSlabs, generateCommunityPlan, SEARCH_SCHEMA } from './community.js';
