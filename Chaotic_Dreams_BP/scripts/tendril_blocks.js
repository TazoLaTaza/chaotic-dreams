import { world, system, BlockPermutation } from "@minecraft/server";

const CFG={blockId:"netherlands:fragile_obsidian",airId:"minecraft:air",interval:8,lineStep:.75,baseMax:140,perR:90,stale:30,onlyAir:true,dbg:false};
let OBS=null,AIR=null,errNext=0,lastErr="";
try{OBS=BlockPermutation.resolve(CFG.blockId);}catch(e){lastErr=`resolve ${CFG.blockId}: ${e}`;}
try{AIR=BlockPermutation.resolve(CFG.airId);}catch(e){lastErr=`resolve ${CFG.airId}: ${e}`;}

const normDim=id=>String(id||"overworld").replace("minecraft:","");
const getDim=id=>{try{return world.getDimension(normDim(id))}catch{try{return world.getDimension(String(id))}catch{return null}}};
const msg=t=>{if(!CFG.dbg)return;try{world.sendMessage(`§7[TBlocks] ${t}`)}catch{}};
const key=(x,y,z)=>x+","+y+","+z;
const isAir=b=>{try{return !!b&&(b.isAir===true||b.typeId===CFG.airId||b.typeId==="minecraft:cave_air"||b.typeId==="minecraft:void_air")}catch{return false}};
const isSame=b=>{try{return b?.typeId===CFG.blockId}catch{return false}};
const safe=(tag,fn)=>{
 try{return fn()}
 catch(e){
  lastErr=`${tag}: ${e?.name||"Error"} ${e?.message||String(e)}`;
  const now=system.currentTick|0;
  if(now>=errNext){errNext=now+40;msg(lastErr)}
  try{console.warn("[TBlocks]",tag,e?.stack||e)}catch{}
  return null
 }
};

function setBlock(dim,x,y,z,place){
 return safe("setBlock",()=>{
  const b=dim.getBlock({x,y,z}); if(!b) return false;
  if(place){
   if(CFG.onlyAir && !isAir(b)) return false;
   if(OBS && typeof b.setPermutation==="function"){b.setPermutation(OBS);return true;}
   if(typeof b.setType==="function"){b.setType(CFG.blockId);return true;}
   if(typeof dim.runCommandAsync==="function"){dim.runCommandAsync(`setblock ${x} ${y} ${z} ${CFG.blockId}`);return true;}
   return false;
  }else{
   if(!isSame(b)) return false;
   if(AIR && typeof b.setPermutation==="function"){b.setPermutation(AIR);return true;}
   if(typeof b.setType==="function"){b.setType(CFG.airId);return true;}
   if(typeof dim.runCommandAsync==="function"){dim.runCommandAsync(`setblock ${x} ${y} ${z} ${CFG.airId}`);return true;}
   return false;
  }
 });
}

function addLine(a,b,out,max){
 const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,L=Math.hypot(dx,dy,dz);
 if(L<.1) return;
 const n=Math.min(160,Math.max(1,(L/CFG.lineStep)|0));
 for(let i=0;i<=n;i++){
  const t=i/n;
  const x=Math.floor(a.x+dx*t),y=Math.floor(a.y+dy*t),z=Math.floor(a.z+dz*t);
  out.add(key(x,y,z));
  if(out.size>=max) return;
 }
}

function thicken(posKey,r,out,max){
 if(r<=0){out.add(posKey);return;}
 const [x0,y0,z0]=posKey.split(",").map(n=>+n);
 for(let dx=-r;dx<=r;dx++)for(let dz=-r;dz<=r;dz++)for(let dy=0;dy<=Math.min(1,r);dy++){
  if(dx*dx+dz*dz>r*r) continue;
  out.add(key(x0+dx,y0+dy,z0+dz));
  if(out.size>=max) return;
 }
}

const STATE=new Map(); // hostId -> {dimId,last:Set<string>}
world.afterEvents?.scriptEventReceive?.subscribe?.(ev=>{
 if(ev.id!=="cd:tblocks") return;
 const m=String(ev.message||"").trim().toLowerCase();
 if(m==="dbg"){CFG.dbg=!CFG.dbg;msg(`dbg=${CFG.dbg}`);}
 if(m==="ping"){
  const src=globalThis.__cd_tpts;
  msg(`ptsMap=${src&&typeof src.forEach==="function"?"ok":"missing"} hosts=${STATE.size} perm=${!!OBS}`);
  if(lastErr) msg(`lastErr=${lastErr}`);
 }
 if(m==="clean"){
  for(const [hid,s] of STATE){
   const dim=getDim(s.dimId); if(!dim) continue;
   for(const k of s.last){const [x,y,z]=k.split(",").map(n=>+n);setBlock(dim,x,y,z,false);}
  }
  STATE.clear(); msg("cleaned");
 }
});

function tick(){
 const now=system.currentTick|0;
 const src=globalThis.__cd_tpts;
 if(!src||typeof src.forEach!=="function") return;

 const alive=new Set();
 src.forEach((d,hid)=>{
  if(!d||!d.pts||d.pts.length<2) return;
  if((now-((d.t|0)))>CFG.stale) return;
  alive.add(hid);

  const dim=getDim(d.dimId); if(!dim) return;
  const r=Math.max(0,Math.min(3,(d.r|0)));
  const max=CFG.baseMax+r*CFG.perR;

  const core=new Set();
  for(let i=0;i<d.pts.length-1;i++){
   addLine(d.pts[i],d.pts[i+1],core,max);
   if(core.size>=max) break;
  }
  const want=new Set();
  for(const k of core){thicken(k,r,want,max); if(want.size>=max) break;}

  const prev=STATE.get(hid)?.last||new Set();
  for(const k of prev) if(!want.has(k)){const [x,y,z]=k.split(",").map(n=>+n);setBlock(dim,x,y,z,false);}
  for(const k of want) if(!prev.has(k)){const [x,y,z]=k.split(",").map(n=>+n);setBlock(dim,x,y,z,true);}

  STATE.set(hid,{dimId:d.dimId,last:want});
 });

 for(const [hid,s] of STATE){
  if(alive.has(hid)) continue;
  const dim=getDim(s.dimId); if(dim) for(const k of s.last){const [x,y,z]=k.split(",").map(n=>+n);setBlock(dim,x,y,z,false);}
  STATE.delete(hid);
 }
}

system.runInterval(()=>safe("tick",tick),CFG.interval);
