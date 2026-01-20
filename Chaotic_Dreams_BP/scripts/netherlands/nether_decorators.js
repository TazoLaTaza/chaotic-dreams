// nether_decorators.js
import { BIOMES } from "./nether_biomePalette.js";

const N4 = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
const N8 = [...N4, { x: 1, z: 1 }, { x: 1, z: -1 }, { x: -1, z: 1 }, { x: -1, z: -1 }];

const gb = (d, p) => { try { return d.getBlock(p); } catch { return undefined; } };
const setTypeSafe = (b, id) => { try { b?.setType(id); return true; } catch { return false; } };

const isAir = (id) =>
  id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air";

const isWater = (id) => id === "minecraft:water" || id === "minecraft:flowing_water";

// Things we clear if they end up on corrupted ground
const COVER = new Set([
  "minecraft:grass",
  "minecraft:tallgrass",
  "minecraft:fern",
  "minecraft:large_fern",
  "minecraft:dandelion",
  "minecraft:poppy",
  "minecraft:blue_orchid",
  "minecraft:allium",
  "minecraft:azure_bluet",
  "minecraft:red_tulip",
  "minecraft:orange_tulip",
  "minecraft:white_tulip",
  "minecraft:pink_tulip",
  "minecraft:oxeye_daisy",
  "minecraft:brown_mushroom",
  "minecraft:red_mushroom",
  "minecraft:sweet_berry_bush",
  "minecraft:deadbush",
]);

export const DECOR = Object.freeze({
  opsCap: 32,     // hard cap per call, prevents spikes
  boilWater: true,

  // reduce fireChance to limit excessive fire generation
  fireChance: 0.05,
  fungusChance: 0.22,
  rootsChance: 0.18,
  sproutsChance: 0.12,
  vinesChance: 0.08,
});

function doSet(d, x, y, z, blockId, setBlockFn) {
  if (setBlockFn) return !!setBlockFn(d, x, y, z, blockId);
  const b = gb(d, { x, y, z });
  if (!b) return false;
  if (b.typeId === blockId) return false;
  return setTypeSafe(b, blockId);
}

function tryPlace(d, x, y, z, blockId, ops, setBlockFn) {
  if (ops.count >= DECOR.opsCap) return false;
  const ok = doSet(d, x, y, z, blockId, setBlockFn);
  if (ok) ops.count++;
  return ok;
}

function tryPlaceAboveIfAir(d, x, y, z, blockId, ops, setBlockFn) {
  const above = gb(d, { x, y: y + 1, z });
  if (!above || !isAir(above.typeId)) return false;
  return tryPlace(d, x, y + 1, z, blockId, ops, setBlockFn);
}

function fireIdFor(baseId, biome) {
  if (biome === BIOMES.SOUL) return "minecraft:soul_fire";
  if (baseId === "minecraft:soul_sand" || baseId === "minecraft:soul_soil") return "minecraft:soul_fire";
  return "minecraft:fire";
}

function baseLooksHot(id) {
  return id === "minecraft:netherrack" || id === "minecraft:magma" || id === "minecraft:basalt" || id === "minecraft:blackstone";
}

function pickDecorForBiome(biome) {
  switch (biome) {
    case BIOMES.WARPED:
      return { fungus: "minecraft:warped_fungus", roots: "minecraft:warped_roots", sprouts: "minecraft:nether_sprouts", vine: "minecraft:twisting_vines" };
    case BIOMES.CRIMSON:
      return { fungus: "minecraft:crimson_fungus", roots: "minecraft:crimson_roots", sprouts: "minecraft:nether_sprouts", vine: "minecraft:weeping_vines" };
    case BIOMES.SOUL:
      return { fungus: "minecraft:brown_mushroom", roots: "minecraft:nether_sprouts", sprouts: "minecraft:nether_sprouts", vine: null };
    case BIOMES.BASALT:
      return { fungus: "minecraft:brown_mushroom", roots: null, sprouts: null, vine: null };
    default:
      return { fungus: "minecraft:crimson_fungus", roots: "minecraft:crimson_roots", sprouts: "minecraft:nether_sprouts", vine: null };
  }
}

/**
 * Optional setBlockFn lets the manager track changes for instant revert.
 * setBlockFn(d, x, y, z, typeId) => boolean
 */
export function decorateAfterConversion(d, x, y, z, biome, setBlockFn) {
  const ops = { count: 0 };
  const choice = pickDecorForBiome(biome | 0);

  // Optional "boil water"
  if (DECOR.boilWater) {
    for (const o of N8) {
      const b = gb(d, { x: x + o.x, y, z: z + o.z });
      if (b && isWater(b.typeId)) {
        if (tryPlace(d, x + o.x, y, z + o.z, "minecraft:air", ops, setBlockFn)) {
          const base = gb(d, { x: x + o.x, y: y - 1, z: z + o.z });
          if (base && baseLooksHot(base.typeId) && Math.random() < 0.25) {
            tryPlaceAboveIfAir(d, x + o.x, y - 1, z + o.z, "minecraft:fire", ops, setBlockFn);
          }
        }
      }
    }
  }

  const base = gb(d, { x, y, z });
  if (!base) return;

  if (Math.random() < DECOR.fireChance) {
    const fid = fireIdFor(base.typeId, biome | 0);
    tryPlaceAboveIfAir(d, x, y, z, fid, ops, setBlockFn);
  }

  if (choice.fungus && Math.random() < DECOR.fungusChance) {
    tryPlaceAboveIfAir(d, x, y, z, choice.fungus, ops, setBlockFn);
  }
  if (choice.roots && Math.random() < DECOR.rootsChance) {
    tryPlaceAboveIfAir(d, x, y, z, choice.roots, ops, setBlockFn);
  }

  if (choice.sprouts && Math.random() < DECOR.sproutsChance) {
    for (const o of N4) {
      if (ops.count >= DECOR.opsCap) break;
      if (Math.random() < 0.45) {
        const bx = x + o.x, bz = z + o.z;
        const b2 = gb(d, { x: bx, y, z: bz });
        if (!b2) continue;
        const above2 = gb(d, { x: bx, y: y + 1, z: bz });
        if (!above2 || !isAir(above2.typeId)) continue;
        tryPlace(d, bx, y + 1, bz, choice.sprouts, ops, setBlockFn);
      }
    }
  }

  if (choice.vine && Math.random() < DECOR.vinesChance) {
    const o = N4[(Math.random() * N4.length) | 0];
    const bx = x + o.x, bz = z + o.z;
    const above = gb(d, { x: bx, y: y + 2, z: bz });
    const air1 = gb(d, { x: bx, y: y + 1, z: bz });
    if (above && air1 && isAir(above.typeId) && isAir(air1.typeId)) {
      tryPlace(d, bx, y + 1, bz, choice.vine, ops, setBlockFn);
    }
  }
}

export function cleanupSurfaceRing(d, x, y, z, biome, setBlockFn) {
  const ops = { count: 0 };

  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (ops.count >= DECOR.opsCap) return;

      for (const dy of [0, 1, 2]) {
        const b = gb(d, { x: x + dx, y: y + dy, z: z + dz });
        if (!b) continue;

        if (COVER.has(b.typeId)) {
          tryPlace(d, x + dx, y + dy, z + dz, "minecraft:air", ops, setBlockFn);
        }
      }

      if (DECOR.boilWater) {
        const w = gb(d, { x: x + dx, y: y + 1, z: z + dz });
        if (w && isWater(w.typeId)) {
          tryPlace(d, x + dx, y + 1, z + dz, "minecraft:air", ops, setBlockFn);
        }
      }
    }
  }
}
