// ik_tendrils.js
// Bedrock Script API (beta) - IK tendrils from a host entity (default: pig).
// Visuals: particles (optionally also segment entities if you provide a custom segment entity id).
// Features:
// - Multi-target (2-4 players), branching (trunk + child branches)
// - FABRIK IK, smooth organic motion
// - Obstacle avoidance via ray + waypoint steering (goes around blocks instead of straight line)
// - Anchor hit VFX + SFX, cooldown, retract, stop conditions
// - Optional “darkness aggression” + host aura while active

import { world, system } from "@minecraft/server";

const CFG = Object.freeze({
  hostType: "minecraft:pig",
  hostTag: "ik_host",             // add this tag to a pig to make it a tendril caster
  maxTargets: 4,                  // total players attacked simultaneously
  maxBranches: 3,                 // how many extra branches besides trunk (<= maxTargets-1)
  updateEvery: 2,                 // ticks between IK updates (bigger = cheaper + choppier)
  scanHostsEvery: 40,             // ticks between host scans (tagged pigs)
  maxRange: 46,                   // blocks
  loseRange: 54,                  // if target exceeds this, retract
  cooldownTicks: 20 * 6,          // 6s base cooldown
  cooldownJitter: 20 * 2,         // + up to 2s random
  lifeTicks: 20 * 10,             // each tendril life cap
  anchorTicks: 12,                // how long it “sticks” on hit
  retractSpeedMul: 1.25,          // faster retract than extend

  // IK chain
  joints: 14,                     // number of joints per tendril (>= 6)
  segLen: 1.35,                   // joint spacing
  solveIters: 2,                  // FABRIK iterations per update
  smooth: 0.45,                   // 0..1 smoothing factor (higher = more floaty)

  // Motion
  tipSpeed: 0.75,                 // how fast the tip moves toward its steering target
  wander: 0.35,                   // organic offset amplitude
  waypointRadius: 1.6,            // considered reached when within this
  obstacleBypass: 2.4,            // how far sideways it tries to route around a hit
  obstacleUp: 1.1,                // upward bias when routing
  rayMargin: 0.3,                 // stop rays slightly early

  // Terrain hugging (keeps corruption-style “mostly on ground” feel if you want that vibe)
  useGroundHug: true,
  groundProbeEvery: 8,            // ticks
  groundProbeDown: 14,            // blocks scanned downwards
  groundProbeUp: 6,               // start this many blocks above tip

  // Visuals
  particleCore: "flayed:dust_ambient",
  particleSpark: "flayed:dust_core",
  particleAura: "minecraft:portal_reverse_particle",
  particleAnchor: "minecraft:soul_particle",
  auraRate: 2,                    // particles per update while active
  drawEveryJoint: true,
  drawExtraSparks: true,

  // Optional: if you create a custom segment entity with a model, set this to its id.
  // segmentEntityId: "netherlands:tendril_segment",
  segmentEntityId: null,

  // Optional: darker = more aggressive
  darknessAggro: true,
});

const DIM_IDS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];

const ACTIVE_BY_HOST = new Map();   // hostId -> HostState
let nextHostScan = 0;
let nextTendrilId = 1;

const v3 = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  mul: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  nrm: (a) => {
    const m = Math.hypot(a.x, a.y, a.z) || 1;
    return { x: a.x / m, y: a.y / m, z: a.z / m };
  },
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }),
};

function isValid(e) { try { return !!e && e.isValid(); } catch { return false; } }

function tryCmd(dim, cmd) { try { dim.runCommandAsync(cmd); return true; } catch { return false; } }

function spawnParticleSafe(dim, id, p) {
  // Prefer API particle if available; fallback to command
  try { dim.spawnParticle(id, p); return; } catch {}
  tryCmd(dim, `particle ${id} ${p.x} ${p.y} ${p.z}`);
}

function playsoundSafe(dim, name, p, vol = 1, pitch = 1) {
  // Adjust sound id to your pack if you want
  tryCmd(dim, `playsound ${name} @a ${p.x} ${p.y} ${p.z} ${vol} ${pitch}`);
}

