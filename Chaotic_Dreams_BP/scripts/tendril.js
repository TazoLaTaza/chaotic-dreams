import { world, system } from "@minecraft/server";

const CFG=Object.freeze({
 hostType:"chaoticdreams:flayer_tendril",
 updateEvery:3,scanHostsEvery:30,targetEvery:6,
 maxRange:42,loseRange:54,
 joints:14,segLen:1.2,iters:2,smooth:.5,
 tipSpeed:.35,retractMul:1.18,noise:.08,
 contractTicks:30,searchEvery:35,searchR0:4,searchR1:10,searchY:2.2,
 wpR:1.7,bypass:5.4,up:2.4,rayStep:.45,rayRad:.35,
 hitR:1.35,hitCd:55,witherTicks:90,darkTicks:70,
 pCore:"flayer:core",pBody:"flayed:dust_ambient",
 debug:false
});

const DIM_IDS=["overworld","nether","the_end"];
const ACTIVE=new Map();let nextScan=0;

const V=(x=0,y=0,z=0)=>({x,y,z});
const add=(a,b)=>V(a.x+b.x,a.y+b.y,a.z+b.z);
const sub=(a,b)=>V(a.x-b.x,a.y-b.y,a.z-b.z);
const mul=(v,s)=>V(v.x*s,v.y*s,v.z*s);
const len=v=>Math.hypot(v.x,v.y,v.z);
const nrm=v=>{const l=len(v)||1e-6;return mul(v,1/l)};
const lerp=(a,b,t)=>V(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t);
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);

const isValid=e=>{
 try{
  if(!e) return false;
  const proto=Object.getPrototypeOf(e);
  const iv=proto?.isValid;
  if(typeof iv==="function") return iv.call(e);
  if(typeof e.isValid==="function") return e.isValid();
  if(typeof e.isValid==="boolean") return e.isValid;
  return false;
 }catch{return false;}
};

const getPlayers=()=>{
 try{
  if(typeof world.getPlayers==="function") return [...world.getPlayers()];
  if(typeof world.getAllPlayers==="function") return [...world.getAllPlayers()];
 }catch{}
 return [];
};

const pfx=(dim,id,p)=>{
 try{ if(typeof dim.spawnParticle==="function"){ dim.spawnParticle(id,p); return; } }catch{}
 try{ if(typeof dim.runCommandAsync==="function") dim.runCommandAsync(`particle ${id} ${p.x} ${p.y} ${p.z}`); }catch{}
};

const say=m=>{if(!CFG.debug)return;try{world.sendMessage(`§7[Tendril] ${m}`)}catch{}};

const pass=id=>!id||id==="minecraft:air"||id==="minecraft:cave_air"||id==="minecraft:void_air"||id==="minecraft:water"||id==="minecraft:flowing_water"||id==="minecraft:lava"||id==="minecraft:flowing_lava";

function solidAt(dim,p){
 try{
  const b=dim.getBlock({x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)});
  if(!b) return false;
  if(typeof b.isAir==="boolean") return !b.isAir;
  return !pass(b.typeId);
 }catch{return false;}
}

// Wider LOS: checks 3 heights + 4 side offsets at each step
function rayBlockedWide(dim,a,b){
 const d=sub(b,a),L=len(d);
 if(L<CFG.rayStep) return false;
 const dir=mul(nrm(d),CFG.rayStep);
 const hs=[0,.9,-.9],r=CFG.rayRad;
 let p=add(a,dir);
 const n=(L/CFG.rayStep)|0;
 for(let i=0;i<n;i++){
  for(const hy of hs){
   const py=p.y+hy;
   if(solidAt(dim,V(p.x,py,p.z))) return true;
   if(solidAt(dim,V(p.x+r,py,p.z))||solidAt(dim,V(p.x-r,py,p.z))||solidAt(dim,V(p.x,py,p.z+r))||solidAt(dim,V(p.x,py,p.z-r))) return true;
  }
  p=add(p,dir);
 }
 return false;
}

function pickBypass(dim,from,to,side){
 const dir=nrm(sub(to,from));
 let right=nrm(V(-dir.z,0,dir.x));
 const mk=(sx,sy)=>add(from,add(mul(right,CFG.bypass*sx),V(0,sy,0)));
 const cands=[mk(side,CFG.up),mk(side,0),mk(-side,CFG.up),mk(-side,0),add(from,V(0,CFG.up*1.35,0))];
 let best=null,bs=1e30;
 for(const c of cands){
  if(solidAt(dim,c)) continue;
  if(rayBlockedWide(dim,from,c)) continue;
  const pen=rayBlockedWide(dim,c,to)?24:0;
  const sc=dist(c,to)+pen;
  if(sc<bs){bs=sc;best=c;}
 }
 return best;
}

function initChain(base){
 const pts=new Array(CFG.joints);
 for(let i=0;i<CFG.joints;i++) pts[i]=V(base.x,base.y-i*CFG.segLen,base.z);
 return pts;
}

