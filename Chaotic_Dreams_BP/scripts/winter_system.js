import { world, system, BlockPermutation } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";




let CONFIG = {
    
    CLEAR_DURATION_MIN: 90000,      
    CLEAR_DURATION_MAX: 180000,     
    SNOW_DURATION_MIN: 6000,       
    SNOW_DURATION_MAX: 14400,      
    
    
    PARTICLE_ID: "seasonala:snow",
    PARTICLE_SPAWN_INTERVAL: 50,    
    
    
    ACCUMULATION_INTERVAL: 20,     
    ACCUMULATION_RADIUS: 32,       
    ACCUMULATION_CHANCE: 1,        
    MAX_SNOW_LAYERS: 4,            
    
    
    SHOW_CHAT_MESSAGES: false,      
    
    
    SNOW_VALID_BLOCKS: [
        "minecraft:grass_block",
        "minecraft:dirt",
        "minecraft:stone",
        "minecraft:cobblestone",
        "minecraft:sand",
        "minecraft:gravel",
        "minecraft:oak_leaves",
        "minecraft:spruce_leaves",
        "minecraft:birch_leaves",
        "minecraft:jungle_leaves",
        "minecraft:acacia_leaves",
        "minecraft:dark_oak_leaves",
        "minecraft:cherry_leaves",
        "minecraft:mangrove_leaves",
        "minecraft:azalea_leaves",
        "minecraft:azalea_leaves_flowered",
        "minecraft:moss_block",
        "minecraft:podzol",
        "minecraft:mycelium",
        "minecraft:rooted_dirt",
        "minecraft:mud",
        "minecraft:clay",
        "minecraft:terracotta",
        "minecraft:sandstone",
        "minecraft:red_sandstone",
        "minecraft:packed_ice",
        "minecraft:blue_ice",
        "minecraft:snow_block",
        "minecraft:ice"
    ]
};




const SETTINGS_KEY = "snow_settings";

function saveSettings() {
    try {
        const settingsToSave = {
            CLEAR_DURATION_MIN: CONFIG.CLEAR_DURATION_MIN,
            CLEAR_DURATION_MAX: CONFIG.CLEAR_DURATION_MAX,
            SNOW_DURATION_MIN: CONFIG.SNOW_DURATION_MIN,
            SNOW_DURATION_MAX: CONFIG.SNOW_DURATION_MAX,
            PARTICLE_SPAWN_INTERVAL: CONFIG.PARTICLE_SPAWN_INTERVAL,
            ACCUMULATION_INTERVAL: CONFIG.ACCUMULATION_INTERVAL,
            ACCUMULATION_RADIUS: CONFIG.ACCUMULATION_RADIUS,
            ACCUMULATION_CHANCE: CONFIG.ACCUMULATION_CHANCE,
            MAX_SNOW_LAYERS: CONFIG.MAX_SNOW_LAYERS,
            SHOW_CHAT_MESSAGES: CONFIG.SHOW_CHAT_MESSAGES
        };
        world.setDynamicProperty(SETTINGS_KEY, JSON.stringify(settingsToSave));
    } catch (e) {
        console.warn("Failed to save settings:", e);
    }
}

function loadSettings() {
    try {
        const saved = world.getDynamicProperty(SETTINGS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            Object.assign(CONFIG, parsed);
        }
    } catch (e) {
        console.warn("Failed to load settings:", e);
    }
}




let isSnowing = false;
let weatherTimer = 0;
let nextWeatherChange = 0;




function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function ticksToMinutes(ticks) {
    return Math.round(ticks / 1200 * 10) / 10; 
}

function minutesToTicks(minutes) {
    return Math.round(minutes * 1200);
}




