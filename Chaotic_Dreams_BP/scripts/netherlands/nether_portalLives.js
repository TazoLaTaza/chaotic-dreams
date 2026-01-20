import{world,system}from"@minecraft/server";
/* Phase 3 lives/anger (isolated)
Tags on portal_atlas:
- nc_lives:N remaining lives (default maxLives)
- nc_anger:N anger stage (0..maxLives)
- nc_arm:N tick when lives system arms (grace before lives start)
- nc_broken set after consuming a life for the current break (cleared when portal returns)
- nc_hive set once hive mind spawned
*/
const LCFG=Object.freeze({
  // Disable the legacy lives/anger system.  When disabled the portal does not track
  // lives or anger and will not auto-relight.  Breaking the portal simply
  // triggers conversion logic in the corruption manager.
  enabled:false,
  // maxLives, armDelayTicks and relightDelayTicks are unused when the system is disabled
  maxLives:3,
  armDelayTicks:400,
  relightDelayTicks:300,
  spreadMulPerAnger:0.35, // anger -> faster corruption
  mobMulPerAnger:0.30, // anger -> more spawns
  fireId:"minecraft:fire",
  angerEntity:"netherlands:portal_anger",
  hiveEntity:"netherlands:hive_mind", // unused when lives system is disabled
  lifeMobBurst:true,
  lifeMobs:["minecraft:piglin","minecraft:zombified_piglin","minecraft:hoglin","minecraft:magma_cube","minecraft:wither_skeleton"],
  lifeMobBase:2,
  lifeMobPerAnger:1,
  lifeMobCap:6,
  lifeMobRange:4
});
const TAG_LIVES="nc_lives:",TAG_ANGER="nc_anger:",TAG_ARM="nc_arm:",TAG_BROKEN="nc_broken",TAG_HIVE="nc_hive";
const isAir=id=>id==="minecraft:air"||id==="minecraft:cave_air"||id==="minecraft:void_air";
const hasPrefix=(t,p)=>typeof t==="string"&&t.startsWith(p);
function getIntTag(e,prefix,def){try{for(const t of e.getTags())if(hasPrefix(t,prefix))return(parseInt(t.slice(prefix.length),10)|0)}catch{}return def|0}
function setIntTag(e,prefix,val){try{for(const t of e.getTags())if(hasPrefix(t,prefix))e.removeTag(t)}catch{}try{e.addTag(prefix+(val|0))}catch{}}
function hasTag(e,t){try{return e.getTags().includes(t)}catch{return false}}
function addTag(e,t){try{e.addTag(t)}catch{}}
function remTag(e,t){try{e.removeTag(t)}catch{}}
// ignition removed: portal must be manually relit by players
function igniteAt(d,x,y,z){return false}

/**
 * Determine if a portal atlas is in its relight pause state.
 * A portal enters a paused state after losing a life; during this time all
 * corruption, defense and tendril logic should halt until the player manually relights
 * the portal. We mark this state via the nc_broken tag. When the portal is
 * relit, onPortalOk clears this tag.
 *
 * @param {Entity} e The portal_atlas entity to check
 * @param {number} now The current game tick (unused)
 * @returns {boolean} true if the portal is currently paused (broken)
 */
