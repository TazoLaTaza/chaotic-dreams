import{world,system}from"@minecraft/server";
/*
 * Phase 4 portal defense (reworked)
 *
 * The protective shell and domes around a portal are now triggered by the
 * number of corrupted blocks rather than the old "anger/life" system.  Once
 * the corruption has converted at least `convNest` blocks, a deforming
 * protective shell (the "nest") will begin to form.  When the corruption
 * has converted at least `convDome1` blocks, a first domed shield will begin
 * to grow around the portal.  After converting at least `convDome2` blocks
 * the dome will continue to grow in size, expanding outward over time.
 *
 * Key parameters:
 *  - tickEvery: how often to run the defense logic (ticks)
 *  - opsPerTick: maximum number of block placements per tick
 *  - convNest: total conversions required to start the nest shell
 *  - convDome1: total conversions required to begin dome construction
 *  - convDome2: total conversions required to begin endless dome growth
 *  - mixChance: chance that a shell block will be crying obsidian instead
 *    of normal obsidian (for visual variation)
 *  - eggGrowEvery: ticks between size increments of the dome once
 *    `convDome2` has been reached
 *  - cacheEvery: ticks between portal atlas scans (performance)
 *  - onlyAir: if true, only replaces air/fire blocks when placing shell
 */
const CFG=Object.freeze({
  tickEvery:3,
  // increase ops per tick to help domes finish more reliably
  opsPerTick:34,
  // radius thresholds (in blocks) to trigger nest/dome construction.  These
  // values have been reduced so the nest begins when the corruption reaches
  // 15 blocks, the first dome begins at 25 blocks and the second dome
  // (endless growth) begins at 50 blocks.  Lower values make the
  // defensive structures appear sooner.
  radNest:15,
  radDome1:25,
  radDome2:50,
  // appearance
  mixChance:0.45,
  baseId:"minecraft:obsidian",
  mixId:"minecraft:crying_obsidian",
  stoneId:"minecraft:blackstone",
  // time between growth steps for the dome once past radDome2 (very slow growth)
  eggGrowEvery:300,
  cacheEvery:60,
  onlyAir:true
});
const DIM="minecraft:overworld",ANCHOR="netherlands:portal_atlas",TAG_PORTAL="nc_portal",TAG_PID="nc_pid:",TAG_ANGER="nc_anger:",TAG_CONV="nc_conv:",TAG_R="nc_r:",TAG_B0="nc_b0:",TAG_B1="nc_b1:";
const isAirLike=id=>id==="minecraft:air"||id==="minecraft:cave_air"||id==="minecraft:void_air"||id==="minecraft:fire"||id==="minecraft:soul_fire";
const hasPrefix=(t,p)=>typeof t==="string"&&t.startsWith(p);
function getStrTag(e,p){try{for(const t of e.getTags())if(hasPrefix(t,p))return t.slice(p.length)}catch{}}
function getPid(e){try{return getStrTag(e,TAG_PID)||e.id}catch{return"u"+Math.random().toString(36).slice(2,8)}}
function getIntTag(e,p,d){try{for(const t of e.getTags())if(hasPrefix(t,p))return(parseInt(t.slice(p.length),10)|0)}catch{}return d|0}
function getBounds(e){let a,b;try{for(const t of e.getTags()){if(t.startsWith(TAG_B0))a=t.slice(TAG_B0.length);else if(t.startsWith(TAG_B1))b=t.slice(TAG_B1.length)}}catch{}if(!a||!b)return;const p0=a.split(","),p1=b.split(",");if(p0.length<3||p1.length<3)return;const minX=p0[0]|0,minY=p0[1]|0,minZ=p0[2]|0,maxX=p1[0]|0,maxY=p1[1]|0,maxZ=p1[2]|0;return{minX,minY,minZ,maxX,maxY,maxZ}}
const gb=(d,x,y,z)=>{try{return d.getBlock({x,y,z})}catch{}};
function setBlockAir(d,x,y,z,id){const b=gb(d,x,y,z);if(!b)return false;if(CFG.onlyAir&&!isAirLike(b.typeId))return false;try{b.setType(id);return true}catch{return false}}
const S=new Map();
const h32=(s)=>{let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0};
const mix=(h,x,y,z)=>{h^=(x*374761393)^(y*668265263)^(z*2147483647);h=Math.imul(h^(h>>>13),1274126177);return(h^(h>>>16))>>>0};
let cache=[],nextScan=0,ci=0;
function initIter(st,b,ex){st.ex=ex;st.minX=b.minX-ex.x;st.maxX=b.maxX+ex.x;st.minY=b.minY-ex.y;st.maxY=b.maxY+ex.y;st.minZ=b.minZ-ex.z;st.maxZ=b.maxZ+ex.z;st.x=st.minX;st.y=st.minY;st.z=st.minZ;st.done=0}
function stepShell(d,st,pickId,budget){const minX=st.minX,maxX=st.maxX,minY=st.minY,maxY=st.maxY,minZ=st.minZ,maxZ=st.maxZ;let placed=0;while(budget>0){if(st.x>maxX){st.done=1;break}const x=st.x,y=st.y,z=st.z;st.z++;if(st.z>maxZ){st.z=minZ;st.y++;if(st.y>maxY){st.y=minY;st.x++}}if(!(x===minX||x===maxX||y===minY||y===maxY||z===minZ||z===maxZ))continue;
    const n=mix(st.seed,x,y,z)&15; // deformed shell holes
    if(st.mode===2&&n<4)continue;
    const id=pickId(x,y,z);if(!id)continue;
    if(setBlockAir(d,x,y,z,id)){placed++;budget--}
  }return placed}
