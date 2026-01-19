// nether_biomePalette.js
// Conversion rules for your corruption "biomes" (crimson/warped/soul/basalt)

export const BIOMES = Object.freeze({
  CRIMSON: 0,
  WARPED: 1,
  SOUL: 2,
  BASALT: 3,
});

// Weighted pick: basalt rarer
const WEIGHT = [
  BIOMES.CRIMSON, BIOMES.CRIMSON,
  BIOMES.WARPED, BIOMES.WARPED,
  BIOMES.SOUL, BIOMES.SOUL,
  BIOMES.BASALT,
];

export function pickBiome() {
  return WEIGHT[(Math.random() * WEIGHT.length) | 0];
}

// small mutation chance so regions blend over time
export function mutateBiome(b) {
  return Math.random() < 0.03 ? pickBiome() : (b | 0);
}

/* ---------------------------------------------------------
   Immunity / safety
--------------------------------------------------------- */

// Keep these blocks untouched so you don't grief critical stuff.
const IMMUNE = new Set([
  "minecraft:bedrock",
  "minecraft:barrier",
  "minecraft:portal",
  "minecraft:end_portal",
  "minecraft:end_portal_frame",
  "minecraft:nether_portal", // some packs use this id
  "minecraft:obsidian",
  "minecraft:crying_obsidian",
  "minecraft:spawner",
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:ender_chest",
  "minecraft:shulker_box",
  "minecraft:command_block",
  "minecraft:chain_command_block",
  "minecraft:repeating_command_block",
  "minecraft:structure_block",
  "minecraft:structure_void",
  "minecraft:jigsaw",
  "minecraft:barrel",
  "minecraft:furnace",
  "minecraft:blast_furnace",
  "minecraft:smoker",
  "minecraft:hopper",
  "minecraft:dispenser",
  "minecraft:dropper",
  "minecraft:brewing_stand",
  "minecraft:enchanting_table",
  "minecraft:respawn_anchor",
  "minecraft:beacon",
  "minecraft:lodestone",
  "minecraft:reinforced_deepslate",
  "minecraft:ancient_debris",
  "minecraft:netherite_block",
]);

/* ---------------------------------------------------------
   Helpers
--------------------------------------------------------- */

const endsWith = (id, suf) => typeof id === "string" && id.endsWith(suf);

const isAir = (id) =>
  id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air";

const isWater = (id) => id === "minecraft:water" || id === "minecraft:flowing_water";

const isLiquid = (id) => isWater(id) || id === "minecraft:lava";

const isStoneLike = (id) =>
  id === "minecraft:stone" ||
  id === "minecraft:cobblestone" ||
  id === "minecraft:stonebrick" ||
  id === "minecraft:stone_bricks" ||
  endsWith(id, "_stone") ||
  endsWith(id, "_deepslate") ||
  endsWith(id, "_tuff") ||
  endsWith(id, "_andesite") ||
  endsWith(id, "_diorite") ||
  endsWith(id, "_granite");

const isDirtLike = (id) =>
  id === "minecraft:dirt" ||
  id === "minecraft:coarse_dirt" ||
  id === "minecraft:podzol" ||
  id === "minecraft:mycelium" ||
  id === "minecraft:grass_block" ||
  id === "minecraft:rooted_dirt" ||
  id === "minecraft:mud" ||
  endsWith(id, "_dirt");

const isSand = (id) => id === "minecraft:sand" || id === "minecraft:red_sand";
const isGravel = (id) => id === "minecraft:gravel";

const isLeaves = (id) => endsWith(id, "_leaves");
const isLog = (id) => endsWith(id, "_log") || endsWith(id, "_wood") || endsWith(id, "_stem") || endsWith(id, "_hyphae");
const isPlanks = (id) => endsWith(id, "_planks");

const isPlant = (id) =>
  id === "minecraft:grass" ||
  id === "minecraft:tallgrass" ||
  id === "minecraft:fern" ||
  id === "minecraft:large_fern" ||
  endsWith(id, "_flower") ||
  endsWith(id, "_sapling") ||
  endsWith(id, "_tulip") ||
  endsWith(id, "_orchid") ||
  endsWith(id, "_daisy") ||
  endsWith(id, "_mushroom");

/* ---------------------------------------------------------
   Biome material selection
--------------------------------------------------------- */

function nyliumFor(b) {
  if (b === BIOMES.WARPED) return "minecraft:warped_nylium";
  if (b === BIOMES.CRIMSON) return "minecraft:crimson_nylium";
  // soul/basalt don't use nylium
  return null;
}

function surfaceSoilFor(b) {
  if (b === BIOMES.SOUL) return "minecraft:soul_soil";
  if (b === BIOMES.BASALT) return "minecraft:basalt";
  return "minecraft:netherrack";
}

function rockFor(b) {
  if (b === BIOMES.BASALT) return "minecraft:basalt";
  if (b === BIOMES.SOUL) return "minecraft:blackstone";
  return "minecraft:netherrack";
}

function stemFor(b) {
  return b === BIOMES.WARPED ? "minecraft:warped_stem" : "minecraft:crimson_stem";
}

function planksFor(b) {
  return b === BIOMES.WARPED ? "minecraft:warped_planks" : "minecraft:crimson_planks";
}

/* ---------------------------------------------------------
   Main conversion API
--------------------------------------------------------- */

/**
 * @param {string} typeId Current block type id
 * @param {number} biome One of BIOMES
 * @param {boolean} surface True if converting a surface/exposed block
 * @returns {string|null} new block type id or null (no change)
 */
export function getConversionTarget(typeId, biome, surface) {
  if (!typeId || IMMUNE.has(typeId)) return null;

  // Don't mess with liquids directly (decorators handle "boil water" if you want)
  if (isLiquid(typeId)) return null;

  const b = biome | 0;

  // Plants/leaves: usually clear them (prevents floating plants on nether blocks)
  if (isPlant(typeId) || isLeaves(typeId)) return "minecraft:air";

  // Overworld topsoil → nylium or nether soil depending on biome
  if (isDirtLike(typeId)) {
    if (surface) {
      const ny = nyliumFor(b);
      return ny ?? surfaceSoilFor(b);
    }
    return surfaceSoilFor(b);
  }

  // Sand/gravel → soul sand / blackstone / basalt-ish
  if (isSand(typeId)) {
    if (b === BIOMES.SOUL) return "minecraft:soul_sand";
    if (b === BIOMES.BASALT) return "minecraft:blackstone";
    return "minecraft:netherrack";
  }
  if (isGravel(typeId)) {
    if (b === BIOMES.BASALT) return "minecraft:basalt";
    return "minecraft:blackstone";
  }

  // Stone-like → biome rock
  if (isStoneLike(typeId)) return rockFor(b);

  // Wood conversion:
  // - Crimson/Warped: swap to stems/planks
  // - Soul/Basalt: petrify into blackstone
  if (isLog(typeId)) {
    if (b === BIOMES.SOUL || b === BIOMES.BASALT) return "minecraft:blackstone";
    return stemFor(b);
  }
  if (isPlanks(typeId)) {
    if (b === BIOMES.SOUL || b === BIOMES.BASALT) return "minecraft:blackstone";
    return planksFor(b);
  }

  // Default: no change
  return null;
}
