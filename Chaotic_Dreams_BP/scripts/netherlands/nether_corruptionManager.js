import{world,system,BlockVolume}from"@minecraft/server";
import{pickBiome,mutateBiome,getConversionTarget,isNetherBlock}from"./nether_biomePalette.js";
import{decorateAfterConversion,cleanupSurfaceRing}from"./nether_decorators.js";
import{tickCorruptionSpawns,recordSpreadPoint}from"./nether_mobGen.js";
import{colGet,colSet}from"./nether_cache.js";
import{initLivesIfMissing,onPortalOk,onPortalBroken,syncPortalAggro,armIfMissing,isArmed,isRelightPaused}from"./nether_portalLives.js";
import{updateGoldSeal}from"./nether_goldSeal.js";
import"./nether_hive_mind.js";
import"./nether_portalDefense.js";
/* CFG: perf + spread
 tickInterval: higher = slower overall, wavePortalsPerTick: portals per tickInterval
 conversionsPerTick: base block conversions per tickInterval (plus small anger bonus)
 validateEvery: portal check, fallbackScanEvery: new portals near players
*/
const CFG=Object.freeze({
  enabled:true,
  // enable debug logging so watchdogs are always active
  debug:true,
  tickInterval:6,
  wavePortalsPerTick:3,
  // increase conversions per tick to improve spread and make corruption more aggressive
  // dramatically increase conversions per tick to make the corruption much more aggressive
  // increase conversions per tick to spread corruption much faster
  // drastically reduce conversions per tick to slow the spread
  conversionsPerTick:6,
  // allow more attempts per tick so the queue drains better
  // allow more attempts per tick so the queue drains better
  // fewer attempts per tick to throttle queue draining
  maxAttemptsPerTick:40,
  // increase generation rates for more wave seeds
  // increase generation rates for more wave seeds and larger patches
  // reduce base seeds generated per wave for slower spread
  genBase:15,
  genPerRadius:0.25,
  genCap:60,
  // increase number of cluster seeds generated per wave for more contiguous patches
  // increase number of cluster seeds generated per wave for more contiguous patches
  // fewer cluster seeds per wave yields smaller patches
  clusterPerWave:2,
  maxQueue:2600,
  // limit underground conversion to shallow depths to avoid excessive underground spread
  undergroundDepth:1,
  ySearchRadius:8,
  seekDown:48,
  seekUp:32,
  seekUpMax:96,
  recenterOnSolid:true,
  recenterModulo:3,
  fullScanUp:56,
  fullScanDown:96,
  probeStep:2,
  probeYieldEvery:32,
  maxRadius:160,
  // increase growth per wave so radius expands steadily and more territory is covered
  // increase growth per wave to expand radius faster
  // slow the radius expansion of corruption waves
  growthPerWave:0.5,
  jitter:2.0,
  // enlarge corruption seed radius and seeds per hit for bigger, contiguous patches
  // bump seed parameters to generate larger contiguous infection patches
  // enlarge corruption seed radius and seeds per hit for bigger contiguous patches
  // smaller seed radius for tighter infection zones
  seedRadius:4,
  seedsPerHit:6,
  revertPerTick:700,
  maxTrackedChanges:160000,
  seenCap:120000,
  fallbackScanEvery:80,
  validateEvery:10,
  // disable anger bonus since lives/anger system is removed
  angerConvBonusCap:0
});
/* FX: fog only (hell) around portal atlas, expands with p.radius.
 fogBase/fogScale are halved vs old v8.
*/
const FX=Object.freeze({fog:true,fogTick:16,fogBase:8,fogScale:0.275,fogName:"Vanilla_Nether",fogId:"minecraft:fog_hell"});
const DIM="minecraft:overworld",PORTAL_ID="minecraft:portal",ANCHOR_ID="netherlands:portal_atlas";
const TAG_PORTAL="nc_portal",TAG_BIO="nc_bio:",TAG_PID="nc_pid:",TAG_R="nc_r:",TAG_B0="nc_b0:",TAG_B1="nc_b1:";
// Tag for converted block count
const TAG_CONV="nc_conv:";
// Tag to mark anchors that should not generate nest/dome defense (child portals)
const TAG_NONEST="nc_nonest";
const N4=[{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}],N8=[...N4,{x:1,z:1},{x:1,z:-1},{x:-1,z:1},{x:-1,z:-1}],GOLDEN_ANGLE=2.399963229728653;
const log=(...a)=>{if(CFG.debug)console.warn("[NetherCorr]",...a)};
const gb=(d,p)=>{try{return d.getBlock(p)}catch{return}},dim=()=>{try{return world.getDimension(DIM)}catch{return}};
const isAir=id=>id==="minecraft:air"||id==="minecraft:cave_air"||id==="minecraft:void_air";
const isWater=id=>id==="minecraft:water"||id==="minecraft:flowing_water";
const isExposure=id=>isAir(id)||isWater(id)||id==="minecraft:lava"||id===PORTAL_ID||id==="minecraft:fire"||id==="minecraft:soul_fire";
const posKey=(x,y,z)=>x+"|"+y+"|"+z;
const parseKey=k=>{const[a,b,c]=k.split("|");return{x:a|0,y:b|0,z:c|0}};
const hasPrefix=(t,p)=>typeof t==="string"&&t.startsWith(p);
function getIntTag(e,prefix,def){try{for(const t of e.getTags())if(hasPrefix(t,prefix))return(parseInt(t.slice(prefix.length),10)|0)}catch{}return def|0}
const Q=[];let qh=0;const SEEN=new Set();
const PORTALS=new Map();
const OWNERS=new Map();
const REVERTING=new Map();
const PROBE_Q=[];const PROBE_SEEN=new Set();let PROBE_ACTIVE=false;
let portalsDirty=true,portalsCache=[];let waveIdx=0;
const PLAYER_FOG=new Map();

