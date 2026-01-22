import { system, world } from "@minecraft/server";

const CFG=Object.freeze({host:"chaoticdreams:flayer_tendril",tendrils:3,joints:14,seg:0.6,solve:2,follow:0.22,noise:0.14,smooth:0.55,range:48,interval:2,core:"flayed:dust_core",body:"flayed:dust",hit:"flayed:dust_core"});
const DIMS=["overworld","nether","the_end"];
const S=new Map();let tid=1;

const v=(x=0,y=0,z=0)=>({x,y,z});
const add=(a,b)=>v(a.x+b.x,a.y+b.y,a.z+b.z);
const sub=(a,b)=>v(a.x-b.x,a.y-b.y,a.z-b.z);
const mul=(a,s)=>v(a.x*s,a.y*s,a.z*s);
const len=a=>Math.hypot(a.x,a.y,a.z);
const nrm=a=>{const m=len(a)||1e-6;return mul(a,1/m)};
const lerp=(a,b,t)=>v(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t);
const isV=e=>{try{return !!e&&e.isValid()}catch{return false}};
const pfx=(dim,id,p)=>{try{dim.spawnParticle(id,p)}catch{try{dim.runCommandAsync(`particle ${id} ${p.x} ${p.y} ${p.z}`)}catch{}}};

function players(){try{return world.getAllPlayers?world.getAllPlayers():world.getPlayers()}catch{return[]}}
function nearestTarget(dim,from){
  const rr=CFG.range*CFG.range;let best=null,bd=1e30;
  for(const p of players()){
    if(!isV(p))continue;
    try{if(p.dimension.id!==dim.id)continue}catch{continue}
    const l=p.location,dx=l.x-from.x,dy=l.y-from.y,dz=l.z-from.z,d2=dx*dx+dy*dy+dz*dz;
    if(d2<bd&&d2<=rr){bd=d2;best=p;}
  }
  return best;
}

function initOne(root,seed,ang){
  const base=add(root,v(0,1.1,0));
  const dir=v(Math.cos(ang),0,Math.sin(ang));
  const pts=new Array(CFG.joints),prev=new Array(CFG.joints);
  for(let i=0;i<CFG.joints;i++){
    const p=add(base,mul(dir,i*CFG.seg));
    pts[i]=p;prev[i]={...p};
  }
  return {seed,ang,pts,prev,tip:{...pts[CFG.joints-1]},vel:v()};
}

function initHost(e){
  const id=e.id,dim=e.dimension,root=e.location;
  const list=[];for(let i=0;i<CFG.tendrils;i++){
    const ang=(i/CFG.tendrils)*Math.PI*2+((Math.random()*0.6)-0.3);
    list.push(initOne(root,tid++,ang));
  }
  S.set(id,{e,dim,next:0,list});
}

function solveChain(tr,root,goal,tick){
  const base=add(root,v(0,1.1,0));
  const wob=CFG.noise,tt=tick*0.18+tr.seed*0.13;
  const n=v(Math.sin(tt)*wob,Math.cos(tt*0.7)*wob*0.8,Math.sin(tt*0.9)*wob);
  const desired=add(goal,n);

  const tipDir=nrm(sub(desired,tr.tip));
  tr.vel=lerp(tr.vel,mul(tipDir,CFG.follow),0.55);
  tr.tip=add(tr.tip,tr.vel);

  let pts=tr.pts,tmp=pts.map(p=>({...p}));
  for(let k=0;k<CFG.solve;k++){
    tmp[tmp.length-1]={...tr.tip};
    for(let i=tmp.length-2;i>=0;i--){
      const d=nrm(sub(tmp[i],tmp[i+1]));
      tmp[i]=add(tmp[i+1],mul(d,CFG.seg));
    }
    tmp[0]={...base};
    for(let i=1;i<tmp.length;i++){
      const d=nrm(sub(tmp[i],tmp[i-1]));
      tmp[i]=add(tmp[i-1],mul(d,CFG.seg));
    }
  }

  for(let i=0;i<pts.length;i++){
    pts[i]=lerp(pts[i],tmp[i],1-CFG.smooth);
    tr.prev[i]=pts[i];
  }
  tr.tip={...pts[pts.length-1]};
}

function draw(dim,tr){
  for(let i=0;i<tr.pts.length;i++){
    pfx(dim,i===0?CFG.core:CFG.body,tr.pts[i]);
    if((i&3)===0)pfx(dim,CFG.hit,tr.pts[i]);
  }
}

function tick(){
  const now=system.currentTick|0;

  for(const [id,st] of S){
    if(!isV(st.e)){S.delete(id);continue}
    st.dim=st.e.dimension;
    const root=st.e.location;
    const tgt=nearestTarget(st.dim,root);
    if(!tgt)continue;
    const goal=add(tgt.location,v(0,1.2,0));
    for(const tr of st.list){
      solveChain(tr,root,goal,now);
      draw(st.dim,tr);
    }
  }
}

function scanExisting(){
  for(const did of DIMS){
    let dim;try{dim=world.getDimension(did)}catch{continue}
    let arr=[];try{arr=dim.getEntities({type:CFG.host})||[]}catch{arr=[]}
    for(const e of arr) if(isV(e)&&!S.has(e.id)) initHost(e);
  }
}

world.afterEvents?.entitySpawn?.subscribe?.(ev=>{
  const e=ev.entity;
  if(!e||e.typeId!==CFG.host) return;
  system.run(()=>{if(isV(e)) initHost(e);});
});

scanExisting();
system.runInterval(tick,CFG.interval);
