// flayerTendrils.js – minimal tendril system with error logging (beta 2.4.0)
import { system, world } from "@minecraft/server";

const HOST_TYPE = "chaoticdreams:flayer_tendril";
const TENDRIL_COUNT = 3;
const JOINTS = 14;
const SEG_LEN = 0.6;
const INTERVAL = 2;
const HOSTS = new Map();

// Vector helpers
const vec = (x=0,y=0,z=0)=>({x,y,z});
const add = (a,b)=>vec(a.x+b.x,a.y+b.y,a.z+b.z);
const sub = (a,b)=>vec(a.x-b.x,a.y-b.y,a.z-b.z);
const mul = (a,s)=>vec(a.x*s,a.y*s,a.z*s);
const len = a => Math.hypot(a.x,a.y,a.z);
const norm = a => { const l=len(a)||1e-6; return mul(a,1/l); };
const lerp = (a,b,t)=>vec(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t);

// Get players in current API (works in beta 2.4.0)
const getPlayers=()=>{try{return world.getAllPlayers();}catch{return world.getPlayers();}};

// Find nearest player within a range
function nearest(dim, from, range){
  let best=null, bd=range*range;
  for(const p of getPlayers()){
    if(!p?.isValid()||p.dimension.id!==dim.id) continue;
    const l=p.location, dx=l.x-from.x, dy=l.y-from.y, dz=l.z-from.z;
    const d2=dx*dx+dy*dy+dz*dz;
    if(d2<bd){bd=d2;best=p;}
  }
  return best;
}

// Initialize tendril chains for a new host
function initHost(entity){
  const tList=[];
  for(let t=0;t<TENDRIL_COUNT;t++){
    const pts=[];
    for(let i=0;i<JOINTS;i++){
      // start slightly up so it doesn’t spawn inside the mob
      pts.push(vec(entity.location.x, entity.location.y+1+i*(SEG_LEN*0.35), entity.location.z));
    }
    tList.push({pts, tip:{...pts[pts.length-1]}, vel:vec()});
  }
  HOSTS.set(entity.id,{e:entity, dim:entity.dimension, tList});
}

// FABRIK solver (no obstacle avoidance)
function solveFABRIK(pts, base, tip){
  const total=SEG_LEN*(pts.length-1);
  const d=len(sub(base,tip));
  if(d>total){
    const dir=norm(sub(tip,base));
    pts[0]={...base};
    for(let i=1;i<pts.length;i++)pts[i]=add(pts[i-1],mul(dir,SEG_LEN));
    return;
  }
  const tmp=pts.map(p=>({...p}));
  for(let k=0;k<2;k++){
    tmp[tmp.length-1]={...tip};
    for(let i=tmp.length-2;i>=0;i--){
      const dir=norm(sub(tmp[i],tmp[i+1]));
      tmp[i]=add(tmp[i+1],mul(dir,SEG_LEN));
    }
    tmp[0]={...base};
    for(let i=1;i<tmp.length;i++){
      const dir=norm(sub(tmp[i],tmp[i-1]));
      tmp[i]=add(tmp[i-1],mul(dir,SEG_LEN));
    }
  }
  for(let i=0;i<pts.length;i++)pts[i]=lerp(pts[i],tmp[i],0.45);
}

// Log helper to see errors
function log(msg){
  try{world.sendMessage(`§7[Flayer] ${msg}`);}catch{}
}

// Subscribe to spawns of the flayer entity, guarded by try/catch so errors don’t kill the script
try{
  world.afterEvents.entitySpawn.subscribe(ev=>{
    try{
      const e=ev.entity;
      if(e?.typeId===HOST_TYPE){
        initHost(e);
        log(`spawned: ${e.id}`);
      }
    }catch(ex){ log(`spawn handler error: ${ex}`); }
  });
}catch(err){ log(`entitySpawn subscription failed: ${err}`); }

// Update loop; guarded so one error doesn’t kill all updates
system.runInterval(()=>{
  try{
    for(const [id,host] of HOSTS){
      if(!host.e?.isValid()){ HOSTS.delete(id); continue; }
      const base=host.e.location;
      const target=nearest(host.dim, base, 48);
      if(!target) continue;
      const goal=vec(target.location.x, target.location.y+1.2, target.location.z);
      for(const tr of host.tList){
        // tip velocity smoothing
        const to=sub(goal,tr.tip), dir=norm(to);
        const desired=mul(dir,0.5);
        tr.vel=lerp(tr.vel,desired,0.55);
        tr.tip=add(tr.tip,tr.vel);
        // FABRIK solve and particle drawing
        solveFABRIK(tr.pts, vec(base.x, base.y+1, base.z), tr.tip);
        for(let i=0;i<tr.pts.length;i++){
          const p=tr.pts[i];
          // use your own particles or default smoke
          host.dim.spawnParticle(i===0? "minecraft:basic_smoke_particle":"minecraft:basic_smoke_particle", p);
        }
      }
    }
  }catch(ex){ log(`update error: ${ex}`); }
}, INTERVAL);