// After a portal has been active for this many ticks (20 ticks/second * 60 seconds/minute * 40 minutes),
// new corruption anchors will be spawned around its perimeter.  This helps bypass the
// maximum radius limit by creating additional corruption sources.  These child portals
// do not generate nests or domes and inherit the biome of the parent.
const CHILD_SPAWN_TICKS=48000;
function setRadiusTag(p){const e=p?.e;if(!e)return;const r=((p.radius??0)+0.5)|0;if(p.rt===r)return;p.rt=r;try{for(const t of e.getTags())if(t.startsWith(TAG_R))e.removeTag(t)}catch{}try{e.addTag(TAG_R+r)}catch{}}
function setBoundsTags(p){const e=p?.e,b=p?.bounds;if(!e||!b)return;const v0=(b.minX|0)+","+(b.minY|0)+","+(b.minZ|0),v1=(b.maxX|0)+","+(b.maxY|0)+","+(b.maxZ|0);try{for(const t of e.getTags())if(t.startsWith(TAG_B0)||t.startsWith(TAG_B1))e.removeTag(t)}catch{}try{e.addTag(TAG_B0+v0);e.addTag(TAG_B1+v1)}catch{}}

// Write the converted block count tag on the portal entity. Removes any existing nc_conv tags and writes the new value.
function setConvTag(p){const e=p?.e;if(!e)return;const val=(p.convertedCount??0)|0;
  try{for(const t of e.getTags())if(t.startsWith(TAG_CONV))e.removeTag(t)}catch{}
  try{e.addTag(TAG_CONV+val)}catch{}
}

function fallbackMossify(p,d){
  if(!p||!d||p.mossFallbackDone) return;
  const radius=Math.min(Math.max((p.radius??0)|0,12),64);
  const cx=p.cx|0,cz=p.cz|0;
  const by=p.bounds?(p.bounds.minY|0)-2:(p.cy|0)-8;
  const ty=p.bounds?(p.bounds.maxY|0)+2:(p.cy|0)+8;
  const r2=radius*radius;
  for(let x=cx-radius;x<=cx+radius;x++){
    const dx=x-cx;
    for(let z=cz-radius;z<=cz+radius;z++){
      const dz=z-cz;
      if((dx*dx+dz*dz)>r2) continue;
      for(let y=by;y<=ty;y++){
        const b=gb(d,{x,y,z});
        if(!b) continue;
        const id=b.typeId;
        if(!isNetherBlock(id)) continue;
        const to=Math.random()<0.35?"minecraft:jungle_leaves":"minecraft:moss_block";
        try{b.setType(to);}catch{}
      }
    }
  }
  p.mossFallbackDone=true;
}

// Convert all blocks that were corrupted by this portal back into moss or jungle leaves.
// This runs when the portal frame is broken.  It iterates through the recorded
// changeKeys, converts each block to moss or leaves and clears the change
// tracking for the portal.  It also resets the convertedCount back to zero
// and updates the nc_conv tag.  Owners of the blocks are released so that
// the corruption can start anew.
function convertAllCorrupted(p,d){
  if(!p||!d) return;
  if(!p.changeKeys?.length){
    fallbackMossify(p,d);
  }
  const keys=p.changeKeys;
  for(const k of keys){
    const {x,y,z}=parseKey(k);
    const b=gb(d,{x,y,z});
    if(b){
      const id=b.typeId;
      // don't convert air, water or lava; only convert if it wasn't already moss/leaves
      if(id!=="minecraft:moss_block" && id!=="minecraft:jungle_leaves" && id!=="minecraft:air" && id!=="minecraft:cave_air" && id!=="minecraft:void_air"){
        const to=Math.random()<0.35?"minecraft:jungle_leaves":"minecraft:moss_block";
        try{b.setType(to);}catch{}
      }
    }
    if(OWNERS.get(k)===p.pid) OWNERS.delete(k);
  }
  p.changes.clear();
  p.changeKeys.length=0;
  p.convertedCount=0;
  setConvTag(p);
  // Mark this anchor as nonest so that nest/dome construction stops after moss
  try{
    p.e?.addTag?.(TAG_NONEST);
  }catch{}
}

