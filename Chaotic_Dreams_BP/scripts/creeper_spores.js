import { world, system, BlockPermutation } from "@minecraft/server";

system.beforeEvents.startup.subscribe(({ blockComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent("cookiedookie:creeper_spores", {
    beforeOnPlayerPlace: data => {
      data.cancel = !data.block.below().isSolid;
      data.permutationToPlace = data.permutationToPlace.withState("cookiedookie:rotation", (Math.floor(Math.random() * 4) * 90).toString());
    },
    onTick({ block }) {
      if (!block.below().isSolid) { block.setType("minecraft:air"); }
      else {
        const age = block.permutation.getState("cookiedookie:age");
        if (age < 4 || (age >= 4 && (block.above().isAir || block.above().typeId === "minecraft:water"))) {
          if (age < 7) { block.setPermutation(block.permutation.withState("cookiedookie:age", age + 1)); }
          else {
            block.setPermutation(block.permutation.withState("cookiedookie:age", 0));
            block.dimension.spawnEntity("minecraft:creeper", { x: block.location.x + 0.5, y: block.location.y, z: block.location.z + 0.5 }, { initialRotation: 180 - Number(block.permutation.getState("cookiedookie:rotation")) });
          };
          block.dimension.playSound("hit.grass", block.location, { pitch: (Math.random() * 0.2) + 0.8, volume: 1.0 });
        };
      };
    }
  });
});

world.beforeEvents.playerPlaceBlock.subscribe(data => {
  const blockBelow = data.block.below();
  data.cancel = blockBelow.typeId === "cookiedookie:creeper_spores" && blockBelow.permutation.getState("cookiedookie:age") >= 5;
});

world.beforeEvents.explosion.subscribe(({ dimension, source }) => {
  if (source?.typeId === "minecraft:creeper") {
    const location = source.location;
    const radius = source.hasComponent("minecraft:is_charged") ? 7 : 4;
    system.run(() => {
      for (let x = -radius; x <= radius; x++) { for (let y = -radius; y <= radius; y++) { for (let z = -radius; z <= radius; z++) {
        if (Math.pow(x, 2) + Math.pow(y, 2) + Math.pow(z, 2) <= Math.pow(radius, 2)) {
          const block = dimension.getBlock({ x: location.x + x, y: location.y + y, z: location.z + z });
          if (Math.random() < 0.1 && (block.isAir || block.typeId === "minecraft:water") && block.below().isSolid) {
            const microSpores = `spores.${dimension.id}(${block.location.x}, ${block.location.y}, ${block.location.z})`;
            if (world.getDynamicProperty(microSpores) === undefined) {
              world.setDynamicProperty(microSpores, Math.floor(Math.random() * -1100) - 100);
            };
          };
        };
      }}};
    });
  };
});

world.afterEvents.playerBreakBlock.subscribe(({ block }) => { if (block.above().typeId === "cookiedookie:creeper_spores") { block.above().setType("minecraft:air"); }; });
world.afterEvents.blockExplode.subscribe(({ block }) => { if (block.above().typeId === "cookiedookie:creeper_spores") { block.above().setType("minecraft:air"); }; });

system.runInterval(() => {
  const microSporesLocation = world.getDynamicPropertyIds().filter(property => property.startsWith("spores."));
  for (const microSpores of microSporesLocation) {
    const block = world.getDimension(microSpores.split(".")[1].split("(")[0]).getBlock({ x: Number(microSpores.split("(")[1].slice(0, -1).split(",")[0]), y: Number(microSpores.split("(")[1].slice(0, -1).split(",")[1]), z: Number(microSpores.split("(")[1].slice(0, -1).split(",")[2]) });
    if (block !== undefined) {
      if ((block.isAir || block.typeId === "minecraft:water") && block.below().isSolid) {
        const age = world.getDynamicProperty(microSpores);
        if (age < 0) { world.setDynamicProperty(microSpores, age + 1); }
        else {
          world.setDynamicProperty(microSpores, undefined);
          block.setPermutation(BlockPermutation.resolve("cookiedookie:creeper_spores", { "cookiedookie:rotation": (Math.floor(Math.random() * 4) * 90).toString(), "cookiedookie:age": 0 }));
          block.dimension.playSound("hit.grass", block.location, { pitch: (Math.random() * 0.2) + 0.8, volume: 1.0 });
        };
      } else { world.setDynamicProperty(microSpores, undefined); };
    };
  };
});