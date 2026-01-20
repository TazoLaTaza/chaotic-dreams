import{world,system,BlockVolume}from"@minecraft/server";
import{pickBiome,mutateBiome,getConversionTarget}from"./nether_biomePalette.js";
import{decorateAfterConversion,cleanupSurfaceRing}from"./nether_decorators.js";
import{tickCorruptionSpawns,recordSpreadPoint}from"./nether_mobGen.js";
import{colGet,colSet}from"./nether_cache.js";
import{initLivesIfMissing,onPortalOk,onPortalBroken,syncPortalAggro,armIfMissing,isArmed}from"./nether_portalLives.js";
import{updateGoldSeal}from"./nether_goldSeal.js";
import"./nether_hive_mind.js";
import"./nether_portalDefense.js";
/* CFG: perf + spread
 tickInterval: higher = slower overall, wavePortalsPerTick: portals per tickInterval
 conversionsPerTick: base block conversions per tickInterval (plus small anger bonus)
 validateEvery: portal check, fallbackScanEvery: new portals near players
*/
// Increased conversion and generation parameters to expand corruption coverage and speed.
const CFG=Object.freeze({enabled:true,debug:false,tickInterval:6,wavePortalsPerTick:1,conversionsPerTick:4,maxAttemptsPerTick:24,genBase:24,genPerRadius:0.18,genCap:80,clusterPerWave:1,maxQueue:2600,undergroundDepth:4,ySearchRadius:10,seekDown:64,seekUp:32,seekUpMax:128,recenterOnSolid:true,recenterModulo:3,fullScanUp:56,fullScanDown:96,probeStep:2,probeYieldEvery:32,maxRadius:160,growthPerWave:0.55,jitter:1.0,seedRadius:2,seedsPerHit:4,revertPerTick:700,maxTrackedChanges:160000,seenCap:120000,fallbackScanEvery:80,validateEvery:10,angerConvBonusCap:3});
/* FX: fog only (hell) around portal atlas, expands with p.radius.
 fogBase/fogScale are halved vs old v8.
*/
const FX=Object.freeze({fog:true,fogTick:16,fogBase:8,fogScale:0.275,fogName:"Vanilla_Nether",fogId:"minecraft:fog_hell"});
const DIM="minecraft:overworld",PORTAL_ID="minecraft:portal",ANCHOR_ID="netherlands:portal_atlas";
const TAG_PORTAL="nc_portal",TAG_BIO="nc_bio:",TAG_PID="nc_pid:",TAG_R="nc_r:",TAG_B0="nc_b0:",TAG_B1="nc_b1:";
const N4=[{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}],N8=[...N4,{x:1,z:1},{x:1,z:-1},{x:-1,z:1},{x:-1,z:-1}],GOLDEN_ANGLE=2.399963229728653;
const log=(...a)=>{if(CFG.debug)console.warn("[NetherCorr]",...a)};
const gb=(d,p)=>{try{return d.getBlock(p)}catch{return}},dim=()=>{try{return world.getDimension(DIM)}catch{return}};
const isAir=id=>id==="minecraft:air"||id==="minecraft:cave_air"||id==="minecraft:void_air";
const isWater=id=>id==="minecraft:water"||id==="minecraft:flowing_water";
const isExposure=id=>isAir(id)||isWater(id)||id==="minecraft:lava"||id===PORTAL_ID||id==="minecraft:fire"||id==="minecraft:soul_fire";
const posKey=(x,y,z)=>x+"|"+y+"|"+z;
const parseKey=k=>{const[a,b,c]=k.split("|");return{x:a|0,y:b|0,z:c|0}};
const Q=[];let qh=0;const SEEN=new Set();
const PORTALS=new Map();
const OWNERS=new Map();
const REVERTING=new Map();
const PROBE_Q=[];const PROBE_SEEN=new Set();let PROBE_ACTIVE=false;
let portalsDirty=true,portalsCache=[];let waveIdx=0;
const PLAYER_FOG=new Map();
function setRadiusTag(p){const e=p?.e;if(!e)return;const r=((p.radius??0)+0.5)|0;if(p.rt===r)return;p.rt=r;try{for(const t of e.getTags())if(t.startsWith(TAG_R))e.removeTag(t)}catch{}try{e.addTag(TAG_R+r)}catch{}}
function setBoundsTags(p){const e=p?.e,b=p?.bounds;if(!e||!b)return;const v0=(b.minX|0)+","+(b.minY|0)+","+(b.minZ|0),v1=(b.maxX|0)+","+(b.maxY|0)+","+(b.maxZ|0);try{for(const t of e.getTags())if(t.startsWith(TAG_B0)||t.startsWith(TAG_B1))e.removeTag(t)}catch{}try{e.addTag(TAG_B0+v0);e.addTag(TAG_B1+v1)}catch{}}
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
  const p={pid,dimId:DIM,e,bounds,cx:bounds.cx|0,cy:bounds.cy|0,cz:bounds.cz|0,bio:bio|0,anger:0,spreadMul:1,mobMul:1,radius:2,step:0,rng:hashU32(pid),changes:new Map(),changeKeys:[],spreadDisabled:false,paused:false,sealed:false,gx:bounds.cx|0,gy:bounds.minY|0,gz:bounds.cz|0,lx:bounds.cx|0,ly:bounds.minY|0,lz:bounds.cz|0,lt:0,rt:-1};
  PORTALS.set(pid,p);portalsDirty=true;syncPortalAggro(p);setRadiusTag(p);setBoundsTags(p);
  for(let i=0;i<12;i++){const px=ri(bounds.minX,bounds.maxX),pz=ri(bounds.minZ,bounds.maxZ);enqueue(px,bounds.minY|0,pz,bio,pid)}
  log("Portal registered",pid)
}
function scanForNewPortals(d){for(const pl of world.getPlayers()){if(pl.dimension.id!==DIM)continue;const loc=pl.location,cx=loc.x|0,cy=loc.y|0,cz=loc.z|0,r=18;const vol=new BlockVolume({x:cx-r,y:cy-10,z:cz-r},{x:cx+r,y:cy+10,z:cz+r});const p=firstType(d,vol,PORTAL_ID);if(p)upsertPortalAt(d,p.x|0,p.y|0,p.z|0)}}
function rebuildAnchors(d){let anchors=[];try{anchors=d.getEntities({type:ANCHOR_ID,tags:[TAG_PORTAL]})??[]}catch{}for(const e of anchors){try{const pid=ensurePidTag(e);if(PORTALS.has(pid))continue;const bio=getBioFromEntity(e),loc=e.location,cx=loc.x|0,cy=loc.y|0,cz=loc.z|0;const bounds=computeBounds(d,cx,cy,cz,28);
      initLivesIfMissing(e);armIfMissing(e,system.currentTick|0);
      const p={pid,dimId:DIM,e,bounds:bounds??null,cx:bounds?(bounds.cx|0):cx,cy:bounds?(bounds.cy|0):cy,cz:bounds?(bounds.cz|0):cz,bio:bio|0,anger:0,spreadMul:1,mobMul:1,radius:4,step:0,rng:hashU32(pid),changes:new Map(),changeKeys:[],spreadDisabled:false,paused:false,sealed:false,gx:cx,gy:cy,gz:cz,lx:cx,ly:cy,lz:cz,lt:0,rt:-1};
      PORTALS.set(pid,p);syncPortalAggro(p);setRadiusTag(p);setBoundsTags(p);
    }catch{}}
  portalsDirty=true
}
function portalsArr(){if(!portalsDirty)return portalsCache;portalsCache=[...PORTALS.values()];portalsDirty=false;return portalsCache}
function genWave(p){if(p.spreadDisabled||p.paused)return;const qsz=Q.length-qh;if(qsz>1500)return;
  const r=Math.min(CFG.maxRadius,p.radius),mul=(p.spreadMul||1);
  let gen=((CFG.genBase+(r*CFG.genPerRadius))*mul)|0,cap=((CFG.genCap)*mul)|0;if(cap>(CFG.genCap*3))cap=CFG.genCap*3;if(gen>cap)gen=cap;
  const ySeed=p.bounds?(p.bounds.minY|0):(p.gy|0);
  for(let i=0;i<gen;i++){
    const theta=(p.step++*GOLDEN_ANGLE),u=rand01(p),rr=u<0.30?rand01(p)*Math.min(8,r):Math.pow(rand01(p),0.65)*r;
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
function validatePortals(d,t){for(const[pId,p]of PORTALS){if(p.paused)continue;try{if(!p.e||typeof p.e.isValid==="function"&&!p.e.isValid())continue}catch{continue}
    let ok=false;const b=p.bounds;
    if(b){ok=volHas(d,new BlockVolume({x:b.minX,y:b.minY,z:b.minZ},{x:b.maxX,y:b.maxY,z:b.maxZ}),PORTAL_ID)}
    else{ok=volHas(d,new BlockVolume({x:p.cx-2,y:p.cy-2,z:p.cz-2},{x:p.cx+2,y:p.cy+2,z:p.cz+2}),PORTAL_ID)}
    if(ok){onPortalOk(p);continue}
    if(!isArmed(p.e,t)){startMossify(pId);continue}
    if(onPortalBroken(d,p))startMossify(pId);
  }}
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