// Remove all queued conversion tasks for a given portal id.  Without purging,
// entries in the global queue belonging to a broken portal will continue to
// consume processing time and may stall conversion for other portals.  This
// helper scans the queue from the current head (qh) and rebuilds it
// omitting any tasks matching the specified pid.  It leaves the
// PROBE_Q untouched since probe tasks are inexpensive and can be skipped.
function purgeQueueForPid(pid){
  if(!pid||Q.length===0) return;
  const newQ=[];
  // Process only the unconsumed portion of the queue.  Tasks before qh
  // have either been processed or skipped, so rebuilding from qh onward
  // suffices.  We then reset qh and assign the filtered tasks back.
  for(let i=qh;i<Q.length;i++){
    const task=Q[i];
    if(task.pid!==pid) newQ.push(task);
  }
  // Reset the queue and repopulate it with retained tasks
  Q.length=0;
  qh=0;
  for(const t of newQ) Q.push(t);
}

// Spawn four child corruption anchors at the edges of an existing corruption radius.
// Child portals inherit the biome of the parent and are tagged to disable nest/dome construction.
// They are created only once per parent when the activeTicks exceed CHILD_SPAWN_TICKS.
function spawnChildPortals(parent,d,tick){
  if(!parent||parent.childrenSpawned) return;
  const r = Math.max(20, parent.radius|0);
  const offsets = [ [r,0], [-r,0], [0,r], [0,-r] ];
  for(const [dx,dz] of offsets){
    const cx = parent.cx + dx;
    const cz = parent.cz + dz;
    const cy = parent.cy;
    // create a unique pid
    const pid = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    // spawn the anchor entity at the new location
    const e = d.spawnEntity(ANCHOR_ID,{x:cx+0.5,y:cy+0.5,z:cz+0.5});
    try{
      e.addTag(TAG_PORTAL);
      e.addTag(TAG_PID+pid);
      // mark as child (no nest/dome)
      e.addTag(TAG_NONEST);
    }catch{}
    // initialize new portal object
    const bio = parent.bio;
    const bounds = null;
    const p={
      pid,
      dimId:DIM,
      e,
      bounds:bounds,
      cx:cx|0,
      cy:cy|0,
      cz:cz|0,
      bio:bio|0,
      anger:0,
      spreadMul:1,
      mobMul:1,
      radius:2,
      step:0,
      rng:hashU32(pid),
      changes:new Map(),
      changeKeys:[],
      spreadDisabled:false,
      paused:false,
      sealed:false,
      gx:cx|0,
      gy:cy|0,
      gz:cz|0,
      lx:cx|0,
      ly:cy|0,
      lz:cz|0,
      lt:0,
      rt:-1,
      convertedCount:0,
      activeTicks:0,
      nextAngerSpawnTick:(system.currentTick|0)+1200,
      chunkLoaders:[],
      childrenSpawned:false
      ,
      // tick when portal frame was last seen broken; used to stop moss after delay
      brokenAt: undefined,
      mossFallbackDone:false
    };
    PORTALS.set(pid,p);
    portalsDirty=true;
    setRadiusTag(p);
    setConvTag(p);
    // spawn chunk loading entities for the child portal
    try{
      const loaders = 4;
      for(let i=0;i<loaders;i++){
        const loader = d.spawnEntity("netherlands:chunk_loading",{x:cx+0.5,y:cy+1,z:cz+0.5});
        p.chunkLoaders.push(loader);
      }
    }catch{}
  }
  parent.childrenSpawned = true;
}