function tick(){
  const t=system.currentTick|0;
  if((t%CFG.tickEvery)!==0) return;
  let d;
  try{ d=world.getDimension(DIM); } catch { return; }
  // refresh cache of portal anchors periodically
  if(t>=nextScan){
    try{ cache = d.getEntities({ type: ANCHOR, tags: [TAG_PORTAL] }) ?? []; }
    catch{ cache = []; }
    nextScan = t + CFG.cacheEvery;
    ci = 0;
  }
  if(!cache.length) return;
  let ops=0, loops=0;
  while(ops < CFG.opsPerTick && loops < cache.length){
    const e = cache[ci++ % cache.length];
    loops++;
    if(!e) continue;
    try{ if(typeof e.isValid === "function" && !e.isValid()) continue; }catch{ continue; }
    const pid = getPid(e);
    // corruption radius read from the nc_r tag (integer)
    const rad = getIntTag(e, TAG_R, 0);
    // skip portals whose corruption radius hasn't reached the nest threshold
    if(rad < CFG.radNest){
      S.delete(pid);
      continue;
    }
    const b = getBounds(e);
    if(!b) continue;
    // determine whether dome mode should be active and whether endless growth is enabled
    const domeActive = rad >= CFG.radDome1;
    const endlessDome = rad >= CFG.radDome2;
    let st = S.get(pid);
    // initialize state if new
    if(!st){
      st = {
        pid,
        seed: h32(pid),
        mode: domeActive ? 2 : 1,
        phase: 0,
        // shell thickness around the portal bounds
        ex: { x: 1, y: 1, z: 1 },
        nextGrow: 0,
        minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0,
        x: 0, y: 0, z: 0,
        done: 0
      };
      // if dome is already active, start with a thicker shell
      if(domeActive){
        st.ex.x = 2;
        st.ex.y = 2;
        st.ex.z = 2;
        st.nextGrow = t + CFG.eggGrowEvery;
      }
      initIter(st, b, st.ex);
    }
    // update mode based on whether dome is active
    if(domeActive){
      if(st.mode !== 2){
        // switch from nest to dome
        st.mode = 2;
        st.phase = 0;
        if(st.ex.x < 2) st.ex.x = 2;
        if(st.ex.y < 2) st.ex.y = 2;
        if(st.ex.z < 2) st.ex.z = 2;
        st.nextGrow = t + CFG.eggGrowEvery;
        initIter(st, b, st.ex);
      }
    }else{
      if(st.mode !== 1){
        // switch back to nest mode
        st.mode = 1;
        st.phase = 0;
        st.ex = { x: 1, y: 1, z: 1 };
        initIter(st, b, st.ex);
      }
    }
    // handle phase transitions and dome growth
    if(st.done){
      if(st.mode === 1){
        // nest mode has two phases: phase 0 (obsidian/crying) then phase 1 (blackstone)
        if(st.phase === 0){
          st.phase = 1;
          // second layer of nest is thicker
          initIter(st, b, { x: 2, y: 2, z: 2 });
        } else {
          // no more phases for nest
          st.phase = 2;
        }
      } else {
        // dome mode: continue growth if endless growth is enabled and the time has passed
        if(endlessDome){
          if(t >= st.nextGrow){
            st.nextGrow = t + CFG.eggGrowEvery;
            // randomize growth in each dimension
            st.ex.x += ((mix(st.seed, t, st.ex.x, 1) & 1));
            st.ex.y += ((mix(st.seed, t, st.ex.y, 2) & 1));
            st.ex.z += ((mix(st.seed, t, st.ex.z, 3) & 1));
            initIter(st, b, st.ex);
          } else {
            // wait for next growth tick
            S.set(pid, st);
            continue;
          }
        } else {
          // not endless: once done with current shell, stop any further dome growth
          // do nothing; allow stepShell to proceed
        }
      }
    }
    // if nest has finished both phases, do nothing further
    if(st.mode === 1 && st.phase === 2){
      S.set(pid, st);
      continue;
    }
    // choose block id to place: nest uses stone on phase 1; otherwise obsidian/crying mix
    const pick = (st.mode === 1 && st.phase === 1)
      ? (() => CFG.stoneId)
      : (() => (Math.random() < CFG.mixChance ? CFG.mixId : CFG.baseId));
    // perform placement work
    ops += stepShell(d, st, pick, CFG.opsPerTick - ops);
    S.set(pid, st);
  }
}
system.runInterval(tick, 1);
