import{world,system}from"@minecraft/server";
import{isRelightPaused}from"./nether_portalLives.js";
const CFG=Object.freeze({enabled:true,tickEvery:2,opsPerTick:34,startAnger:1,mixChance:0.45,baseId:"minecraft:obsidian",mixId:"minecraft:crying_obsidian",stoneId:"minecraft:blackstone",onlyAir:true,cacheEvery:40,chunkYPad:2,chunkRMin:2,chunkRMax:6,chunkAttempts:32,domeDelay:200,domePad:6,domeMinR:18,domeOpsBase:10,domeOpsAnger:6});
const DIM="minecraft:overworld",PORTAL_ID="minecraft:portal",ANCHOR="netherlands:portal_atlas",TAG_PORTAL="nc_portal",TAG_PID="nc_pid:",TAG_ANGER="nc_anger:",TAG_R="nc_r:",TAG_B0="nc_b0:",TAG_B1="nc_b1:",TAG_SEAL="nc_goldseal";
const AIRLIKE=new Set(["minecraft:air","minecraft:cave_air","minecraft:void_air","minecraft:fire","minecraft:soul_fire"]);
const hasPrefix=(t,p)=>typeof t==="string"&&t.startsWith(p);
const gb=(d,p)=>{try{return d.getBlock(p)}catch{return}};
const isAirLike=id=>AIRLIKE.has(id);
function getStrTag(e,p){try{for(const t of e.getTags())if(hasPrefix(t,p))return t.slice(p.length)}catch{}}
function getPid(e){return getStrTag(e,TAG_PID)||e.id}
function getIntTag(e,p,d){try{for(const t of e.getTags())if(hasPrefix(t,p))return(parseInt(t.slice(p.length),10)|0)}catch{}return d|0}
function hasTag(e,t){try{return e.getTags().includes(t)}catch{return false}}
function getBounds(e){let a,b;try{for(const t of e.getTags()){if(t.startsWith(TAG_B0))a=t.slice(TAG_B0.length);else if(t.startsWith(TAG_B1))b=t.slice(TAG_B1.length)}}catch{}if(!a||!b)return;const p0=a.split(","),p1=b.split(",");if(p0.length<3||p1.length<3)return;const minX=p0[0]|0,minY=p0[1]|0,minZ=p0[2]|0,maxX=p1[0]|0,maxY=p1[1]|0,maxZ=p1[2]|0;return{minX,minY,minZ,maxX,maxY,maxZ,cx:((minX+maxX)>>1),cy:((minY+maxY)>>1),cz:((minZ+maxZ)>>1)}}
function setBlockAir(d,x,y,z,id){const b=gb(d,{x,y,z});if(!b)return false;const tid=b.typeId;if(tid===PORTAL_ID||tid==="minecraft:bedrock")return false;if(CFG.onlyAir&&!isAirLike(tid))return false;try{b.setType(id);return true}catch{return false}}
function boundsHasPortal(d,b){for(let x=b.minX;x<=b.maxX;x++)for(let y=b.minY;y<=b.maxY;y++)for(let z=b.minZ;z<=b.maxZ;z++){if(gb(d,{x,y,z})?.typeId===PORTAL_ID)return true}return false}
const U32=s=>{let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0};
const R01=s=>{s.r=(Math.imul(s.r,1664525)+1013904223)>>>0;return(s.r>>>0)/4294967296};
const RI=(s,a,b)=>a+((R01(s)*(b-a+1))|0);
const TAU=6.283185307179586;
const S=new Map();
let cache=[],nextScan=0,ci=0;
function placeChunk(d,st,b,anger,budget){const cx=b.cx|0,cz=b.cz|0;const sx=(b.maxX-b.minX+1)|0,sz=(b.maxZ-b.minZ+1)|0;const baseDist=Math.max(sx,sz)*0.5+1+Math.min(anger,3);
  const theta=R01(st)*TAU,dist=baseDist+R01(st)*2.5;const ax=(cx+Math.cos(theta)*dist)|0,az=(cz+Math.sin(theta)*dist)|0;
  let cr=(CFG.chunkRMin+R01(st)*(CFG.chunkRMax-CFG.chunkRMin+1)+(anger*0.8))|0;if(cr<CFG.chunkRMin)cr=CFG.chunkRMin;if(cr>CFG.chunkRMax+anger)cr=CFG.chunkRMax+anger;
  const y0=(b.minY-CFG.chunkYPad)|0,y1=(b.maxY+CFG.chunkYPad)|0,rr=cr*cr;
  let placed=0;for(let i=0;i<CFG.chunkAttempts&&budget>0;i++){
    const dx=RI(st,-cr,cr),dz=RI(st,-cr,cr);if(dx*dx+dz*dz>rr)continue;const x=ax+dx,z=az+dz,y=RI(st,y0,y1);
    let id=R01(st)<CFG.mixChance?CFG.mixId:CFG.baseId;if(anger>=2&&R01(st)<0.12)id=CFG.stoneId;
    if(setBlockAir(d,x,y,z,id)){placed++;budget--}
  }
  return placed;
}
function placeDome(d,st,b,anger,budget){const cx=b.cx+0.5,cz=b.cz+0.5,baseY=(b.minY-1)|0;let r=getIntTag(st.e,TAG_R,0)+CFG.domePad;if(r<CFG.domeMinR)r=CFG.domeMinR;const sx=(b.maxX-b.minX+1)|0,sz=(b.maxZ-b.minZ+1)|0;const pr=(Math.max(sx,sz)*0.5+6)|0;if(r<pr)r=pr;
  if(st.domeR<r)st.domeR=r;const R=st.domeR;let placed=0;
  while(budget>0){const u1=R01(st),u2=R01(st);const theta=u1*TAU,cosPhi=u2,sinPhi=Math.sqrt(Math.max(0,1-cosPhi*cosPhi));
    const x=(cx+R*sinPhi*Math.cos(theta))|0,z=(cz+R*sinPhi*Math.sin(theta))|0,y=(baseY+R*cosPhi)|0;
    if(y<1||y>318){budget--;continue}
    if(setBlockAir(d,x,y,z,CFG.stoneId)){placed++;budget--}else budget--;
    if(placed>=12+anger*2)break;
  }
  return placed;
}
function tick(){if(!CFG.enabled)return;const t=system.currentTick|0;if((t%CFG.tickEvery)!==0)return;let d;try{d=world.getDimension(DIM)}catch{return}
  if(t>=nextScan){try{cache=d.getEntities({type:ANCHOR,tags:[TAG_PORTAL]})??[]}catch{cache=[]}nextScan=t+CFG.cacheEvery;ci=0}
  if(!cache.length)return;let ops=0,loops=0;
  while(ops<CFG.opsPerTick&&loops<cache.length){const e=cache[ci++%cache.length];loops++;if(!e)continue;try{if(typeof e.isValid==="function"&&!e.isValid())continue}catch{continue}
    if(hasTag(e,TAG_SEAL))continue;
    const anger=getIntTag(e,TAG_ANGER,0);if(anger<CFG.startAnger){S.delete(getPid(e));continue}
    if(isRelightPaused(e,t))continue;
    const b=getBounds(e);if(!b)continue;
    if(!boundsHasPortal(d,b))continue;
    const pid=getPid(e);let st=S.get(pid);
    if(!st){st={pid,e,r:U32(pid),start:t,domeR:0};S.set(pid,st)}else st.e=e;
    let bud=Math.min(CFG.opsPerTick-ops,14);ops+=placeChunk(d,st,b,anger,bud);
    if(t-st.start>=CFG.domeDelay&&ops<CFG.opsPerTick){const domeBud=Math.min(CFG.opsPerTick-ops,CFG.domeOpsBase+anger*CFG.domeOpsAnger);
      ops+=placeDome(d,st,b,anger,domeBud);
    }
  }
}
system.runInterval(tick,1);