async function showSettingsMenu(player) {
    const form = new ModalFormData()
        .title("Snow Settings")
        .slider("Clear Weather Min (minutes)", 1, 30, { step: 1, defaultValue: ticksToMinutes(CONFIG.CLEAR_DURATION_MIN) })
        .slider("Clear Weather Max (minutes)", 1, 60, { step: 1, defaultValue: ticksToMinutes(CONFIG.CLEAR_DURATION_MAX) })
        .slider("Snow Duration Min (minutes)", 1, 30, { step: 1, defaultValue: ticksToMinutes(CONFIG.SNOW_DURATION_MIN) })
        .slider("Snow Duration Max (minutes)", 1, 60, { step: 1, defaultValue: ticksToMinutes(CONFIG.SNOW_DURATION_MAX) })
        .slider("Particle Spawn Rate (ticks)", 1, 40, { step: 1, defaultValue: CONFIG.PARTICLE_SPAWN_INTERVAL })
        .slider("Accumulation Check Rate (ticks)", 10, 200, { step: 10, defaultValue: CONFIG.ACCUMULATION_INTERVAL })
        .slider("Accumulation Radius", 8, 64, { step: 4, defaultValue: CONFIG.ACCUMULATION_RADIUS })
        .slider("Accumulation Chance (%)", 1, 100, { step: 1, defaultValue: Math.round(CONFIG.ACCUMULATION_CHANCE * 100) })
        .slider("Max Snow Layers", 1, 8, { step: 1, defaultValue: CONFIG.MAX_SNOW_LAYERS })
        .toggle("Show Chat Messages", { defaultValue: CONFIG.SHOW_CHAT_MESSAGES });
    
    try {
        const response = await form.show(player);
        
        if (response.canceled) return;
        
        const values = response.formValues;
        
        
        CONFIG.CLEAR_DURATION_MIN = minutesToTicks(values[0]);
        CONFIG.CLEAR_DURATION_MAX = minutesToTicks(values[1]);
        CONFIG.SNOW_DURATION_MIN = minutesToTicks(values[2]);
        CONFIG.SNOW_DURATION_MAX = minutesToTicks(values[3]);
        CONFIG.PARTICLE_SPAWN_INTERVAL = values[4];
        CONFIG.ACCUMULATION_INTERVAL = values[5];
        CONFIG.ACCUMULATION_RADIUS = values[6];
        CONFIG.ACCUMULATION_CHANCE = values[7] / 100;
        CONFIG.MAX_SNOW_LAYERS = values[8];
        CONFIG.SHOW_CHAT_MESSAGES = values[9];
        
        
        saveSettings();
        
    } catch (e) {
    }
}




function updateWeatherCycle() {
    weatherTimer++;
    
    if (weatherTimer >= nextWeatherChange) {
        weatherTimer = 0;
        isSnowing = !isSnowing;
        
        if (isSnowing) {
            
            nextWeatherChange = getRandomInt(CONFIG.SNOW_DURATION_MIN, CONFIG.SNOW_DURATION_MAX);
            
            
            world.getDimension("overworld").runCommand("weather rain");
        } else {
            
            nextWeatherChange = getRandomInt(CONFIG.CLEAR_DURATION_MIN, CONFIG.CLEAR_DURATION_MAX);
            
            
            world.getDimension("overworld").runCommand("weather clear");
        }
    }
}




function spawnSnowParticles() {
    if (!isSnowing) return;
    
    const overworld = world.getDimension("overworld");
    const players = overworld.getPlayers();
    
    for (const player of players) {
        const pos = player.location;
        
        try {
            
            overworld.spawnParticle(CONFIG.PARTICLE_ID, {
                x: pos.x,
                y: pos.y,
                z: pos.z
            });
        } catch (e) {
            
        }
    }
}




function accumulateSnow() {
    if (!isSnowing) return;
    
    const overworld = world.getDimension("overworld");
    const players = overworld.getPlayers();
    
    for (const player of players) {
        const playerPos = player.location;
        
        
        const checksPerPlayer = 10;
        
        for (let i = 0; i < checksPerPlayer; i++) {
            
            const offsetX = getRandomInt(-CONFIG.ACCUMULATION_RADIUS, CONFIG.ACCUMULATION_RADIUS);
            const offsetZ = getRandomInt(-CONFIG.ACCUMULATION_RADIUS, CONFIG.ACCUMULATION_RADIUS);
            
            const checkX = Math.floor(playerPos.x + offsetX);
            const checkZ = Math.floor(playerPos.z + offsetZ);
            
            
            try {
                
                const startY = Math.min(Math.floor(playerPos.y) + 50, 319);
                
                for (let y = startY; y > Math.max(playerPos.y - 30, -64); y--) {
                    const blockPos = { x: checkX, y: y, z: checkZ };
                    const block = overworld.getBlock(blockPos);
                    
                    if (!block) continue;
                    
                    const blockType = block.typeId;
                    
                    
                    if (blockType === "minecraft:air") continue;
                    
                    
                    if (blockType === "minecraft:snow_layer") {
                        
                        if (Math.random() < CONFIG.ACCUMULATION_CHANCE) {
                            addSnowLayer(overworld, block);
                        }
                        break;
                    }
                    
                    
                    const abovePos = { x: checkX, y: y + 1, z: checkZ };
                    const aboveBlock = overworld.getBlock(abovePos);
                    
                    if (aboveBlock && aboveBlock.typeId === "minecraft:air") {
                        if (CONFIG.SNOW_VALID_BLOCKS.includes(blockType)) {
                            if (Math.random() < CONFIG.ACCUMULATION_CHANCE) {
                                placeSnowLayer(overworld, abovePos);
                            }
                        }
                    }
                    break;
                }
            } catch (e) {
                
            }
        }
    }
}