function rayHitBlock(dim, from, to) {
  const d = v3.sub(to, from);
  const dist = v3.len(d);
  if (dist < 0.8) return null;
  const dir = v3.mul(v3.nrm(d), 1);
  try {
    const hit = dim.getBlockFromRay(from, dir, {
      maxDistance: Math.max(0.1, dist - CFG.rayMargin),
      includeLiquidBlocks: false,
      includePassableBlocks: false,
    });
    if (hit && hit.block) return hit;
  } catch {}
  return null;
}

function approxDarkness(entity) {
  // Script API still doesn’t give a universal “light level” in all channels consistently.
  // So we approximate: Overworld night = darker; Nether/End = dark.
  if (!CFG.darknessAggro) return 0.0;
  let dimId = "";
  try { dimId = entity.dimension.id; } catch {}
  if (dimId.includes("nether") || dimId.includes("the_end")) return 1.0;
  let t = 0;
  try { t = world.getTimeOfDay(); } catch {}
  // Overworld: roughly night if time is between 13000..23000
  return (t >= 13000 && t <= 23000) ? 1.0 : 0.2;
}

function groundY(dim, at) {
  // Find “air over solid” under a point, cheaply.
  const x = at.x | 0, z = at.z | 0;
  let startY = (at.y | 0) + CFG.groundProbeUp;
  for (let i = 0; i < CFG.groundProbeDown; i++) {
    const y = startY - i;
    let b, below;
    try { b = dim.getBlock({ x, y, z }); below = dim.getBlock({ x, y: y - 1, z }); } catch { continue; }
    if (!b || !below) continue;
    const air = b.typeId === "minecraft:air" || b.typeId === "minecraft:cave_air" || b.typeId === "minecraft:void_air";
    const solidBelow = below.typeId !== "minecraft:air" && below.typeId !== "minecraft:cave_air" && below.typeId !== "minecraft:void_air";
    if (air && solidBelow) return y;
  }
  return (at.y | 0);
}

function initChain(base, joints, segLen) {
  const pts = new Array(joints);
  for (let i = 0; i < joints; i++) pts[i] = { x: base.x, y: base.y, z: base.z };
  // stretch slightly upward to avoid starting inside the host
  for (let i = 1; i < joints; i++) pts[i] = { x: base.x, y: base.y + i * (segLen * 0.35), z: base.z };
  return pts;
}

function solveFABRIK(points, base, tip, segLen, iters) {
  const n = points.length;
  // If unreachable, just point in direction
  const totalLen = segLen * (n - 1);
  const distBT = v3.dist(base, tip);
  if (distBT > totalLen) {
    const dir = v3.nrm(v3.sub(tip, base));
    points[0] = { ...base };
    for (let i = 1; i < n; i++) points[i] = v3.add(points[i - 1], v3.mul(dir, segLen));
    return;
  }

  for (let k = 0; k < iters; k++) {
    // backward
    points[n - 1] = { ...tip };
    for (let i = n - 2; i >= 0; i--) {
      const dir = v3.nrm(v3.sub(points[i], points[i + 1]));
      points[i] = v3.add(points[i + 1], v3.mul(dir, segLen));
    }
    // forward
    points[0] = { ...base };
    for (let i = 1; i < n; i++) {
      const dir = v3.nrm(v3.sub(points[i], points[i - 1]));
      points[i] = v3.add(points[i - 1], v3.mul(dir, segLen));
    }
  }
}

function ensureSegments(dim, tr) {
  if (!CFG.segmentEntityId) return;
  if (tr.segs && tr.segs.length) return;
  tr.segs = [];
  for (let i = 0; i < tr.points.length; i++) {
    try {
      const e = dim.spawnEntity(CFG.segmentEntityId, tr.points[i]);
      if (e && isValid(e)) tr.segs.push(e);
    } catch {}
  }
}

function updateSegments(dim, tr) {
  if (!CFG.segmentEntityId || !tr.segs) return;
  for (let i = 0; i < tr.segs.length; i++) {
    const e = tr.segs[i];
    if (!isValid(e)) continue;
    const p = tr.points[Math.min(i, tr.points.length - 1)];
    const next = tr.points[Math.min(i + 1, tr.points.length - 1)];
    try { e.teleport(p, { facingLocation: next }); } catch {}
  }
}

