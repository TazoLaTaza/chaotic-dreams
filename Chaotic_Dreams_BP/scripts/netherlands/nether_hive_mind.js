import { world, system, GameMode } from "@minecraft/server";
import "./customComponents/fragileObsidianDecay.js";
import { isRelightPaused } from "./nether_portalLives.js";

/* Hive Mind tendrils (rewritten)
   The hive mind spawns tendrils of fragile obsidian that seek out players and mobs once the corruption has reached
   a sufficient size and the portal has lost multiple lives. Each hive entity controls its own set of tendrils which
   periodically grow towards targets and inflict damage. Tendrils spawn only when the portal's anger (lives lost)
   is at least 2 and repeat every 30 seconds. All work pauses when the portal is broken and awaiting manual relight.
*/

const HM = Object.freeze({
  enabled: true,
  typeHive: "netherlands:hive_mind",
  typeAtlas: "netherlands:portal_atlas",
  tagPortal: "nc_portal",
  tagAnger: "nc_anger:",
  tagR: "nc_r:",
  block: "netherlands:fragile_obsidian",
  minRadius: 3,
  stepEvery: 3,
  placeCap: 60,
  removeCap: 46,
  maxPlaced: 5200,
  damage: 3,
  damageEvery: 12,
  maxTendrils: 3,
  waveEvery: 600, // 30 seconds between waves
  lifeTicks: 700, // each tendril lives for ~35 seconds
  thickAt: 55,
  thickSmall: 2,
  thickBig: 3,
  targetRange: 96,
  targetsEvery: 10,
  maxTargets: 48,
  staggerSpawn: 6,
  staggerEnd: 18,
  scanEvery: 90,
  scanDims: ["minecraft:overworld"]
});

const AIR = new Set(["minecraft:air","minecraft:cave_air","minecraft:void_air"]);
const key = (x,y,z) => x + "|" + y + "|" + z;
const parse = k => { const [a,b,c] = k.split("|"); return { x: a|0, y: b|0, z: c|0 }; };
const clamp = (v,a,b) => v < a ? a : v > b ? b : v;
const sgn = v => v > 0 ? 1 : v < 0 ? -1 : 0;
const gb = (d,p) => { try { return d.getBlock(p); } catch {} };

function getIntTag(e,prefix,def){ try{ for(const t of e.getTags()) if(t?.startsWith(prefix)) return (parseInt(t.slice(prefix.length),10)|0); } catch{} return def|0; }
function nearestAtlas(d,loc,range){ let best = null, bd = 1e18; let arr = []; try { arr = d.getEntities({ type: HM.typeAtlas, tags: [HM.tagPortal], location: loc, maxDistance: range }) ?? []; } catch{} for(const e of arr){ const l = e.location; const dx = l.x - loc.x, dz = l.z - loc.z; const dd = dx*dx + dz*dz; if(dd < bd){ bd = dd; best = e; } } return best; }

// choose the nearest target within range that isn't already selected
function pickTarget(cands, used, dimId, cx, cz, r, hx, hy, hz){
  let best = null, bd = 1e18;
  const rr = r * r;
  for(const e of cands){ if(!e) continue; try{ if(e.dimension.id !== dimId) continue; } catch{ continue; }
    if(used && used.has(e.id)) continue;
    const l = e.location; const dx = l.x - cx, dz = l.z - cz;
    if((dx*dx + dz*dz) > rr) continue;
    const dd = (l.x - hx) * (l.x - hx) + (l.y - hy) * (l.y - hy) + (l.z - hz) * (l.z - hz);
    if(dd < bd){ bd = dd; best = e; }
  }
  if(best && used) used.add(best.id);
  return best;
}

const ACTIVE = new Map();

function placeBlob(d,tr,x,y,z,thick,cx,cz,rr){ const off = []; if(thick>=3){ for(let dx=-1; dx<=1; dx++) for(let dz=-1; dz<=1; dz++) off.push({dx,dz,dy:0}); off.push({dx:0,dz:0,dy:1},{dx:0,dz:0,dy:-1}); } else { off.push({dx:0,dz:0,dy:0},{dx:1,dz:0,dy:0},{dx:-1,dz:0,dy:0},{dx:0,dz:1,dy:0},{dx:0,dz:-1,dy:0},{dx:0,dz:0,dy:1},{dx:0,dz:0,dy:-1}); }
  for(const o of off){ if(tr.placeBudget<=0) break; const px = x + o.dx, py = y + o.dy, pz = z + o.dz; if(py < 1 || py > 318) continue; const dx = px - cx, dz = pz - cz; if((dx*dx+dz*dz) > rr) continue; const b = gb(d,{x:px,y:py,z:pz}); if(!b) continue; const id = b.typeId; if(id === "minecraft:bedrock" || id === "minecraft:portal") continue; try { b.setType(HM.block); } catch { continue; }
    const k = key(px,py,pz); if(!tr.set.has(k)){ tr.set.add(k); tr.list.push(k); if(tr.list.length > HM.maxPlaced) tr.over = true; }
    tr.placeBudget--; }
}

