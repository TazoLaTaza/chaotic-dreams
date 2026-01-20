import{world,system}from"@minecraft/server";
/* Phase 3 lives/anger (isolated)
Tags on portal_atlas:
- nc_lives:N remaining lives (default maxLives)
- nc_anger:N anger stage (0..maxLives)
- nc_arm:N tick when lives system arms (grace before lives start)
- nc_broken set after consuming a life for the current break (cleared when portal returns)
- nc_hive set once hive mind spawned
*/
/* Life system disabled. Instead of tracking lives/anger, the portal simply pauses when broken.
   We keep some constants for backward compatibility but they are unused. */
const LCFG=Object.freeze({
  enabled:false,
  // values below are unused when enabled is false
  maxLives:0,
  armDelayTicks:0,
  relightDelayTicks:0,
  spreadMulPerAnger:0,
  mobMulPerAnger:0,
  fireId:"minecraft:fire",
  angerEntity:"netherlands:portal_anger",
  hiveEntity:"netherlands:hive_mind",
  lifeMobBurst:true,
  lifeMobs:["minecraft:piglin","minecraft:zombified_piglin","minecraft:hoglin","minecraft:magma_cube","minecraft:wither_skeleton"],
  lifeMobBase:0,
  lifeMobPerAnger:0,
  lifeMobCap:0,
  lifeMobRange:0
});
const TAG_LIVES="nc_lives:",TAG_ANGER="nc_anger:",TAG_ARM="nc_arm:",TAG_REL="nc_relite:",TAG_BROKEN="nc_broken",TAG_HIVE="nc_hive";
const isAir=id=>id==="minecraft:air"||id==="minecraft:cave_air"||id==="minecraft:void_air";
const hasPrefix=(t,p)=>typeof t==="string"&&t.startsWith(p);
function getIntTag(e,prefix,def){try{for(const t of e.getTags())if(hasPrefix(t,prefix))return(parseInt(t.slice(prefix.length),10)|0)}catch{}return def|0}
function setIntTag(e,prefix,val){try{for(const t of e.getTags())if(hasPrefix(t,prefix))e.removeTag(t)}catch{}try{e.addTag(prefix+(val|0))}catch{}}
function hasTag(e,t){try{return e.getTags().includes(t)}catch{return false}}
function addTag(e,t){try{e.addTag(t)}catch{}}
function remTag(e,t){try{e.removeTag(t)}catch{}}
// igniteAt is unused once lives are disabled. Keep as no-op for compatibility.
function igniteAt(d,x,y,z){return false}
function rnd(){return(Math.random()*2-1)}
function spawnBurst(d,loc,anger){if(!LCFG.lifeMobBurst||!d||!loc)return;const n=Math.min(LCFG.lifeMobCap,LCFG.lifeMobBase+(anger|0)*LCFG.lifeMobPerAnger)|0;for(let i=0;i<n;i++){
    const id=LCFG.lifeMobs[(Math.random()*LCFG.lifeMobs.length)|0];
    const x=loc.x+rnd()*LCFG.lifeMobRange,z=loc.z+rnd()*LCFG.lifeMobRange,y=loc.y;
    try{d.spawnEntity(id,{x,y,z})}catch{}
  }
}
export function initLivesIfMissing(e){
  // Lives system disabled: no initialization needed
}
export function armIfMissing(e,now){
  // Lives system disabled: portal is always armed
}
export function isArmed(e,now){
  // Always armed since lives system is disabled
  return true;
}
export function syncPortalAggro(p){
  // When lives are disabled, set anger=0 and normalize spread/mob multipliers
  if(!p||!p.e)return;
  p.anger=0;
  p.spreadMul=1;
  p.mobMul=1;
  const e=p.e;
  // remove existing nc_anger tags and set to 0 for compatibility
  try{
    for(const t of e.getTags()){
      if(t && t.startsWith(TAG_ANGER)) e.removeTag(t);
    }
    e.addTag(TAG_ANGER+"0");
  }catch{}
}
export function onPortalOk(p){
  // clear broken tag and reset aggression
  if(!p||!p.e)return;
  const e=p.e;
  if(hasTag(e,TAG_BROKEN)) remTag(e,TAG_BROKEN);
  syncPortalAggro(p);
}
export function onPortalBroken(d,p){
  // When portal breaks, mark as broken but do not consume lives.
  if(!p||!p.e)return false;
  const e=p.e;
  // If already marked broken, nothing changes
  if(hasTag(e,TAG_BROKEN)){
    syncPortalAggro(p);
    return false;
  }
  // Mark as broken so corruption pauses
  addTag(e,TAG_BROKEN);
  // Use safe coordinates for spawning burst and cleanup: derive from portal bounds or stored center
  const b=p.bounds;
  const cx=b ? (b.cx|0) : (p.cx|0);
  const cy=b ? (b.minY|0) : (p.cy|0);
  const cz=b ? (b.cz|0) : (p.cz|0);
  // Spawn a burst of mobs for flavor at the portal center
  try{
    spawnBurst(d,{x:cx+0.5,y:cy+0.5,z:cz+0.5},1);
  }catch{}
  // Convert nether blocks (netherrack, basalt, blackstone, obsidian) around portal to moss
  try{
    cleanupPortalNetherBlocks(d,p);
  }catch{}
  syncPortalAggro(p);
  return false;
}

/**
 * Convert certain Nether blocks around the portal into moss blocks when the portal breaks.
 * This includes obsidian, crying obsidian, blackstone, basalt and netherrack within the
 * portal bounds (expanded slightly). This helps illustrate the corruption receding when
 * the portal is broken. Safe coordinates are derived from the portal's bounds or fallback
 * to a small box around its stored center.
 *
 * @param {Dimension} d
 * @param {Object} p Portal state containing bounds, cx, cy, cz
 */
function cleanupPortalNetherBlocks(d,p){
  if(!p||!d)return;
  const e=p.e;
  let minX,minY,minZ,maxX,maxY,maxZ;
  if(p.bounds){
    const b=p.bounds;
    minX=b.minX|0;minY=b.minY|0;minZ=b.minZ|0;
    maxX=b.maxX|0;maxY=b.maxY|0;maxZ=b.maxZ|0;
    // Expand bounds slightly
    minX-=4;maxX+=4;
    minY-=2;maxY+=2;
    minZ-=4;maxZ+=4;
  }else{
    const cx=p.cx|0,cy=p.cy|0,cz=p.cz|0;
    minX=cx-4;maxX=cx+4;
    minY=cy-4;maxY=cy+4;
    minZ=cz-4;maxZ=cz+4;
  }
  for(let x=minX;x<=maxX;x++){
    for(let y=minY;y<=maxY;y++){
      for(let z=minZ;z<=maxZ;z++){
        let b;
        try{b=d.getBlock({x,y,z});}catch{continue;}
        if(!b)continue;
        const id=b.typeId;
        if(id==="minecraft:obsidian"||id==="minecraft:crying_obsidian"||
           id==="minecraft:blackstone"||id==="minecraft:polished_blackstone"||
           id==="minecraft:basalt"||id==="minecraft:polished_basalt"||
           id==="minecraft:netherrack"){
          try{b.setType("minecraft:moss_block");}catch{}
        }
      }
    }
  }
}
export function isRelightPaused(e,t){
  // A portal is considered in the relight pause if it's marked as broken
  return hasTag(e,TAG_BROKEN);
}
export function getLives(e){
  // Lives system disabled
  return 0;
}
export function getAnger(e){
  // Always anger 0
  return 0;
}
export const LivesConfig=LCFG;