function killSegments(tr) {
  if (!tr.segs) return;
  for (const e of tr.segs) { try { if (isValid(e)) e.kill(); } catch {} }
  tr.segs.length = 0;
}

function drawTendril(dim, tr) {
  // core line
  if (CFG.drawEveryJoint) {
    for (let i = 0; i < tr.points.length; i++) {
      const p = tr.points[i];
      spawnParticleSafe(dim, CFG.particleCore, p);
      if (CFG.drawExtraSparks && (i % 2 === 0)) spawnParticleSafe(dim, CFG.particleSpark, p);
    }
  } else {
    for (let i = 0; i < tr.points.length; i += 2) {
      const p = tr.points[i];
      spawnParticleSafe(dim, CFG.particleCore, p);
    }
  }
}

function makeBypassWaypoint(dim, from, to) {
  const hit = rayHitBlock(dim, from, to);
  if (!hit) return null;

  const dir = v3.nrm(v3.sub(to, from));
  const up = { x: 0, y: 1, z: 0 };
  let right = v3.cross(dir, up);
  if (v3.len(right) < 0.1) right = { x: 1, y: 0, z: 0 };
  right = v3.nrm(right);

  const c = hit.block.location;
  const center = { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 };
  const side = (Math.random() < 0.5) ? 1 : -1;

  // Try a couple candidates: sideways + up bias
  const candidates = [
    v3.add(center, v3.add(v3.mul(right, CFG.obstacleBypass * side), v3.mul(up, CFG.obstacleUp))),
    v3.add(center, v3.add(v3.mul(right, -CFG.obstacleBypass * side), v3.mul(up, CFG.obstacleUp * 0.6))),
    v3.add(center, v3.mul(up, CFG.obstacleUp * 1.4)),
  ];

  for (const wp of candidates) {
    if (!rayHitBlock(dim, from, wp)) return wp;
  }
  return null;
}

function pickTargets(host) {
  const dim = host.dimension;
  const here = host.location;
  const maxR2 = CFG.maxRange * CFG.maxRange;

  const pls = world.getPlayers();
  const cands = [];
  for (const p of pls) {
    if (!isValid(p)) continue;
    try { if (p.dimension.id !== dim.id) continue; } catch { continue; }
    const l = p.location;
    const dx = l.x - here.x, dz = l.z - here.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > maxR2) continue;
    cands.push({ p, d2 });
  }
  cands.sort((a, b) => a.d2 - b.d2);
  return cands.slice(0, CFG.maxTargets).map(x => x.p);
}

function makeTendril(hostState, target, parentTrunk = null, splitIndex = 0) {
  const host = hostState.host;
  const dim = hostState.dim;

  const base = { x: host.location.x, y: host.location.y + 1.0, z: host.location.z };
  const pts = initChain(base, CFG.joints, CFG.segLen);

  return {
    id: nextTendrilId++,
    hostId: host.id,
    targetId: target.id,
    dimId: dim.id,

    // trunk/branching
    parentId: parentTrunk ? parentTrunk.id : 0,
    splitIndex: splitIndex | 0,

    born: system.currentTick | 0,
    end: (system.currentTick | 0) + CFG.lifeTicks,
    retract: false,
    anchored: 0,

    // steering
    tip: { ...pts[pts.length - 1] },
    vel: { x: 0, y: 0, z: 0 },
    waypoints: [],
    nextGroundProbe: 0,
    lastGroundY: (base.y | 0),

    // IK
    base: base,
    points: pts,
    prev: pts.map(p => ({ ...p })),

    segs: null,
  };
}

