// nether_mobGen.js
import { world } from "@minecraft/server";

const WISP_ID = "netherlands:wisp"; // <-- set to your actual custom entity id
const TAG_WISP = "nc_wisp";
const TAG_PID = "nc_pid:";

// caps
const MAX_WISPS_PER_PORTAL = 3;
const MAX_ENTITIES_NEAR_PORTAL = 14;   // total entities cap near portal center
const PORTAL_RADIUS = 28;

// spawn pacing
const WISP_CHECK_EVERY = 25; // ticks
const MOB_CHECK_EVERY = 20;  // ticks

// spread-point memory (used to spawn mobs near the “front”)
const POINTS = [];
const POINT_CAP = 96;
const LAST_POINT = new Map();

const gb = (d, p) => { try { return d.getBlock(p); } catch { return undefined; } };

const isAir = (id) =>
  id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air";

const ri = (a, b) => a + ((Math.random() * (b - a + 1)) | 0);

function getDimSafe(dimId) {
  try { return world.getDimension(dimId); } catch { return undefined; }
}

function lastPointKey(pid, dimId) {
  return `${pid}|${dimId}`;
}

function lastPointFor(pid, dimId) {
  return LAST_POINT.get(lastPointKey(pid, dimId)) ?? null;
}

export function recordSpreadPoint(dimId, x, y, z, bio, pid) {
  const point = { dimId, x, y, z, bio: bio | 0, pid, t: Date.now() };
  POINTS.push(point);
  LAST_POINT.set(lastPointKey(pid, dimId), point);
  if (POINTS.length > POINT_CAP) POINTS.splice(0, POINTS.length - POINT_CAP);
}

// pick a reasonable spawn position near a center
function findSpawn(d, gx, gy, gz) {
  const R = 18;
  const x = (gx | 0) + ri(-R, R);
  const z = (gz | 0) + ri(-R, R);

  // search downward for air with solid below
  for (let y = (gy | 0) + 10, i = 0; i < 18; i++, y--) {
    const b = gb(d, { x, y, z });
    const below = gb(d, { x, y: y - 1, z });
    if (b && below && isAir(b.typeId) && !isAir(below.typeId)) {
      return { x: x + 0.5, y: y, z: z + 0.5 };
    }
  }

  // fallback
  return { x: (gx | 0) + 0.5, y: (gy | 0) + 2, z: (gz | 0) + 0.5 };
}

function mobFor(bio) {
  const r = Math.random();
  switch (bio | 0) {
    case 0: // crimson
      return r < 0.40 ? "minecraft:piglin"
        : r < 0.65 ? "minecraft:hoglin"
        : r < 0.88 ? "minecraft:zombified_piglin"
        : "minecraft:magma_cube";
    case 1: // warped
      return r < 0.55 ? "minecraft:enderman"
        : r < 0.80 ? "minecraft:piglin"
        : r < 0.95 ? "minecraft:zombified_piglin"
        : "minecraft:magma_cube";
    case 2: // soul
      return r < 0.55 ? "minecraft:wither_skeleton"
        : r < 0.80 ? "minecraft:ghast"
        : r < 0.93 ? "minecraft:zombified_piglin"
        : "minecraft:magma_cube";
    case 3: // basalt
      return r < 0.55 ? "minecraft:magma_cube"
        : r < 0.80 ? "minecraft:piglin"
        : r < 0.93 ? "minecraft:piglin_brute"
        : "minecraft:ghast";
    default:
      return "minecraft:zombified_piglin";
  }
}

function countEntitiesNear(d, center, maxDistance) {
  try {
    return d.getEntities({ location: center, maxDistance }).length;
  } catch {
    return 0;
  }
}

function countWispsNear(d, center, pid) {
  const pidTag = TAG_PID + pid;
  try {
    return d.getEntities({
      location: center,
      maxDistance: PORTAL_RADIUS,
      tags: [TAG_WISP, pidTag],
    }).length;
  } catch {
    return 0;
  }
}

function spawnWispNearPortal(d, portal, log) {
  const pid = portal.pid;
  const center = { x: portal.cx + 0.5, y: portal.cy + 0.5, z: portal.cz + 0.5 };

  // total entity pressure cap
  if (countEntitiesNear(d, center, PORTAL_RADIUS) > MAX_ENTITIES_NEAR_PORTAL) return;

  const wCount = countWispsNear(d, center, pid);
  if (wCount >= MAX_WISPS_PER_PORTAL) return;

  // spawn chance scales down as wisps increase
  const chance = 0.50 * (1 - wCount / MAX_WISPS_PER_PORTAL);
  if (Math.random() > chance) return;

  const pidTag = TAG_PID + pid;
  try {
    const e = d.spawnEntity(WISP_ID, findSpawn(d, portal.gx, portal.gy, portal.gz));
    try { e.addTag(TAG_WISP); e.addTag(pidTag); } catch {}
  } catch {
    log?.("Failed to spawn wisp:", WISP_ID);
  }
}

function spawnMobNearFront(d, portal) {
  const center = { x: portal.cx + 0.5, y: portal.cy + 0.5, z: portal.cz + 0.5 };

  if (countEntitiesNear(d, center, PORTAL_RADIUS) > MAX_ENTITIES_NEAR_PORTAL) return;

  // prefer last spread point, else portal center
  const pt = lastPointFor(portal.pid, portal.dimId);
  const s = pt ? findSpawn(d, pt.x, pt.y, pt.z) : findSpawn(d, portal.gx, portal.gy, portal.gz);

  // don’t spawn every time
  if (Math.random() > 0.55) return;

  try {
    d.spawnEntity(mobFor(portal.bio | 0), s);
  } catch {
    // ignore spawn failures (unloaded chunk, invalid entity, etc.)
  }
}

/**
 * Called every tick by the manager.
 * @param {number} t system.currentTick
 * @param {Array} portals array of portal records from the manager
 * @param {boolean} enabled
 * @param {(…args:any[])=>void} log
 */
export function tickCorruptionSpawns(t, portals, enabled, log) {
  if (!enabled) return;
  if (!portals || portals.length === 0) return;

  // sample a few portals per tick instead of all (scales better)
  const sample = Math.min(3, portals.length);

  for (let i = 0; i < sample; i++) {
    const p = portals[(ri(0, portals.length - 1))];

    const d = getDimSafe(p.dimId);
    if (!d) continue;

    // update cached “guide” position (where corruption is currently spreading)
    const pt = lastPointFor(p.pid, p.dimId);
    if (pt) { p.gx = pt.x | 0; p.gy = pt.y | 0; p.gz = pt.z | 0; }

    if (t % WISP_CHECK_EVERY === 0) spawnWispNearPortal(d, p, log);
    if (t % MOB_CHECK_EVERY === 0) spawnMobNearFront(d, p);
  }
}