function placeSnowLayer(dimension, position) {
    try {
        const block = dimension.getBlock(position);
        if (block && block.typeId === "minecraft:air") {
            
            block.setType("minecraft:snow_layer");
        }
    } catch (e) {
        
    }
}

function addSnowLayer(dimension, snowBlock) {
    try {
        const permutation = snowBlock.permutation;
        const currentHeight = permutation.getState("height");
        
        if (currentHeight !== undefined && currentHeight < CONFIG.MAX_SNOW_LAYERS - 1) {
            
            const newPermutation = BlockPermutation.resolve("minecraft:snow_layer", {
                height: currentHeight + 1
            });
            snowBlock.setPermutation(newPermutation);
        } else if (currentHeight >= CONFIG.MAX_SNOW_LAYERS - 1) {
            
            snowBlock.setType("minecraft:snow_block");
        }
    } catch (e) {
        
    }
}




let tickCounter = 0;

system.runInterval(() => {
    tickCounter++;
    
    
    updateWeatherCycle();
    
    
    if (tickCounter % CONFIG.PARTICLE_SPAWN_INTERVAL === 0) {
        spawnSnowParticles();
    }
    
    
    if (tickCounter % CONFIG.ACCUMULATION_INTERVAL === 0) {
        accumulateSnow();
    }
    
    
    if (tickCounter > 1000000) {
        tickCounter = 0;
    }
}, 1);




world.afterEvents.worldLoad.subscribe(() => {
    
    loadSettings();
    
    
    nextWeatherChange = getRandomInt(CONFIG.CLEAR_DURATION_MIN, CONFIG.CLEAR_DURATION_MAX);    
    
    if (Math.random() < 0.4) {
        isSnowing = true;
        nextWeatherChange = getRandomInt(CONFIG.SNOW_DURATION_MIN, CONFIG.SNOW_DURATION_MAX);
        world.getDimension("overworld").runCommand("weather rain");
    }
});




system.beforeEvents.startup.subscribe((event) => {
    
    event.customCommandRegistry.registerCommand({
        name: "snow:settings",
        description: "Open snow settings menu",
        permissionLevel: 1, 
    }, (origin) => {
        const sourceEntity = origin.sourceEntity;
        if (sourceEntity) {
            system.run(() => {
                showSettingsMenu(sourceEntity);
            });
        }
    });
    
    
    event.customCommandRegistry.registerCommand({
        name: "snow:startsnow",
        description: "Force start snowfall",
        permissionLevel: 1, 
    }, (origin) => {
        system.run(() => {
            isSnowing = true;
            weatherTimer = 0;
            nextWeatherChange = getRandomInt(CONFIG.SNOW_DURATION_MIN, CONFIG.SNOW_DURATION_MAX);
            world.getDimension("overworld").runCommand("weather rain");
        });
    });
    
    
    event.customCommandRegistry.registerCommand({
        name: "snow:stopsnow",
        description: "Force stop snowfall",
        permissionLevel: 1, 
    }, (origin) => {
        system.run(() => {
            isSnowing = false;
            weatherTimer = 0;
            nextWeatherChange = getRandomInt(CONFIG.CLEAR_DURATION_MIN, CONFIG.CLEAR_DURATION_MAX);
            world.getDimension("overworld").runCommand("weather clear");
        });
    });
    
    
    event.customCommandRegistry.registerCommand({
        name: "snow:status",
        description: "Check current snow weather status",
        permissionLevel: 0, 
    }, (origin) => {
        const sourceEntity = origin.sourceEntity;
        system.run(() => {
            const timeLeft = Math.floor((nextWeatherChange - weatherTimer) / 20);
            const status = isSnowing ? "§bSnowing" : "§eClear";
            
        });
    });
});