function updateTendril(hostState, tr) {
  const host = hostState.host;
  const dim = hostState.dim;

  // Validate host/target
  if (!isValid(host)) return false;

  let target = null;
  for (const p of world.getPlayers()) { if (p.id === tr.targetId) { target = p; break; } }
  if (!isValid(target)) tr.retract = true;

  // Base point (branch uses trunk joint as base)
  if (tr.parentId) {
    const trunk = hostState.tendrils.find(t => t.id === tr.parentId);
    if (trunk && trunk.points && trunk.points[tr.splitIndex]) tr.base = { ...trunk.points[tr.splitIndex] };
    else tr.retract = true;
  } else {
    const hl = host.location;
    tr.base = { x: hl.x, y: hl.y + 1.0, z: hl.z };
  }

  // Stop conditions
  const now = system.currentTick | 0;
  if (now >= tr.end) tr.retract = true;

  let desired = tr.base;
  if (!tr.retract && target) {
    const tl = target.location;
    desired = { x: tl.x, y: tl.y + 1.2, z: tl.z };

    // Range check
    const d = v3.dist(tr.base, desired);
    if (d > CFG.loseRange) tr.retract = true;
  }

  // Waypoint steering around obstacles
  if (!tr.retract && target) {
    const finalGoal = desired;

    // If we’re obstructed, create a bypass waypoint
    if (rayHitBlock(dim, tr.tip, finalGoal)) {
      const wp = makeBypassWaypoint(dim, tr.tip, finalGoal);
      if (wp) tr.waypoints.push(wp);
    }

    // Use current waypoint if present
    if (tr.waypoints.length) {
      const wp0 = tr.waypoints[0];
      if (v3.dist(tr.tip, wp0) <= CFG.waypointRadius) tr.waypoints.shift();
      desired = tr.waypoints.length ? tr.waypoints[0] : finalGoal;
    } else {
      desired = finalGoal;
    }
  }

  // If retracting, head back to base aggressively
  const dark = approxDarkness(host);
  const speedMul = tr.retract ? CFG.retractSpeedMul : 1.0;
  const aggroMul = 1.0 + (CFG.darknessAggro ? (dark * 0.55) : 0.0);

  // Ground hug (optional)
  if (CFG.useGroundHug && !tr.retract) {
    if (now >= tr.nextGroundProbe) {
      tr.nextGroundProbe = now + CFG.groundProbeEvery;
      tr.lastGroundY = groundY(dim, tr.tip);
    }
    // softly pull tip’s y toward ground+1-ish, without killing vertical dodges
    const gy = tr.lastGroundY + 1;
    desired = { x: desired.x, y: desired.y * 0.75 + gy * 0.25, z: desired.z };
  }

  // Organic wander
  const wob = CFG.wander * (0.35 + dark * 0.65);
  const w = Math.sin((now + tr.id * 13) * 0.18) * wob;
  desired = { x: desired.x + w, y: desired.y + Math.cos((now + tr.id * 7) * 0.14) * (wob * 0.6), z: desired.z - w };

  // Tip integration with simple velocity smoothing
  const to = v3.sub(desired, tr.tip);
  const dir = v3.nrm(to);
  const wantVel = v3.mul(dir, CFG.tipSpeed * aggroMul * speedMul);
  tr.vel = v3.lerp(tr.vel, wantVel, 0.35);
  tr.tip = v3.add(tr.tip, tr.vel);

  // If retracting and close enough, finish
  if (tr.retract && v3.dist(tr.tip, tr.base) <= 1.2) {
    killSegments(tr);
    return false;
  }

  // Hit/anchor logic
  if (!tr.retract && target) {
    const tl = target.location;
    const hitPos = { x: tl.x, y: tl.y + 1.0, z: tl.z };
    if (v3.dist(tr.tip, hitPos) <= 1.3) {
      tr.anchored = CFG.anchorTicks;
      tr.retract = true;

      // VFX/SFX + optional slow
      spawnParticleSafe(dim, CFG.particleAnchor, hitPos);
      spawnParticleSafe(dim, CFG.particleAnchor, v3.add(hitPos, { x: 0, y: 0.5, z: 0 }));
      playsoundSafe(dim, "random.anvil_land", hitPos, 0.6, 1.3);
      tryCmd(dim, `effect "${target.name}" slowness 1 2 true`);
    }
  }

  // IK solve: smooth points toward new solution
  const base = tr.base;
  const tip = tr.tip;

  const temp = tr.points.map(p => ({ ...p }));
  solveFABRIK(temp, base, tip, CFG.segLen, CFG.solveIters);

  // Smooth
  for (let i = 0; i < tr.points.length; i++) {
    tr.points[i] = v3.lerp(tr.points[i], temp[i], 1.0 - CFG.smooth);
  }

  // Visuals / segment entities
  ensureSegments(dim, tr);
  updateSegments(dim, tr);
  drawTendril(dim, tr);

  return true;
}

