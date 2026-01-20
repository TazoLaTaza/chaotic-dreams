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
  enabled:true,
  maxLives:3,
  armDelayTicks:400, // 20s grace before lives start
  // relightDelayTicks:300, // removed: no auto relight, portal must be manually re-ignited
  spreadMulPerAnger:0.35, // anger -> faster corruption
  mobMulPerAnger:0.30, // anger -> more spawns
  fireId:"minecraft:fire",
  angerEntity:"netherlands:portal_anger",
  hiveEntity:"netherlands:hive_mind", // spawned when lives hit 0
  lifeMobBurst:true,
  lifeMobs:["minecraft:piglin","minecraft:zombified_piglin","minecraft:hoglin","minecraft:magma_cube","minecraft:wither_skeleton"],
  lifeMobBase:2,
  lifeMobPerAnger:1,
  lifeMobCap:6,
  lifeMobRange:4
});
const TAG_LIVES="nc_lives:",TAG_ANGER="nc_anger:",TAG_ARM="nc_arm:",TAG_BROKEN="nc_broken",TAG_HIVE="nc_hive";
// bounding tags used for portal area (set by corruption manager)
const TAG_B0="nc_b0:",TAG_B1="nc_b1:";
const isAir=id=>id==="minecraft:air"||id==="minecraft:cave_air"||id==="minecraft:void_air";
const hasPrefix=(t,p)=>typeof t==="string"&&t.startsWith(p);
function getIntTag(e,prefix,def){try{for(const t of e.getTags())if(hasPrefix(t,prefix))return(parseInt(t.slice(prefix.length),10)|0)}catch{}return def|0}
function setIntTag(e,prefix,val){try{for(const t of e.getTags())if(hasPrefix(t,prefix))e.removeTag(t)}catch{}try{e.addTag(prefix+(val|0))}catch{}}
function hasTag(e,t){try{return e.getTags().includes(t)}catch{return false}}
function addTag(e,t){try{e.addTag(t)}catch{}}
function remTag(e,t){try{e.removeTag(t)}catch{}}
// ignition has been removed; portal must be manually relit by the player
function igniteAt(d,x,y,z){return false}
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
export function onPortalBroken(d,p){if(!LCFG.enabled||!d||!p?.e)return false;const e=p.e,b=p.bounds,x=b?(b.cx|0):(p.cx|0),z=b?(b.cz|0):(p.cz|0),y=b?(b.minY|0):(p.cy|0),now=system.currentTick|0;
  const livesNow=getIntTag(e,TAG_LIVES,LCFG.maxLives);
  if(livesNow<=0){syncPortalAggro(p);return true}
  if(hasTag(e,TAG_BROKEN)){syncPortalAggro(p);return getIntTag(e,TAG_LIVES,LCFG.maxLives)<=0}
  addTag(e,TAG_BROKEN);
  let lives=livesNow-1;if(lives<0)lives=0;setIntTag(e,TAG_LIVES,lives);
  const anger=Math.max(0,Math.min(LCFG.maxLives,(LCFG.maxLives-lives)|0));
  try{d.spawnEntity(LCFG.angerEntity,e.location)}catch{}
  spawnBurst(d,e.location,anger);
  // spawn hive when the portal loses its first life and hasn't spawned yet
  if(anger>=1&&!hasTag(e,TAG_HIVE)){addTag(e,TAG_HIVE);try{d.spawnEntity(LCFG.hiveEntity,e.location)}catch{}}
  // if no lives remain, clean up protective shell (obsidian and crying obsidian) around the portal
  if(lives<=0)cleanupPortalObsidian(d,e);
  syncPortalAggro(p);
  return lives<=0;
}
// determine if portal is currently in a relight pause: true if it is broken (lost a life) and not yet relit
export function isRelightPaused(e,now){if(!LCFG.enabled||!e)return false;return hasTag(e,TAG_BROKEN)}
// remove obsidian and crying obsidian blocks surrounding a dead portal
function cleanupPortalObsidian(d,e){if(!d||!e)return;let b0,b1;try{for(const t of e.getTags()){if(t.startsWith(TAG_B0))b0=t.slice(TAG_B0.length);else if(t.startsWith(TAG_B1))b1=t.slice(TAG_B1.length)}}catch{}if(!b0||!b1)return;
  const a=b0.split(","),b=b1.split(",");if(a.length<3||b.length<3)return;const minX=a[0]|0,minY=a[1]|0,minZ=a[2]|0,maxX=b[0]|0,maxY=b[1]|0,maxZ=b[2]|0;
  const pad=6;
  const x1=minX-pad,y1=minY-pad,z1=minZ-pad,x2=maxX+pad,y2=maxY+pad,z2=maxZ+pad;
  try{d.runCommandAsync?.(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} air replace minecraft:obsidian`)}catch{try{d.runCommandAsync(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} air replace minecraft:obsidian`)}catch{}}
  try{d.runCommandAsync?.(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} air replace minecraft:crying_obsidian`)}catch{try{d.runCommandAsync(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} air replace minecraft:crying_obsidian`)}catch{}}
}
export function getLives(e){return getIntTag(e,TAG_LIVES,LCFG.maxLives)}
export function getAnger(e){return getIntTag(e,TAG_ANGER,0)}
export const LivesConfig=LCFG;