export function isRelightPaused(e,now){
  return hasTag(e,TAG_BROKEN);
}
function rnd(){return(Math.random()*2-1)}
function spawnBurst(d,loc,anger){if(!LCFG.lifeMobBurst||!d||!loc)return;const n=Math.min(LCFG.lifeMobCap,LCFG.lifeMobBase+(anger|0)*LCFG.lifeMobPerAnger)|0;for(let i=0;i<n;i++){
    const id=LCFG.lifeMobs[(Math.random()*LCFG.lifeMobs.length)|0];
    const x=loc.x+rnd()*LCFG.lifeMobRange,z=loc.z+rnd()*LCFG.lifeMobRange,y=loc.y;
    try{d.spawnEntity(id,{x,y,z})}catch{}
  }
}
export function initLivesIfMissing(e){if(!LCFG.enabled||!e)return;if(getIntTag(e,TAG_LIVES,-1)<0)setIntTag(e,TAG_LIVES,LCFG.maxLives);if(getIntTag(e,TAG_ANGER,-1)<0)setIntTag(e,TAG_ANGER,0)}
export function armIfMissing(e,now){if(!LCFG.enabled||!e)return;const v=getIntTag(e,TAG_ARM,-1);if(v<0)setIntTag(e,TAG_ARM,(now|0)+LCFG.armDelayTicks)}
export function isArmed(e,now){if(!LCFG.enabled||!e)return true;return(now|0)>=getIntTag(e,TAG_ARM,0)}
export function syncPortalAggro(p){if(!LCFG.enabled||!p?.e)return;const e=p.e;let lives=getIntTag(e,TAG_LIVES,LCFG.maxLives);if(lives<0)lives=0;else if(lives>LCFG.maxLives)lives=LCFG.maxLives;const anger=Math.max(0,Math.min(LCFG.maxLives,(LCFG.maxLives-lives)|0));setIntTag(e,TAG_ANGER,anger);p.anger=anger;p.spreadMul=Math.min(1+anger*LCFG.spreadMulPerAnger,3.5);p.mobMul=Math.min(1+anger*LCFG.mobMulPerAnger,3.5)}
export function onPortalOk(p){if(!LCFG.enabled||!p?.e)return;const e=p.e;if(hasTag(e,TAG_BROKEN))remTag(e,TAG_BROKEN);syncPortalAggro(p)}
export function onPortalBroken(d,p){
  // Handle a portal break.  In this modified version the lives/anger system is
  // disabled, so breaking a portal does not pause corruption.  We simply
  // spawn a burst of mobs to mark the event.  Further cleanup and moss
  // conversion is handled by the corruption manager.
  if(!d||!p?.e) return false;
  // pick a reasonable location near the portal bounds for mob spawning
  const loc = p.e.location;
  spawnBurst(d, loc, 0);
  return false;
}

/**
 * Convert obsidian, crying obsidian and blackstone within the portal's bounds into moss blocks.
 * This runs when a portal loses its final life. We locate the portal's bounding box
 * from the stored tags (nc_b0 and nc_b1) on the atlas, then expand it slightly and
 * iterate through the volume. Any obsidian, crying obsidian or blackstone blocks
 * are replaced with moss_block. This cleanup helps illustrate the corruption receding.
 *
 * @param {Dimension} d The dimension in which the portal resides
 * @param {Entity} e The portal_atlas entity
 */
function cleanupPortalObsidian(d,e){
  if(!e||!d)return;
  // Extract bounds from tags if present
  let min=null,max=null;
  try{
    for(const t of e.getTags()){
      if(typeof t!=="string")continue;
      if(t.startsWith("nc_b0:"))min=t.slice(6);
      else if(t.startsWith("nc_b1:"))max=t.slice(6);
    }
  }catch{}
  let minX,minY,minZ,maxX,maxY,maxZ;
  if(min&&max){
    const p0=min.split(","),p1=max.split(",");
    if(p0.length>=3&&p1.length>=3){
      minX=p0[0]|0;minY=p0[1]|0;minZ=p0[2]|0;
      maxX=p1[0]|0;maxY=p1[1]|0;maxZ=p1[2]|0;
    }
  }
  // Fallback: derive a small box around the atlas if bounds missing
  if(minX==null){
    const loc=e.location;
    minX=(loc.x|0)-4;maxX=(loc.x|0)+4;
    minY=(loc.y|0)-4;maxY=(loc.y|0)+4;
    minZ=(loc.z|0)-4;maxZ=(loc.z|0)+4;
  }else{
    // Expand bounds slightly to cover supporting blocks
    minX-=4;maxX+=4;
    minY-=2;maxY+=2;
    minZ-=4;maxZ+=4;
  }
  // Iterate through the volume and convert target blocks to moss
  for(let x=minX;x<=maxX;x++){
    for(let y=minY;y<=maxY;y++){
      for(let z=minZ;z<=maxZ;z++){
        let b;
        try{b=d.getBlock({x,y,z});}catch{continue;}
        if(!b)continue;
        const id=b.typeId;
        if(id==="minecraft:obsidian"||id==="minecraft:crying_obsidian"||id==="minecraft:blackstone"){
          try{b.setType("minecraft:moss_block");}catch{}
        }
      }
    }
  }
}
export function getLives(e){return getIntTag(e,TAG_LIVES,LCFG.maxLives)}
export function getAnger(e){return getIntTag(e,TAG_ANGER,0)}
export const LivesConfig=LCFG;