function desiredTendrils(anger){ if(anger < 2) return 0; return clamp(anger,2,HM.maxTendrils); }

function spawnWave(st,t){ const anger = getIntTag(st.atlas,HM.tagAnger,0); if(anger < 2) return; const n = desiredTendrils(anger); if(!n) return; const r = getIntTag(st.atlas,HM.tagR,0); if(r < HM.minRadius) return; const thick = r < HM.thickAt ? HM.thickSmall : HM.thickBig; const rr = r * r; // ensure there are n tendrils
  while(st.tendrils.length < n){ st.tendrils.push({ hx: st.atlas.location.x|0, hy: st.atlas.location.y|0, hz: st.atlas.location.z|0, set: new Set(), list: [], rm: 0, dmg: 0, over: false, placeBudget: 10, end: t + HM.lifeTicks + (st.tendrils.length * HM.staggerEnd), dead: false }); }
  st.nextWave = t + HM.waveEvery;
  // initial placement for tendrils that haven't placed yet
  for(const tr of st.tendrils){ if(tr.set.size > 0) continue; placeBlob(st.dim,tr,tr.hx,tr.hy,tr.hz,thick,(st.atlas.location.x|0),(st.atlas.location.z|0),rr); }
}

function spawnForHive(e){ if(!HM.enabled || !e) return; let d; try { d = e.dimension; } catch { return; } const atlas = nearestAtlas(d,e.location,256); if(!atlas) return; const anger = getIntTag(atlas,HM.tagAnger,0); if(anger < 2) return; const r = getIntTag(atlas,HM.tagR,0); if(r < HM.minRadius) return; const st = { id: e.id, e, dim: d, dimId: d.id, atlas, center: atlas.location, r, anger, nextWave: 0, tendrils: [], ref: 0, tgtRef: 0, targets: [] }; ACTIVE.set(st.id, st); spawnWave(st, system.currentTick|0); }

// when a hive entity spawns, register its controller
world.afterEvents.entitySpawn.subscribe(ev => { const e = ev.entity; if(e?.typeId === HM.typeHive) system.run(() => spawnForHive(e)); });

function scanForHives(){ for(const dimId of HM.scanDims){ let d; try { d = world.getDimension(dimId); } catch { continue; } let hs = []; try { hs = d.getEntities({ type: HM.typeHive }) ?? []; } catch { continue; } for(const h of hs){ if(!h) continue; if(!ACTIVE.has(h.id)) spawnForHive(h); } } }

