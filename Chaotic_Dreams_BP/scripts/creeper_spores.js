import { world, system, BlockPermutation } from "@minecraft/server";

const ROTATIONS = ["0", "90", "180", "270"];
const SPORES_PREFIX = "spores.";
const SOUND_ID = "hit.grass";
const SOUND_OPTIONS = { volume: 1.0 };
const AIR_ID = "minecraft:air";
const WATER_ID = "minecraft:water";

const isAirOrWater = (block) => block.isAir || block.typeId === WATER_ID;
const randomRotation = () => ROTATIONS[(Math.random() * ROTATIONS.length) | 0];

const parseMicroSporesKey = (key) => {
  if (!key.startsWith(SPORES_PREFIX)) return null;
  const dimStart = SPORES_PREFIX.length;
  const dimEnd = key.indexOf("(", dimStart);
  const coordsEnd = key.lastIndexOf(")");
  if (dimEnd === -1 || coordsEnd === -1) return null;
  const dimId = key.slice(dimStart, dimEnd);
  const coords = key
    .slice(dimEnd + 1, coordsEnd)
    .split(",")
    .map((value) => Number(value.trim()));
  if (coords.length !== 3 || coords.some((value) => Number.isNaN(value))) return null;
  return { dimId, x: coords[0], y: coords[1], z: coords[2] };
};

system.beforeEvents.startup.subscribe(({ blockComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent("cookiedookie:creeper_spores", {
    beforeOnPlayerPlace: (data) => {
      const below = data.block.below();
      data.cancel = !below.isSolid;
      data.permutationToPlace = data.permutationToPlace.withState(
        "cookiedookie:rotation",
        randomRotation(),
      );
    },
    onTick({ block }) {
      const below = block.below();
      if (!below.isSolid) {
        block.setType(AIR_ID);
        return;
      }

      const perm = block.permutation;
      const age = perm.getState("cookiedookie:age");
      if (age >= 4) {
        const above = block.above();
        if (!isAirOrWater(above)) return;
      }

      if (age < 7) {
        block.setPermutation(perm.withState("cookiedookie:age", age + 1));
      } else {
        block.setPermutation(perm.withState("cookiedookie:age", 0));
        const loc = block.location;
        block.dimension.spawnEntity(
          "minecraft:creeper",
          { x: loc.x + 0.5, y: loc.y, z: loc.z + 0.5 },
          { initialRotation: 180 - Number(perm.getState("cookiedookie:rotation")) },
        );
      }

      block.dimension.playSound(SOUND_ID, block.location, {
        ...SOUND_OPTIONS,
        pitch: (Math.random() * 0.2) + 0.8,
      });
    },
  });
});

world.beforeEvents.playerPlaceBlock.subscribe((data) => {
  const blockBelow = data.block.below();
  data.cancel =
    blockBelow.typeId === "cookiedookie:creeper_spores" &&
    blockBelow.permutation.getState("cookiedookie:age") >= 5;
});

world.beforeEvents.explosion.subscribe(({ dimension, source }) => {
  if (source?.typeId !== "minecraft:creeper") return;
  const location = source.location;
  const radius = source.hasComponent("minecraft:is_charged") ? 7 : 4;
  const radiusSq = radius * radius;
  system.run(() => {
    for (let x = -radius; x <= radius; x++) {
      const xsq = x * x;
      for (let y = -radius; y <= radius; y++) {
        const xysq = xsq + y * y;
        if (xysq > radiusSq) continue;
        for (let z = -radius; z <= radius; z++) {
          if (xysq + z * z > radiusSq) continue;
          const block = dimension.getBlock({
            x: location.x + x,
            y: location.y + y,
            z: location.z + z,
          });
          if (Math.random() < 0.1 && isAirOrWater(block) && block.below().isSolid) {
            const blockLoc = block.location;
            const microSpores = `${SPORES_PREFIX}${dimension.id}(${blockLoc.x}, ${blockLoc.y}, ${blockLoc.z})`;
            if (world.getDynamicProperty(microSpores) === undefined) {
              world.setDynamicProperty(microSpores, (Math.random() * -1100 - 100) | 0);
            }
          }
        }
      }
    }
  });
});

const clearAboveSpores = ({ block }) => {
  const above = block.above();
  if (above.typeId === "cookiedookie:creeper_spores") above.setType(AIR_ID);
};
world.afterEvents.playerBreakBlock.subscribe(clearAboveSpores);
world.afterEvents.blockExplode.subscribe(clearAboveSpores);

system.runInterval(() => {
  const microSporesLocation = world
    .getDynamicPropertyIds()
    .filter((property) => property.startsWith(SPORES_PREFIX));
  for (const microSpores of microSporesLocation) {
    const parsed = parseMicroSporesKey(microSpores);
    if (!parsed) {
      world.setDynamicProperty(microSpores, undefined);
      continue;
    }
    const block = world
      .getDimension(parsed.dimId)
      .getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
    if (!block) continue;
    if (isAirOrWater(block) && block.below().isSolid) {
      const age = world.getDynamicProperty(microSpores);
      if (age < 0) {
        world.setDynamicProperty(microSpores, age + 1);
      } else {
        world.setDynamicProperty(microSpores, undefined);
        block.setPermutation(
          BlockPermutation.resolve("cookiedookie:creeper_spores", {
            "cookiedookie:rotation": randomRotation(),
            "cookiedookie:age": 0,
          }),
        );
        block.dimension.playSound(SOUND_ID, block.location, {
          ...SOUND_OPTIONS,
          pitch: (Math.random() * 0.2) + 0.8,
        });
      }
    } else {
      world.setDynamicProperty(microSpores, undefined);
    }
  }
});