function updateHost(hostState) {
  const host = hostState.host;
  if (!isValid(host)) return false;

  const dim = hostState.dim;
  const now = system.currentTick | 0;

  // Aura while active
  if (hostState.tendrils.length) {
    const hl = host.location;
    for (let i = 0; i < CFG.auraRate; i++) {
      spawnParticleSafe(dim, CFG.particleAura, { x: hl.x + (Math.random() - 0.5) * 1.4, y: hl.y + 1.0 + Math.random() * 0.6, z: hl.z + (Math.random() - 0.5) * 1.4 });
    }
  }

  // Launch logic (cooldown)
  if (now >= hostState.nextCastTick && hostState.tendrils.length === 0) {
    const targets = pickTargets(host);
    if (targets.length) {
      const trunkTarget = targets[0];
      const trunk = makeTendril(hostState, trunkTarget);
      hostState.tendrils.push(trunk);

      // Branches split from trunk mid-chain, each to a different player
      const branchCount = Math.min(CFG.maxBranches, targets.length - 1);
      const splitIndex = Math.max(3, Math.min(CFG.joints - 4, (CFG.joints * 0.45) | 0));
      for (let i = 0; i < branchCount; i++) {
        const t = targets[i + 1];
        hostState.tendrils.push(makeTendril(hostState, t, trunk, splitIndex));
      }

      const jitter = (Math.random() * CFG.cooldownJitter) | 0;
      hostState.nextCastTick = now + CFG.cooldownTicks + jitter;
    } else {
      // If no targets, check again soon without spamming scans
      hostState.nextCastTick = now + 20;
    }
  }

  // Update tendrils
  const alive = [];
  for (const tr of hostState.tendrils) {
    if (updateTendril(hostState, tr)) alive.push(tr);
    else killSegments(tr);
  }
  hostState.tendrils = alive;

  return true;
}

function scanHosts() {
  const now = system.currentTick | 0;
  if (now < nextHostScan) return;
  nextHostScan = now + CFG.scanHostsEvery;

  for (const dimId of DIM_IDS) {
    let dim;
    try { dim = world.getDimension(dimId); } catch { continue; }
    let hosts = [];
    try { hosts = dim.getEntities({ type: CFG.hostType, tags: [CFG.hostTag] }); } catch { continue; }

    for (const h of hosts) {
      if (!isValid(h)) continue;
      if (!ACTIVE_BY_HOST.has(h.id)) {
        ACTIVE_BY_HOST.set(h.id, {
          host: h,
          dim,
          nextCastTick: now + 20,
          tendrils: [],
        });
      } else {
        const st = ACTIVE_BY_HOST.get(h.id);
        st.host = h;
        st.dim = dim;
      }
    }
  }
}

function tick() {
  scanHosts();

  // Update all active hosts (and prune invalid)
  for (const [id, st] of ACTIVE_BY_HOST) {
    if (!updateHost(st)) ACTIVE_BY_HOST.delete(id);
  }
}

system.runInterval(() => {
  const now = system.currentTick | 0;
  if ((now % CFG.updateEvery) !== 0) return;
  tick();
}, 1);

// OPTIONAL helper: you can call this from chat via /scriptevent if you want.
world.afterEvents.chatSend?.subscribe?.((ev) => {
  // quick debug: "ik on" tags nearest pig
  const msg = (ev.message || "").trim().toLowerCase();
  if (msg === "ik on") {
    const p = ev.sender;
    const dim = p.dimension;
    const here = p.location;
    let best = null, bd = 1e18;
    for (const e of dim.getEntities({ type: CFG.hostType })) {
      const d = v3.dist(e.location, here);
      if (d < bd) { bd = d; best = e; }
    }
    if (best && bd < 10) { try { best.addTag(CFG.hostTag); } catch {} }
  }
});