function tick(){ if(!HM.enabled) return; const t = system.currentTick | 0; if((t % HM.scanEvery) === 0) scanForHives(); if(!ACTIVE.size) return; let placeBudget = HM.placeCap, removeBudget = HM.removeCap; let players = [];
  try { players = world.getPlayers({ gameMode: GameMode.survival }); } catch { try { players = world.getPlayers().filter(p => { try { return p.getGameMode() === GameMode.survival; } catch { return true; } }); } catch { players = []; } }
  for(const [id,s] of ACTIVE){ const d = s.dim; let alive = true; try { alive = !(typeof s.e.isValid === "function" && !s.e.isValid()); } catch { alive = false; }
    if(!alive){ ACTIVE.delete(id); continue; }
    // refresh atlas ref every 20 ticks
    if((t - s.ref) >= 20 || s.ref === undefined){ let ok = true; try { ok = !(typeof s.atlas.isValid === "function" && !s.atlas.isValid()); } catch { ok = false; }
      if(!ok){ const a = nearestAtlas(d, s.e.location, 256); if(a) s.atlas = a; else { ACTIVE.delete(id); continue; } }
      s.r = getIntTag(s.atlas, HM.tagR, s.r); s.anger = getIntTag(s.atlas, HM.tagAnger, s.anger); s.ref = t; }
    // pause entirely if portal is broken and waiting to be relit
    if(isRelightPaused(s.atlas, t)){ for(const tr of s.tendrils) tr.dead = true; continue; }
    const rr = s.r * s.r;
    if(s.r < HM.minRadius){ continue; }
    // update target list every targetsEvery ticks
    if((t - s.tgtRef) >= HM.targetsEvery || s.tgtRef === undefined){ const cands = [];
      for(const p of players){ if(p.dimension.id !== s.dimId) continue; const l = p.location; const dx = l.x - (s.atlas.location.x + 0.5), dz = l.z - (s.atlas.location.z + 0.5); if((dx*dx + dz*dz) <= rr) cands.push(p); }
      let mobs = [];
      try { mobs = d.getEntities({ families: ["mob"], location: { x: s.atlas.location.x + 0.5, y: s.atlas.location.y + 0.5, z: s.atlas.location.z + 0.5 }, maxDistance: Math.min(HM.targetRange, s.r + 32) }) ?? []; } catch {}
      for(const m of mobs){ if(!m || m.id === s.id) continue; const l = m.location; const dx = l.x - (s.atlas.location.x + 0.5), dz = l.z - (s.atlas.location.z + 0.5); if((dx*dx + dz*dz) > rr) continue; const tid = m.typeId; if(tid === HM.typeHive || tid === HM.typeAtlas) continue; cands.push(m); if(cands.length >= HM.maxTargets) break; }
      s.targets = cands; s.tgtRef = t; }
    // spawn new wave if time and anger criteria met
    if(t >= (s.nextWave || 0)){ spawnWave(s,t); }
    // move tendrils every stepEvery ticks
    if((t % HM.stepEvery) === 0){ const used = new Set(); const thick = s.r < HM.thickAt ? HM.thickSmall : HM.thickBig; for(const tr of s.tendrils){ if(t >= tr.end) tr.dead = true; if(tr.dead) continue; if(placeBudget <= 0 || tr.over) continue; const bud = Math.min(placeBudget,14); tr.placeBudget = bud; const target = pickTarget(s.targets, used, s.dimId, s.atlas.location.x + 0.5, s.atlas.location.z + 0.5, s.r, tr.hx + 0.5, tr.hy + 0.5, tr.hz + 0.5);
        let nx = tr.hx, ny = tr.hy, nz = tr.hz;
        if(target){ const l = target.location; const dx = l.x - (tr.hx + 0.5), dy = l.y - (tr.hy + 0.5), dz = l.z - (tr.hz + 0.5); const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz); if(ax >= az && ax >= ay) nx += sgn(dx); else if(az >= ax && az >= ay) nz += sgn(dz); else ny += sgn(dy); } else { nx += ((Math.random()*3)|0) - 1; nz += ((Math.random()*3)|0) - 1; ny += ((Math.random()*3)|0) - 1; }
        ny = clamp(ny,1,318);
        const ddx = nx - (s.atlas.location.x|0), ddz = nz - (s.atlas.location.z|0); if((ddx*ddx + ddz*ddz) > rr) continue;
        tr.hx = nx; tr.hy = ny; tr.hz = nz;
        placeBlob(d,tr,nx,ny,nz,thick,(s.atlas.location.x|0),(s.atlas.location.z|0),rr);
        placeBudget -= bud - tr.placeBudget;
        if(target && (t - tr.dmg) >= HM.damageEvery){ const l = target.location; const dx = l.x - (nx + 0.5), dy = l.y - (ny + 0.5), dz = l.z - (nz + 0.5); if((dx*dx + dy*dy + dz*dz) <= 4){ try { target.applyDamage(HM.damage); } catch {} } tr.dmg = t; }
      } }
    // remove dead tendrils and clean up blocks
    for(const tr of s.tendrils){ if(!tr.dead) continue; while(removeBudget > 0 && tr.rm < tr.list.length){ const p = parse(tr.list[tr.rm++]); const b = gb(d,p); if(b && b.typeId === HM.block){ try { b.setType("minecraft:air"); } catch {} } removeBudget--; if((tr.rm % 6) === 0) break; } }
    // if all tendrils cleaned up and no new waves scheduled, remove hive
    let done = true; for(const tr of s.tendrils) if(tr.rm < tr.list.length) done = false;
    if(done && t >= (s.nextWave || 0)){ ACTIVE.delete(id); }
  }
}

system.runInterval(tick,1);