function fabrik(pts,base,tip){
 const total=CFG.segLen*(pts.length-1),d=dist(base,tip);
 if(d>total){
  const dir=nrm(sub(tip,base)); pts[0]={...base};
  for(let i=1;i<pts.length;i++) pts[i]=add(pts[i-1],mul(dir,CFG.segLen));
  return;
 }
 const tmp=pts.map(p=>({...p}));
 for(let k=0;k<CFG.iters;k++){
  tmp[tmp.length-1]={...tip};
  for(let i=tmp.length-2;i>=0;i--){
   const d=nrm(sub(tmp[i],tmp[i+1]));
   tmp[i]=add(tmp[i+1],mul(d,CFG.segLen));
  }
  tmp[0]={...base};
  for(let i=1;i<tmp.length;i++){
   const d=nrm(sub(tmp[i],tmp[i-1]));
   tmp[i]=add(tmp[i-1],mul(d,CFG.segLen));
  }
 }
 for(let i=0;i<pts.length;i++) pts[i]=lerp(pts[i],tmp[i],1-CFG.smooth);
}

function pickTarget(host){
 const dim=host.dimension,here=host.location,r2=CFG.maxRange*CFG.maxRange;
 let best=null,bd=1e30;
 for(const p of getPlayers()){
  if(!isValid(p)) continue;
  try{ if(p.dimension.id!==dim.id) continue; }catch{ continue; }
  const l=p.location,dx=l.x-here.x,dy=l.y-here.y,dz=l.z-here.z,d2=dx*dx+dy*dy+dz*dz;
  if(d2<=r2 && d2<bd){bd=d2;best=p;}
 }
 let mobs=[];
 try{ mobs=dim.getEntities({location:here,maxDistance:CFG.maxRange,families:["mob"]})||[]; }
 catch{ try{ mobs=dim.getEntities({location:here,maxDistance:CFG.maxRange})||[]; }catch{ mobs=[]; } }
 for(const e of mobs){
  if(!isValid(e)||e.id===host.id||e.typeId==="minecraft:player") continue;
  let ok=true; try{ ok=!!e.getComponent("minecraft:health"); }catch{}
  if(!ok) continue;
  const l=e.location,dx=l.x-here.x,dy=l.y-here.y,dz=l.z-here.z,d2=dx*dx+dy*dy+dz*dz;
  if(d2<bd){bd=d2;best=e;}
 }
 return best;
}

function makeState(host){
 const hl=host.location,base=V(hl.x,hl.y+1,hl.z);
 return {host,dim:host.dimension,tr:{
  base,tip:{...base},prevTip:{...base},vel:V(),pts:initChain(base),
  target:null,targetId:"",mode:"search",modeUntil:0,nextSearch:0,searchGoal:null,nextTargetScan:0,
  wp:null,wpUntil:0,side:(Math.random()<.5?-1:1),nextLos:0,blocked:false,clearLos:0,nextHit:0
 }};
}

function setNoTarget(tr,now){
 if(tr.mode!=="retract"&&tr.mode!=="search"){tr.mode="retract";tr.modeUntil=now+CFG.contractTicks;}
 tr.target=null; tr.targetId=""; tr.wp=null; tr.wpUntil=0; tr.clearLos=0;
}

function applyHitEffects(t){
 try{ t.addEffect?.("darkness",CFG.darkTicks,{amplifier:0,showParticles:false}); }catch{}
 try{ t.addEffect?.("wither",CFG.witherTicks,{amplifier:0,showParticles:true}); }catch{}
}