// Reposition the chunk loading entities for a portal around its current radius. These loaders
// keep outer chunks loaded as the corruption expands.
function updateChunkLoaders(p){
  const loaders=p?.chunkLoaders;
  if(!loaders||!loaders.length)return;
  const count=loaders.length;
  // radius to place loaders: a bit beyond the current corruption radius
  const radius=Math.min(CFG.maxRadius,p.radius??0)+8;
  const cx=(p.cx??0)+0.5;
  const cz=(p.cz??0)+0.5;
  const cy=((p.bounds?p.bounds.minY:p.cy)??0)+1.5;
  for(let i=0;i<count;i++){
    const angle=(i*(2*Math.PI))/count;
    const x=cx+Math.cos(angle)*radius;
    const z=cz+Math.sin(angle)*radius;
    const y=cy;
    const ent=loaders[i];
    try{ent.teleport({x,y,z});}catch{}
  }
}
function hashU32(str){let h=2166136261>>>0;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function xorshift32(x){x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>0}
function rand01(p){p.rng=xorshift32(p.rng>>>0);return(p.rng>>>0)/4294967296}
function ri(a,b){return a+((Math.random()*(b-a+1))|0)}
function makePid(){return"p"+Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function enqueue(x,y,z,bio,pid){const k=posKey(x|0,y|0,z|0);if(SEEN.has(k))return;SEEN.add(k);Q.push({x:x|0,y:y|0,z:z|0,bio:bio|0,pid});if(SEEN.size>CFG.seenCap)SEEN.clear()}
function rememberOriginal(p,x,y,z,block){if(p.changeKeys.length>=CFG.maxTrackedChanges){p.spreadDisabled=true;return false}const k=posKey(x,y,z);if(p.changes.has(k))return true;p.changes.set(k,{typeId:block.typeId,perm:block.permutation});p.changeKeys.push(k);return true}
function setBlockTracked(d,x,y,z,newId,pid){const p=PORTALS.get(pid);if(!p||p.spreadDisabled||p.paused)return false;const b=gb(d,{x,y,z});if(!b||b.typeId===newId)return false;const k=posKey(x,y,z);const owner=OWNERS.get(k);if(owner&&owner!==pid)return false;
  if(!owner){if(!rememberOriginal(p,x,y,z,b))return false;OWNERS.set(k,pid)}
  try{b.setType(newId);return true}catch{if(!owner){OWNERS.delete(k);p.changes.delete(k);p.changeKeys.pop()}return false}
}
const makeSetter=pid=>(d,x,y,z,id)=>setBlockTracked(d,x,y,z,id,pid);
function volHas(d,vol,typeId){try{if(typeof d.getBlocks==="function"){const r=d.getBlocks(vol,{includeTypes:[typeId]});if(r?.getBlockLocationIterator){for(const _ of r.getBlockLocationIterator())return true;return false}}}catch{}const a=vol.from,b=vol.to;for(let x=a.x;x<=b.x;x+=2)for(let y=a.y;y<=b.y;y+=2)for(let z=a.z;z<=b.z;z+=2){if(gb(d,{x,y,z})?.typeId===typeId)return true}return false}
function firstType(d,vol,typeId){try{if(typeof d.getBlocks==="function"){const r=d.getBlocks(vol,{includeTypes:[typeId]});if(r?.getBlockLocationIterator){for(const loc of r.getBlockLocationIterator())return loc}}}catch{}const a=vol.from,b=vol.to;for(let x=a.x;x<=b.x;x++)for(let y=a.y;y<=b.y;y++)for(let z=a.z;z<=b.z;z++){if(gb(d,{x,y,z})?.typeId===typeId)return{x,y,z}}}
function computeBounds(d,cx,cy,cz,r){const from={x:(cx-r)|0,y:(cy-r)|0,z:(cz-r)|0},to={x:(cx+r)|0,y:(cy+r)|0,z:(cz+r)|0};const vol=new BlockVolume(from,to);if(!volHas(d,vol,PORTAL_ID))return null;
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,minZ=1e9,maxZ=-1e9,c=0;
  try{const res=d.getBlocks(vol,{includeTypes:[PORTAL_ID]});if(res?.getBlockLocationIterator){for(const p of res.getBlockLocationIterator()){const x=p.x|0,y=p.y|0,z=p.z|0;c++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;if(z<minZ)minZ=z;if(z>maxZ)maxZ=z}}}catch{}
  if(!c){for(let x=from.x;x<=to.x;x++)for(let y=from.y;y<=to.y;y++)for(let z=from.z;z<=to.z;z++){if(gb(d,{x,y,z})?.typeId===PORTAL_ID){c++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;if(z<minZ)minZ=z;if(z>maxZ)maxZ=z}}}
  if(!c)return null;return{minX,maxX,minY,maxY,minZ,maxZ,cx:((minX+maxX)>>1),cy:((minY+maxY)>>1),cz:((minZ+maxZ)>>1)}
}
function ensurePidTag(e){try{for(const t of e.getTags())if(t.startsWith(TAG_PID))return t.slice(TAG_PID.length)}catch{}const pid=makePid();try{e.addTag(TAG_PID+pid)}catch{}return pid}
function getBioFromEntity(e){try{for(const t of e.getTags())if(t.startsWith(TAG_BIO))return(t.slice(TAG_BIO.length)|0)}catch{}return pickBiome()}
function setBioOnEntity(e,b){try{for(const t of e.getTags())if(t.startsWith(TAG_BIO))e.removeTag(t)}catch{}try{e.addTag(TAG_BIO+(b|0))}catch{}}
function upsertPortalAt(d,x,y,z){const bounds=computeBounds(d,x,y,z,24);if(!bounds)return;const pid="b"+bounds.minX+","+bounds.minY+","+bounds.minZ;if(PORTALS.has(pid))return;
  const e=d.spawnEntity(ANCHOR_ID,{x:bounds.cx+0.5,y:bounds.cy+0.5,z:bounds.cz+0.5});
  try{e.addTag(TAG_PORTAL);e.addTag(TAG_PID+pid)}catch{}
  initLivesIfMissing(e);armIfMissing(e,system.currentTick|0);
  const bio=pickBiome();setBioOnEntity(e,bio);
  const p={
    pid,
    dimId:DIM,
    e,
    bounds,
    cx:bounds.cx|0,
    cy:bounds.cy|0,
    cz:bounds.cz|0,
    bio:bio|0,
    anger:0,
    spreadMul:1,
    mobMul:1,
    radius:2,
    step:0,
    rng:hashU32(pid),
    changes:new Map(),
    changeKeys:[],
    spreadDisabled:false,
    paused:false,
    sealed:false,
    gx:bounds.cx|0,
    gy:bounds.minY|0,
    gz:bounds.cz|0,
    lx:bounds.cx|0,
    ly:bounds.minY|0,
    lz:bounds.cz|0,
    lt:0,
    rt:-1,
    // track total converted blocks
    convertedCount:0,
    // tick counter for how long the portal has been active
    activeTicks:0,
    // schedule for spawning portal anger entities (1200 ticks ~60s)
    nextAngerSpawnTick:(system.currentTick|0)+1200,
    // array of spawned chunk loading entities
    chunkLoaders:[]
    ,
    // flag to spawn additional child portals after long activity
    childrenSpawned:false
      ,
      // tick when portal frame was last seen broken; used to stop moss after delay
      brokenAt: undefined,
      mossFallbackDone:false
  };
  PORTALS.set(pid,p);portalsDirty=true;syncPortalAggro(p);setRadiusTag(p);setBoundsTags(p);
  // initialize conversion tag
  setConvTag(p);
  // Spawn chunk loading entities for this portal. They will be repositioned each tick.
  try{
    const loaders=6;
    for(let i=0;i<loaders;i++){
      const loader=d.spawnEntity("netherlands:chunk_loading",{x:bounds.cx+0.5,y:bounds.minY+1,z:bounds.cz+0.5});
      p.chunkLoaders.push(loader);
    }
  }catch{}
  for(let i=0;i<12;i++){const px=ri(bounds.minX,bounds.maxX),pz=ri(bounds.minZ,bounds.maxZ);enqueue(px,bounds.minY|0,pz,bio,pid)}
  log("Portal registered",pid)
}
function scanForNewPortals(d){for(const pl of world.getPlayers()){if(pl.dimension.id!==DIM)continue;const loc=pl.location,cx=loc.x|0,cy=loc.y|0,cz=loc.z|0,r=18;const vol=new BlockVolume({x:cx-r,y:cy-10,z:cz-r},{x:cx+r,y:cy+10,z:cz+r});const p=firstType(d,vol,PORTAL_ID);if(p)upsertPortalAt(d,p.x|0,p.y|0,p.z|0)}}
function rebuildAnchors(d){let anchors=[];try{anchors=d.getEntities({type:ANCHOR_ID,tags:[TAG_PORTAL]})??[]}catch{}for(const e of anchors){try{const pid=ensurePidTag(e);if(PORTALS.has(pid))continue;const bio=getBioFromEntity(e),loc=e.location,cx=loc.x|0,cy=loc.y|0,cz=loc.z|0;const bounds=computeBounds(d,cx,cy,cz,28);
      initLivesIfMissing(e);armIfMissing(e,system.currentTick|0);
      const radius=Math.max(2,getIntTag(e,TAG_R,4));
      const convertedCount=getIntTag(e,TAG_CONV,0);
      const p={pid,dimId:DIM,e,bounds:bounds??null,cx:bounds?(bounds.cx|0):cx,cy:bounds?(bounds.cy|0):cy,cz:bounds?(bounds.cz|0):cz,bio:bio|0,anger:0,spreadMul:1,mobMul:1,radius:radius,step:0,rng:hashU32(pid),changes:new Map(),changeKeys:[],spreadDisabled:false,paused:false,sealed:false,gx:cx,gy:cy,gz:cz,lx:cx,ly:cy,lz:cz,lt:0,rt:-1,convertedCount:convertedCount,activeTicks:0,nextAngerSpawnTick:(system.currentTick|0)+1200,chunkLoaders:[],childrenSpawned:false,brokenAt:undefined,mossFallbackDone:false};
      PORTALS.set(pid,p);
      syncPortalAggro(p);
      setRadiusTag(p);
      setBoundsTags(p);
      setConvTag(p);
      // When anchors are reconstructed from the loaded world data, the corruption queue is empty.
      // Seed the queue with several initial positions around the portal so that spreading
      // resumes immediately on reload. Without this, corruption may appear to stop after
      // leaving and rejoining the world.
      const by = bounds ? bounds.minY|0 : cy|0;
      for(let i=0;i<12;i++){
        const sx = bounds ? ri(bounds.minX,bounds.maxX) : cx;
        const sz = bounds ? ri(bounds.minZ,bounds.maxZ) : cz;
        enqueue(sx,by,sz,bio,pid);
      }
      // initialize brokenAt for reconstructed portals
      p.brokenAt = undefined;
      // Spawn chunk loading entities for the reconstructed portal.  When players leave
      // and rejoin, the previous p.chunkLoaders array will be lost, so respawn loaders
      // to ensure the corruption area stays loaded.  These loaders will be repositioned
      // each tick by updateChunkLoaders.
      try{
        const loaders = 6;
        p.chunkLoaders = [];
        for(let i=0;i<loaders;i++){
          const loader = d.spawnEntity("netherlands:chunk_loading", { x: (bounds ? bounds.cx : cx) + 0.5, y: (bounds ? bounds.minY : cy) + 1, z: (bounds ? bounds.cz : cz) + 0.5 });
          p.chunkLoaders.push(loader);
        }
      }catch{}
    }catch{}}
  portalsDirty=true
}
function portalsArr(){if(!portalsDirty)return portalsCache;portalsCache=[...PORTALS.values()];portalsDirty=false;return portalsCache}
function genWave(p){if(p.spreadDisabled||p.paused)return;const qsz=Q.length-qh;if(qsz>1500)return;
  const r=Math.min(CFG.maxRadius,p.radius),mul=(p.spreadMul||1);
  let gen=((CFG.genBase+(r*CFG.genPerRadius))*mul)|0,cap=((CFG.genCap)*mul)|0;if(cap>(CFG.genCap*3))cap=CFG.genCap*3;if(gen>cap)gen=cap;
  const ySeed=p.bounds?(p.bounds.minY|0):(p.gy|0);
  for(let i=0;i<gen;i++){
    const theta=(p.step++*GOLDEN_ANGLE);
    // choose rr biased towards the center to keep waves contiguous.  Use a power function to
    // bias random values nearer zero, capped at a small portion of the radius to avoid
    // random far-off seeds that look like separate islands.
    const rr = Math.pow(rand01(p),1.5) * Math.min(12, r);
    const jx=(rand01(p)-0.5)*CFG.jitter,jz=(rand01(p)-0.5)*CFG.jitter;
    const x=Math.round(p.cx+Math.cos(theta)*rr+jx),z=Math.round(p.cz+Math.sin(theta)*rr+jz);
    enqueue(x,ySeed,z,mutateBiome(p.bio),p.pid);
  }
  p.radius=Math.min(CFG.maxRadius,p.radius+CFG.growthPerWave);setRadiusTag(p)
}
function sideExposed(d,x,y,z){for(const o of N4){const b=gb(d,{x:x+o.x,y,z:z+o.z});if(b&&isExposure(b.typeId))return true}return false}
function trySurfaceSnap(d,x,y0,z){const b0=gb(d,{x,y:y0,z});if(!b0)return;
  if(isAir(b0.typeId)){
    for(let i=0;i<CFG.seekDown;i++){const yy=y0-i,b=gb(d,{x,y:yy,z});if(!b||isAir(b.typeId))continue;const a=gb(d,{x,y:yy+1,z});if(a&&isExposure(a.typeId)||sideExposed(d,x,yy,z))return yy}
    return;
  }
  let airY;
  for(let step=8,dy=step;dy<=CFG.seekUpMax;dy+=step){const yy=y0+dy,b=gb(d,{x,y:yy,z});if(!b)continue;if(isAir(b.typeId)){airY=yy;break}if(dy>=48&&step<16)step=16}
  if(airY==null)return;
  for(let i=1;i<=CFG.seekDown;i++){const yy=airY-i,b=gb(d,{x,y:yy,z});if(!b||isAir(b.typeId))continue;const a=gb(d,{x,y:yy+1,z});if(a&&isExposure(a.typeId)||sideExposed(d,x,yy,z))return yy}
}
function findTarget(d,x,yHint,z,bio,tick,p){let y0=colGet(DIM,x,z,tick);if(y0==null)y0=yHint|0;
  const ys=trySurfaceSnap(d,x,y0,z);if(ys!=null){const b=gb(d,{x,y:ys,z});if(b){const to=getConversionTarget(b.typeId,bio,true);if(to){colSet(DIM,x,z,ys,tick);return{x,y:ys,z,to}}}}
  const r=CFG.ySearchRadius;
  for(let i=0;i<=r;i++)for(const yy of(i?[y0+i,y0-i]:[y0])){const b=gb(d,{x,y:yy,z});if(!b||isAir(b.typeId))continue;const a=gb(d,{x,y:yy+1,z});if(!(a&&isExposure(a.typeId))&&!sideExposed(d,x,yy,z))continue;const to=getConversionTarget(b.typeId,bio,true);if(!to)continue;colSet(DIM,x,z,yy,tick);return{x,y:yy,z,to}}
  if(p&&CFG.recenterOnSolid&&((tick%CFG.recenterModulo)===0)){const b=gb(d,{x,y:y0,z});if(b&&!isAir(b.typeId)){const a=gb(d,{x,y:y0+1,z});if(a&&isExposure(a.typeId))colSet(DIM,x,z,y0,tick)}}
  requestProbe(x,y0,z,bio,p.pid,tick);
}
function convertDown(d,x,y,z,bio,pid){for(let i=1;i<=CFG.undergroundDepth;i++){const yy=y-i,b=gb(d,{x,y:yy,z});if(!b)continue;const to=getConversionTarget(b.typeId,bio,false);if(to)setBlockTracked(d,x,yy,z,to,pid)}}
function seedAround(x,y,z,bio,pid){for(let i=0;i<CFG.seedsPerHit;i++){const o=N8[(Math.random()*N8.length)|0];enqueue(x+o.x,y+ri(-1,1),z+o.z,bio,pid)}for(let i=0;i<CFG.clusterPerWave;i++){enqueue(x+ri(-CFG.seedRadius,CFG.seedRadius),y+ri(-1,1),z+ri(-CFG.seedRadius,CFG.seedRadius),bio,pid)}}
function doConversion(d,tick,cap){let done=0,tries=0;const lim=(cap??CFG.conversionsPerTick)|0;while(done<lim&&tries<CFG.maxAttemptsPerTick){tries++;if(qh>=Q.length){Q.length=0;qh=0;break}
    const n=Q[qh++],p=PORTALS.get(n.pid);if(!p||p.spreadDisabled||p.paused)continue;
    const target=findTarget(d,n.x,n.y,n.z,n.bio,tick,p);if(!target){p.lx=n.x|0;p.ly=n.y|0;p.lz=n.z|0;p.lt=tick;continue}
    if(!setBlockTracked(d,target.x,target.y,target.z,target.to,n.pid))continue;
    // increment converted count and update conversion tag
    const pConv=PORTALS.get(n.pid);
    if(pConv){pConv.convertedCount=(pConv.convertedCount||0)+1;setConvTag(pConv);}
    const setter=makeSetter(n.pid);
    cleanupSurfaceRing(d,target.x,target.y,target.z,n.bio,setter);
    decorateAfterConversion(d,target.x,target.y,target.z,n.bio,setter);
    convertDown(d,target.x,target.y,target.z,n.bio,n.pid);
    recordSpreadPoint(DIM,target.x,target.y,target.z,n.bio,n.pid);
    p.gx=target.x|0;p.gy=target.y|0;p.gz=target.z|0;p.lx=target.x|0;p.ly=target.y|0;p.lz=target.z|0;p.lt=tick;
    seedAround(target.x,target.y,target.z,n.bio,n.pid);
    done++;
  }}
function requestProbe(x,y0,z,bio,pid,tick){const k=posKey(x,0,z);if(PROBE_SEEN.has(k))return;PROBE_SEEN.add(k);PROBE_Q.push({x:x|0,y0:y0|0,z:z|0,bio:bio|0,pid,dimId:DIM,tick:tick|0});if(PROBE_SEEN.size>60000)PROBE_SEEN.clear();if(!PROBE_ACTIVE)system.runJob(probeRunner())}
function* probeRunner(){PROBE_ACTIVE=true;const d=dim();while(PROBE_Q.length){const task=PROBE_Q.shift(),p=PORTALS.get(task.pid);if(!d||!p||p.spreadDisabled||p.paused)continue;let ops=0;
    const x=task.x,z=task.z,y=task.y0|0,top=y+CFG.fullScanUp,bot=y-CFG.fullScanDown;
    for(let yy=top;yy>=bot;yy-=CFG.probeStep){const b=gb(d,{x,y:yy,z});if(!b||isAir(b.typeId))continue;const a=gb(d,{x,y:yy+1,z});if(!(a&&isExposure(a.typeId))&&!sideExposed(d,x,yy,z))continue;const to=getConversionTarget(b.typeId,task.bio,true);if(!to)continue;
        colSet(DIM,x,z,yy,task.tick);enqueue(x,yy,z,task.bio,task.pid);break;
      }
      if((++ops%CFG.probeYieldEvery)===0)yield;
  }
  PROBE_ACTIVE=false;
}
function startMossify(pid){const p=PORTALS.get(pid);if(!p)return;PORTALS.delete(pid);portalsDirty=true;try{p.e?.remove()}catch{}REVERTING.set(pid,{pid,keys:p.changeKeys,idx:0});log("Portal ended, mossifying",pid)}
function mossifyTick(d){for(const[pid,r]of REVERTING){let n=0;while(r.idx<r.keys.length&&n<CFG.revertPerTick){const k=r.keys[r.idx++],owner=OWNERS.get(k);if(owner===pid)OWNERS.delete(k);
        const {x,y,z}=parseKey(k),b=gb(d,{x,y,z});if(b&&!isAir(b.typeId)&&!isWater(b.typeId)&&b.typeId!=="minecraft:lava"){const to=Math.random()<0.25?"minecraft:jungle_leaves":"minecraft:moss_block";try{b.setType(to)}catch{}}n++;
      }
      if(r.idx>=r.keys.length)REVERTING.delete(pid);
      if(n>=CFG.revertPerTick)break;
  }}
function validatePortals(d,t){
  for(const [pId,p] of PORTALS){
    // skip invalid anchor
    try{
      if(!p.e || (typeof p.e.isValid === "function" && !p.e.isValid())) continue;
    }catch{continue}
    // Determine if there is any portal block still present within its bounds
    let exists=false;
    const b=p.bounds;
    if(b){
      exists=volHas(d,new BlockVolume({x:b.minX,y:b.minY,z:b.minZ},{x:b.maxX,y:b.maxY,z:b.maxZ}),PORTAL_ID);
    }else{
      exists=volHas(d,new BlockVolume({x:p.cx-2,y:p.cy-2,z:p.cz-2},{x:p.cx+2,y:p.cy+2,z:p.cz+2}),PORTAL_ID);
    }
    if(exists){
      // Portal exists: reset broken state and unpause if needed
      if(p.brokenAt!==undefined){
        p.brokenAt=undefined;
        p.mossFallbackDone=false;
      }
      if(p.paused){
        p.paused=false;
        p.spreadDisabled=false;
        onPortalOk(p);
      }
      continue;
    }
    // No portal blocks present: the portal frame has been broken.
    // Record the tick when it first broke.
    if(p.brokenAt===undefined){
      p.brokenAt=t;
    }
    // For the first few seconds after breaking, continue converting all corrupted blocks back to moss
    // so that lingering conversions are cleaned up.  The interval is 80 ticks (~4 seconds).
    if((t - p.brokenAt) < 80){
      convertAllCorrupted(p,d);
      // We still purge queued tasks to reduce lag
      purgeQueueForPid(pId);
      continue;
    }
    // After the delay has passed, perform one final clean up and then pause further spread to prevent
    // new corruption from spawning.  This stops the moss activity and corruption to reduce lag.
    convertAllCorrupted(p,d);
    purgeQueueForPid(pId);
    p.paused=true;
    p.spreadDisabled=true;
  }
}
const esc=s=>String(s??"").replace(/\\/g,"\\\\").replace(/\"/g,"\\\"");
function fogTick(d){if(!FX.fog)return;let players;try{players=world.getPlayers()}catch{return}if(!players?.length)return;
  const portals=portalsArr();
  if(!portals.length){for(const pl of players){const id=pl.name,st=PLAYER_FOG.get(id);if(st){try{pl.runCommandAsync?.(`fog @s remove "${FX.fogName}"`)}catch{try{d.runCommandAsync(`fog @a[name=\"${esc(pl.name)}\"] remove "${FX.fogName}"`)}catch{}}}PLAYER_FOG.delete(id)}return}
  for(const pl of players){if(pl.dimension.id!==DIM)continue;const loc=pl.location;let inFog=false;
    for(const p of portals){const dx=loc.x-(p.cx+0.5),dz=loc.z-(p.cz+0.5),r=FX.fogBase+(p.radius*FX.fogScale);if((dx*dx+dz*dz)<=r*r){inFog=true;break}}
    const id=pl.name,prev=PLAYER_FOG.get(id)||false;
    if(inFog&&!prev){try{pl.runCommandAsync?.(`fog @s push "${FX.fogId}" "${FX.fogName}"`)}catch{try{d.runCommandAsync(`fog @a[name=\"${esc(pl.name)}\"] push "${FX.fogId}" "${FX.fogName}"`)}catch{}}PLAYER_FOG.set(id,true)}
    else if(!inFog&&prev){try{pl.runCommandAsync?.(`fog @s remove "${FX.fogName}"`)}catch{try{d.runCommandAsync(`fog @a[name=\"${esc(pl.name)}\"] remove "${FX.fogName}"`)}catch{}}PLAYER_FOG.delete(id)}
  }
}
function tick(){if(!CFG.enabled)return;const d=dim();if(!d)return;const t=system.currentTick|0;if((t%CFG.tickInterval)!==0)return;
  if((t%CFG.validateEvery)===0){if(PORTALS.size===0)rebuildAnchors(d);validatePortals(d,t)}
  if((t%CFG.fallbackScanEvery)===0)scanForNewPortals(d);
  const arr=portalsArr();
  // Update chunk loaders, spawn portal anger entities on schedule and spawn child portals after long activity
  for(const p of arr){
    // reposition chunk loaders regardless of paused state to keep area loaded
    updateChunkLoaders(p);
    // spawn portal_anger every 30 seconds when portal is active
    if(!p.paused){
      if(!p.nextAngerSpawnTick) p.nextAngerSpawnTick=t+1200;
      if(t>=p.nextAngerSpawnTick){
        try{
          d.spawnEntity("netherlands:portal_anger",{x:p.cx+0.5,y:p.cy+0.5,z:p.cz+0.5});
        }catch{}
        p.nextAngerSpawnTick=t+1200;
      }
      // accumulate active time for this portal
      p.activeTicks=(p.activeTicks||0)+CFG.tickInterval;
      // spawn child corruption anchors once this portal has been active for the defined duration
      if(!p.childrenSpawned && p.activeTicks >= CHILD_SPAWN_TICKS){
        spawnChildPortals(p,d,t);
      }
    }
  }
  // Gold seal can pause portals (no spread + no lives + no spawns, no purification)
  for(const p of arr)updateGoldSeal(d,p,t);
  let maxA=0;const active=[];for(const p of arr){if(p.spreadDisabled||p.paused)continue;active.push(p);const a=p.anger|0;if(a>maxA)maxA=a}
  if(active.length){for(let i=0;i<CFG.wavePortalsPerTick;i++){const p=active[(waveIdx++%active.length)];genWave(p)}}
  doConversion(d,t,CFG.conversionsPerTick+Math.min(CFG.angerConvBonusCap,maxA));
  mossifyTick(d);
  // Spawns paused when sealed
  tickCorruptionSpawns(t,active,CFG.enabled,log);
  if((t%FX.fogTick)===0)fogTick(d);
}
system.runInterval(tick,1);
