import { world, system } from "@minecraft/server";
import { isRelightPaused } from "./nether_portalLives.js";
/* Phase 4 portal defense (rewritten)
   This system builds a chaotic "nest" around the portal on the last life and protective domes on the second life.
   - The nest (deformed chunks of obsidian/crying obsidian/blackstone) spawns only when anger>=CFG.nestStartAnger.
   - A dome of blackstone begins once anger>=CFG.domeStartAnger and after a delay. When the first dome completes,
     a second larger dome grows over it.
   - The nest can grow vertically as well as horizontally; its Y pad scales with the chunk radius and anger.
   - Construction pauses entirely if the portal is broken and waiting to be manually relit, and runs only while portal blocks exist.
*/
const CFG = Object.freeze({
  enabled: true,
  tickEvery: 2,
  opsPerTick: 40,
  nestStartAnger: 2,
  domeStartAnger: 2,
  mixChance: 0.45,
  baseId: "minecraft:obsidian",
  mixId: "minecraft:crying_obsidian",
  stoneId: "minecraft:blackstone",
  onlyAir: true,
  cacheEvery: 40,
  chunkRMin: 2,
  chunkRMax: 6,
  chunkAttempts: 34,
  domeDelay: 120,
  domePad: 6,
  domeMinR: 18,
  domeOpsBase: 15,
  domeOpsAnger: 8,
  dome1Ticks: 400,
  dome2Ticks: 500,
  dome2Mul: 1.35,
  dome2Add: 14
});
const DIM = "minecraft:overworld";
const PORTAL_ID = "minecraft:portal";
const ANCHOR = "netherlands:portal_atlas";
const TAG_PORTAL = "nc_portal";
const TAG_PID = "nc_pid:";
const TAG_ANGER = "nc_anger:";
const TAG_B0 = "nc_b0:";
const TAG_B1 = "nc_b1:";
const TAG_R = "nc_r:";
const TAG_SEAL = "nc_goldseal";
const AIRLIKE = new Set(["minecraft:air","minecraft:cave_air","minecraft:void_air","minecraft:fire","minecraft:soul_fire"]);
function gb(d,p){try{return d.getBlock(p)}catch{}}
function isAirLike(id){return AIRLIKE.has(id)}
function hasPrefix(t,p){return typeof t === "string" && t.startsWith(p)}
function getIntTag(e,prefix,def){try{for(const t of e.getTags())if(hasPrefix(t,prefix))return(parseInt(t.slice(prefix.length),10)|0)}catch{}return def|0}
function hasTag(e,t){try{return e.getTags().includes(t)}catch{return false}}
function getPid(e){try{for(const t of e.getTags())if(hasPrefix(t,TAG_PID))return t.slice(TAG_PID.length)}catch{};return e?.id}
function getBounds(e){let a,b;try{for(const t of e.getTags()){if(t.startsWith(TAG_B0))a=t.slice(TAG_B0.length);else if(t.startsWith(TAG_B1))b=t.slice(TAG_B1.length)}}catch{}if(!a||!b)return null;const p0=a.split(","),p1=b.split(",");if(p0.length<3||p1.length<3)return null;const minX=p0[0]|0,minY=p0[1]|0,minZ=p0[2]|0,maxX=p1[0]|0,maxY=p1[1]|0,maxZ=p1[2]|0;const cx=((minX+maxX)>>1),cy=((minY+maxY)>>1),cz=((minZ+maxZ)>>1);return{minX,minY,minZ,maxX,maxY,maxZ,cx,cy,cz}}
function setBlockAir(d,x,y,z,id){const b=gb(d,{x,y,z});if(!b)return false;if(CFG.onlyAir&&!isAirLike(b.typeId))return false;if(b.typeId===PORTAL_ID||b.typeId==="minecraft:bedrock")return false;try{b.setType(id);return true}catch{return false}}
function boundsHasPortal(d,b){for(let x=b.minX;x<=b.maxX;x++)for(let y=b.minY;y<=b.maxY;y++)for(let z=b.minZ;z<=b.maxZ;z++)if(gb(d,{x,y,z})?.typeId===PORTAL_ID)return true;return false}
const U32 = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const R01 = s => { s.r = (Math.imul(s.r,1664525)+1013904223) >>> 0; return (s.r >>> 0)/4294967296; };
const RI = (s,a,b) => a + ((R01(s) * (b - a + 1)) | 0);
const TAU = 6.283185307179586;
const STATE = new Map();
let cache = [], nextScan = 0, ci = 0;
function placeChunk(d,st,b,anger,budget){
  const cx=b.cx|0,cz=b.cz|0;
  // compute a random anchor for the chunk around the portal
  const baseDist=Math.max((b.maxX-b.minX+1)|0,(b.maxZ-b.minZ+1)|0)*0.5+2+Math.min(anger,4);
  const theta=R01(st)*TAU,dist=baseDist+R01(st)*3.2;
  const ax=(cx+Math.cos(theta)*dist)|0,az=(cz+Math.sin(theta)*dist)|0;
  let cr=(CFG.chunkRMin+R01(st)*(CFG.chunkRMax-CFG.chunkRMin+1)+(anger*0.9))|0;
  if(cr<CFG.chunkRMin)cr=CFG.chunkRMin;if(cr>CFG.chunkRMax+anger)cr=CFG.chunkRMax+anger;
  // vertical pad grows with radius and anger
  const yPad=(cr+3+(anger*2))|0;
  const y0=(b.cy|0)-yPad;
  const y1=(b.cy|0)+yPad;
  const rr=cr*cr;
  let placed=0;
  for(let i=0;i<CFG.chunkAttempts&&budget>0;i++){
    const dx=RI(st,-cr,cr),dz=RI(st,-cr,cr);if(dx*dx+dz*dz>rr)continue;
    const x=ax+dx,z=az+dz,y=RI(st,y0,y1);
    let id=CFG.baseId;if(Math.random()<CFG.mixChance)id=CFG.mixId;
    if(anger>=2&&Math.random()<0.12)id=CFG.stoneId;
    if(setBlockAir(d,x,y,z,id)){placed++;budget--}
  }
  return placed;
}
function domeTargetR(e,b){
  let r=getIntTag(e,TAG_R,0)+CFG.domePad;
  if(r<CFG.domeMinR)r=CFG.domeMinR;
  const sx=(b.maxX-b.minX+1)|0,sz=(b.maxZ-b.minZ+1)|0;
  const pr=(Math.max(sx,sz)*0.5+6)|0;
  if(r<pr)r=pr;
  return r;
}
function placeDome(d,st,b,anger,budget){
  // uses st.domeR as radius, builds random positions on sphere surface
  const cx=b.cx+0.5,cz=b.cz+0.5,baseY=(b.minY-1)|0;
  const R=st.domeR|0;
  let placed=0;
  while(budget>0){
    const u1=R01(st),u2=R01(st);
    const theta=u1*TAU,cosPhi=u2,sinPhi=Math.sqrt(Math.max(0,1-cosPhi*cosPhi));
    const x=(cx+R*sinPhi*Math.cos(theta))|0;
    const z=(cz+R*sinPhi*Math.sin(theta))|0;
    const y=(baseY+R*cosPhi)|0;
    if(y<1||y>318){budget--;continue;}
    if(setBlockAir(d,x,y,z,CFG.stoneId)){placed++;budget--;}
    else budget--;
    if(placed>=10+anger*2)break;
  }
  return placed;
}
function tick(){
  if(!CFG.enabled)return;
  const t=system.currentTick|0;
  if((t%CFG.tickEvery)!==0)return;
  let d;
  try{d=world.getDimension(DIM)}catch{return}
  // refresh atlas list every cacheEvery ticks
  if(t>=nextScan){try{cache=d.getEntities({type:ANCHOR,tags:[TAG_PORTAL]})??[]}catch{cache=[]}nextScan=t+CFG.cacheEvery;ci=0;}
  if(!cache.length)return;
  let ops=0,loops=0;
  // iterate through atlas entities
  while(ops<CFG.opsPerTick && loops<cache.length){
    const e=cache[ci++%cache.length];loops++;
    if(!e)continue;
    try{if(typeof e.isValid==="function" && !e.isValid())continue;}catch{continue;}
    // skip if sealed by gold seal
    if(hasTag(e,TAG_SEAL))continue;
    const anger=getIntTag(e,TAG_ANGER,0);
    const pid=getPid(e);
    // clear state if below thresholds
    if(anger<CFG.domeStartAnger && anger<CFG.nestStartAnger){STATE.delete(pid);continue;}
    // pause when portal is broken and awaiting manual relight
    if(isRelightPaused(e,t)){
      continue;
    }
    const b=getBounds(e);
    if(!b)continue;
    // skip if there is no portal block inside bounds (portal fully destroyed)
    if(!boundsHasPortal(d,b))continue;
    // track state per portal
    let st=STATE.get(pid);
    if(!st){
      st={pid,seed:U32(pid),dStage:0,start:t,d0:0,domeR:0};
      STATE.set(pid,st);
    }
    // build nest if anger>=nestStartAnger
    if(anger>=CFG.nestStartAnger){
      let bud=Math.min(CFG.opsPerTick-ops,14);
      ops+=placeChunk(d,st,b,anger,bud);
    }
    // build domes if anger>=domeStartAnger after delay
    if(anger>=CFG.domeStartAnger && t - st.start >= CFG.domeDelay){
      // initialize stage and radius if first time
      if(st.dStage===0){st.dStage=1;st.d0=t;st.domeR=domeTargetR(e,b);} 
      // if first dome complete, transition to second
      if(st.dStage===1 && t - st.d0 >= CFG.dome1Ticks){st.dStage=2;st.d0=t;const baseR=domeTargetR(e,b);st.domeR=Math.max((baseR*CFG.dome2Mul)|0,baseR+CFG.dome2Add);} 
      // if second dome complete, mark done
      if(st.dStage===2 && t - st.d0 >= CFG.dome2Ticks){st.dStage=3;}
      // if stage<3, do dome placement
      if(st.dStage<3){
        const domeBud=Math.min(CFG.opsPerTick-ops,CFG.domeOpsBase+anger*CFG.domeOpsAnger);
        ops+=placeDome(d,st,b,anger,domeBud);
      }
    }
    // update state back
    STATE.set(pid,st);
  }
}
system.runInterval(tick,1);