function stepTendril(st){
 const h=st.host,tr=st.tr;
 if(!isValid(h)) return false;
 st.dim=h.dimension;
 const dim=st.dim,now=system.currentTick|0;

 const hl=h.location;
 tr.base=V(hl.x,hl.y+1,hl.z);

 if(now>=tr.nextTargetScan){
  tr.nextTargetScan=now+CFG.targetEvery;
  const t=pickTarget(h);
  if(t&&isValid(t)){
   if(tr.targetId!==t.id){tr.target=t;tr.targetId=t.id;tr.mode="attack";tr.wp=null;tr.wpUntil=0;tr.clearLos=0;}
  }else setNoTarget(tr,now);
 }
 if(tr.target && !isValid(tr.target)) setNoTarget(tr,now);

 let desired=tr.base,goal=null;

 if(tr.mode==="attack" && tr.target && isValid(tr.target)){
  const tl=tr.target.location;
  goal=V(tl.x,tl.y+1.2,tl.z);
  if(dist(tr.base,goal)>CFG.loseRange){setNoTarget(tr,now);}
  else{
   if(now>=tr.nextLos){
    tr.nextLos=now+3;
    tr.blocked=rayBlockedWide(dim,tr.tip,goal);
   }
   if(tr.wp && now>tr.wpUntil) tr.wp=null;

   // keep waypoint until LOS is actually clear for a bit (prevents “snap back to straight line”)
   if(tr.wp){
    if(dist(tr.tip,tr.wp)<=CFG.wpR) tr.wp=null;
    if(!tr.blocked){tr.clearLos++; if(tr.clearLos>=2) tr.wp=null;}
    else tr.clearLos=0;
   }else tr.clearLos=0;

   if(!tr.wp && tr.blocked){
    let wp=pickBypass(dim,tr.tip,goal,tr.side);
    if(!wp){tr.side*=-1; wp=pickBypass(dim,tr.tip,goal,tr.side);}
    if(wp){tr.wp=wp; tr.wpUntil=now+24;}
    else{tr.mode="retract"; tr.modeUntil=now+CFG.contractTicks;}
   }
   desired=tr.wp||goal;
  }
 }else{
  if(tr.mode==="retract"){
   desired=tr.base;
   if(now>=tr.modeUntil){tr.mode="search"; tr.nextSearch=0; tr.searchGoal=null;}
  }
  if(tr.mode==="search"){
   if(!tr.searchGoal || now>=tr.nextSearch){
    tr.nextSearch=now+CFG.searchEvery;
    const ang=Math.random()*Math.PI*2,r=CFG.searchR0+Math.random()*(CFG.searchR1-CFG.searchR0);
    tr.searchGoal=V(tr.base.x+Math.cos(ang)*r,tr.base.y+(Math.random()*.6)*CFG.searchY,tr.base.z+Math.sin(ang)*r);
   }
   desired=tr.searchGoal;
   if(rayBlockedWide(dim,tr.tip,desired)){
    const wp=pickBypass(dim,tr.tip,desired,tr.side);
    if(wp) desired=wp;
   }
  }
 }

 const n=CFG.noise,tt=(now*0.13)+((h.id?.length||3)*1.7);
 desired=V(desired.x+Math.sin(tt)*n,desired.y+Math.cos(tt*0.85)*n*0.55,desired.z+Math.sin(tt*0.92)*n);

 tr.prevTip={...tr.tip};
 const to=sub(desired,tr.tip),dir=nrm(to);
 let sp=CFG.tipSpeed*(tr.mode==="retract"?CFG.retractMul:1);
 if(tr.mode==="attack" && tr.blocked) sp*=0.85; // slows when navigating around walls
 const want=mul(dir,sp);
 tr.vel=lerp(tr.vel,want,0.3);
 tr.tip=add(tr.tip,tr.vel);

 if(solidAt(dim,tr.tip)){
  tr.tip={...tr.prevTip};
  tr.vel=mul(tr.vel,0);
  if(tr.mode==="attack" && goal && now%10===0){
   let wp=pickBypass(dim,tr.tip,goal,tr.side);
   if(!wp){tr.side*=-1; wp=pickBypass(dim,tr.tip,goal,tr.side);}
   if(wp){tr.wp=wp; tr.wpUntil=now+24;}
  }
 }

 if(tr.mode==="attack" && tr.target && isValid(tr.target)){
  const tl=tr.target.location,hit=V(tl.x,tl.y+1.0,tl.z);
  if(now>=tr.nextHit && dist(tr.tip,hit)<=CFG.hitR && !rayBlockedWide(dim,tr.tip,hit)){
   tr.nextHit=now+CFG.hitCd;
   applyHitEffects(tr.target);
  }
 }

 const maxLen=CFG.segLen*(CFG.joints-1);
 if(dist(tr.base,tr.tip)>maxLen*1.35) tr.tip=lerp(tr.tip,tr.base,0.25);

 fabrik(tr.pts,tr.base,tr.tip);

 // export points for block tendril script
 (globalThis.__cd_tpts||(globalThis.__cd_tpts=new Map())).set(h.id,{dimId:(dim?.id||"overworld"),pts:tr.pts,t:now,r:0});

 for(let i=0;i<tr.pts.length;i++){
  const p=tr.pts[i];
  if(i===0 && now%80===0) pfx(dim,CFG.pCore,p);
  else if(i>0) pfx(dim,CFG.pBody,p);
 }
 return true;
}

function scanHosts(){
 const now=system.currentTick|0;
 if(now<nextScan) return;
 nextScan=now+CFG.scanHostsEvery;
 for(const id of DIM_IDS){
  let dim; try{dim=world.getDimension(id);}catch{continue;}
  let list=[]; try{list=dim.getEntities({type:CFG.hostType})||[];}catch{list=[];}
  for(const e of list){
   if(!isValid(e)) continue;
   if(!ACTIVE.has(e.id)) ACTIVE.set(e.id,makeState(e));
  }
 }
}

system.runInterval(()=>{
 const now=system.currentTick|0;
 if(now%CFG.updateEvery) return;
 try{
  scanHosts();
  for(const [id,st] of ACTIVE) if(!stepTendril(st)) ACTIVE.delete(id);
 }catch(err){
  try{console.warn("[Tendril] tick error",err?.stack??err);}catch{}
  say(`tick error: ${err?.name||"Error"} ${err?.message||String(err)}`);
 }
},1);
