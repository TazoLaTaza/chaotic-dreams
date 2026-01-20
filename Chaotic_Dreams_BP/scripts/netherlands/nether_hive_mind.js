import{world,system,GameMode}from"@minecraft/server";
import"./customComponents/fragileObsidianDecay.js";

/* Hive mind tendrils (Phase 3-2)
HM.enabled: master switch
HM.typeHive: spawning this entity starts tendrils
HM.typeAtlas/tagPortal: atlas marker used to find corruption center
HM.tagAnger/tagR: read anger + current corruption radius from atlas tags
HM.minRadius: below this corruption size, tendrils won't spawn
HM.lifeTicks: tendrils expire (30s = 600 ticks)
HM.stepEvery: move/extend frequency
HM.placeCap/removeCap: global block budget per tick (watchdog safety)
HM.maxPlaced: per-tendril hard cap of placed blocks
HM.damage/damageEvery: player damage near the tendril head
HM.maxTendrils: anger decides 1..max tendrils
HM.thickAt/thickSmall/thickBig: 2..3 block thickness based on corruption size
*/
const HM=Object.freeze({enabled:false,typeHive:"netherlands:hive_mind",typeAtlas:"netherlands:portal_atlas",tagPortal:"nc_portal",tagAnger:"nc_anger:",tagR:"nc_r:",block:"netherlands:fragile_obsidian",minRadius:20,lifeTicks:600,stepEvery:3,placeCap:72,removeCap:48,maxPlaced:5200,damage:3,damageEvery:12,maxTendrils:3,thickAt:55,thickSmall:2,thickBig:3,targetRange:96,targetsEvery:10,maxTargets:48,staggerSpawn:6,staggerEnd:20});
const AIR=new Set(["minecraft:air","minecraft:cave_air","minecraft:void_air"]);
const key=(x,y,z)=>x+"|"+y+"|"+z;
const parse=(k)=>{const[a,b,c]=k.split("|");return{x:a|0,y:b|0,z:c|0}};
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const sgn=(v)=>v>0?1:v<0?-1:0;
const dist2=(a,b)=>{const dx=a.x-b.x,dz=a.z-b.z;return dx*dx+dz*dz};
const gb=(d,p)=>{try{return d.getBlock(p)}catch{return}};
const isAir=(id)=>AIR.has(id);

function getIntTag(e,prefix,def){try{for(const t of e.getTags())if(t?.startsWith(prefix))return(parseInt(t.slice(prefix.length),10)|0)}catch{}return def|0}
function nearestAtlas(d,loc,range){let best=null,bd=1e18;let arr=[];try{arr=d.getEntities({type:HM.typeAtlas,tags:[HM.tagPortal],location:loc,maxDistance:range})??[]}catch{}for(const e of arr){const l=e.location;const dx=l.x-loc.x,dz=l.z-loc.z;const dd=dx*dx+dz*dz;if(dd<bd){bd=dd;best=e}}return best}

const ACTIVE=new Map();

function placeBlob(d,tr,x,y,z,thick,cx,cz,rr){const off=[];if(thick>=3){for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)off.push({dx,dz,dy:0});off.push({dx:0,dz:0,dy:1},{dx:0,dz:0,dy:-1})}else{off.push({dx:0,dz:0,dy:0},{dx:1,dz:0,dy:0},{dx:-1,dz:0,dy:0},{dx:0,dz:1,dy:0},{dx:0,dz:-1,dy:0},{dx:0,dz:0,dy:1},{dx:0,dz:0,dy:-1})}
  for(const o of off){if(tr.placeBudget<=0)break;const px=x+o.dx,py=y+o.dy,pz=z+o.dz;if(py<1||py>318)continue;const dx=px-cx,dz=pz-cz;if((dx*dx+dz*dz)>rr)continue;const b=gb(d,{x:px,y:py,z:pz});if(!b)continue;const id=b.typeId;if(id==="minecraft:bedrock"||id==="minecraft:portal")continue;try{b.setType(HM.block)}catch{continue}
    const k=key(px,py,pz);if(!tr.set.has(k)){tr.set.add(k);tr.list.push(k);if(tr.list.length>HM.maxPlaced)tr.over=true}
    tr.placeBudget--;
  }
}

function isSurvival(p){try{if(typeof p.getGameMode==="function")return p.getGameMode()===GameMode.survival}catch{}return true}
function pickTarget(cands,used,dimId,cx,cz,r,hx,hy,hz){let best=null,bd=1e18;const rr=r*r;for(const e of cands){if(!e)continue;try{if(e.dimension.id!==dimId)continue}catch{continue}
    if(used&&used.has(e.id))continue;
    const l=e.location;const dx=l.x-cx,dz=l.z-cz;if((dx*dx+dz*dz)>rr)continue;
    const dd=(l.x-hx)*(l.x-hx)+(l.y-hy)*(l.y-hy)+(l.z-hz)*(l.z-hz);if(dd<bd){bd=dd;best=e}}
  if(best&&used)used.add(best.id);
  return best;
}

function spawnForHive(e){if(!HM.enabled||!e)return;let d;try{d=e.dimension}catch{return}
  const atlas=nearestAtlas(d,e.location,128);if(!atlas)return;
  const r=getIntTag(atlas,HM.tagR,0);if(r<HM.minRadius)return;
  const anger=getIntTag(atlas,HM.tagAnger,1);
  const n=clamp(Math.max(1,anger|0),1,HM.maxTendrils);
  const thick=r<HM.thickAt?HM.thickSmall:HM.thickBig;
  const c=atlas.location;const cx=c.x|0,cz=c.z|0,cy=c.y|0;
  const base=e.location;const hy=(base.y|0);const now=system.currentTick|0;
  const st={id:e.id,e,dim:d,dimId:d.id,atlas,center:{x:cx,y:cy,z:cz},r,anger,n,thick,end:now+HM.lifeTicks,dead:false,ref:0,tendrils:[],tgtRef:0,targets:[]};
  const rr=r*r;
  for(let i=0;i<n;i++)system.runTimeout(()=>{if(!ACTIVE.has(st.id))return;let sx=(base.x|0)+((Math.random()*5)|0)-2,sz=(base.z|0)+((Math.random()*5)|0)-2;const dx=sx-cx,dz=sz-cz;if((dx*dx+dz*dz)>rr){sx=cx;sz=cz}
    const tr={hx:sx,hy:hy,hz:sz,set:new Set(),list:[],rm:0,dmg:0,over:false,placeBudget:8,spawn:system.currentTick|0,end:(system.currentTick|0)+HM.lifeTicks+(i*HM.staggerEnd),dead:false};
    placeBlob(d,tr,sx,hy,sz,thick,cx,cz,rr);
    st.tendrils.push(tr);
  },i*HM.staggerSpawn);
  ACTIVE.set(st.id,st);
}

world.afterEvents.entitySpawn.subscribe(ev=>{const e=ev.entity; if(e?.typeId===HM.typeHive)system.run(()=>spawnForHive(e))});

function tick(){if(!HM.enabled||!ACTIVE.size)return;const t=system.currentTick|0;let placeBudget=HM.placeCap,removeBudget=HM.removeCap;let players=[];try{players=world.getPlayers({gameMode:GameMode.survival})}catch{try{players=world.getPlayers().filter(isSurvival)}catch{players=[]}}
  for(const[id,s]of ACTIVE){const d=s.dim;let alive=true;try{alive=!(typeof s.e.isValid==="function"&&!s.e.isValid())}catch{alive=false}
    if(!alive||t>=s.end)s.dead=true;
    if(!s.dead&&t-s.ref>=20){let ok=true;try{ok=!(typeof s.atlas.isValid==="function"&&!s.atlas.isValid())}catch{ok=false}
      if(!ok){const a=nearestAtlas(d,s.center,128);if(a)s.atlas=a;else s.dead=true}
      if(!s.dead){s.r=getIntTag(s.atlas,HM.tagR,s.r);s.anger=getIntTag(s.atlas,HM.tagAnger,s.anger);s.thick=s.r<HM.thickAt?HM.thickSmall:HM.thickBig}
      s.ref=t;
    }
    const rr=s.r*s.r;
    if(!s.dead&&s.r<HM.minRadius)continue;
    if(!s.dead&&t-s.tgtRef>=HM.targetsEvery){const cands=[];for(const p of players){if(p.dimension.id!==s.dimId)continue;const l=p.location;const dx=l.x-(s.center.x+0.5),dz=l.z-(s.center.z+0.5);if((dx*dx+dz*dz)<=rr)cands.push(p)}
      let mobs=[];try{mobs=d.getEntities({families:["mob"],location:{x:s.center.x+0.5,y:s.center.y+0.5,z:s.center.z+0.5},maxDistance:Math.min(HM.targetRange,s.r+32)})??[]}catch{}
      for(const m of mobs){if(!m||m.id===s.id)continue;const l=m.location;const dx=l.x-(s.center.x+0.5),dz=l.z-(s.center.z+0.5);if((dx*dx+dz*dz)>rr)continue;const tid=m.typeId;if(tid===HM.typeHive||tid===HM.typeAtlas)continue;cands.push(m);if(cands.length>=HM.maxTargets)break}
      s.targets=cands;s.tgtRef=t
    }
    if(!s.dead&&(t%HM.stepEvery)===0){const used=new Set();
      for(const tr of s.tendrils){if(t>=tr.end)tr.dead=true;if(placeBudget<=0||tr.over||tr.dead)continue;const bud=Math.min(placeBudget,14);tr.placeBudget=bud;
        const target=pickTarget(s.targets,used,s.dimId,s.center.x+0.5,s.center.z+0.5,s.r,tr.hx+0.5,tr.hy+0.5,tr.hz+0.5);
        let nx=tr.hx,ny=tr.hy,nz=tr.hz;
        if(target){const l=target.location;const dx=l.x-(tr.hx+0.5),dy=l.y-(tr.hy+0.5),dz=l.z-(tr.hz+0.5);
          const ax=Math.abs(dx),ay=Math.abs(dy),az=Math.abs(dz);
          if(ax>=az&&ax>=ay)nx+=sgn(dx);else if(az>=ax&&az>=ay)nz+=sgn(dz);else ny+=sgn(dy);
        }else{nx+=((Math.random()*3)|0)-1;nz+=((Math.random()*3)|0)-1;ny+=((Math.random()*3)|0)-1}
        ny=clamp(ny,1,318);
        const ddx=(nx-(s.center.x|0)),ddz=(nz-(s.center.z|0));if((ddx*ddx+ddz*ddz)>rr)continue;
        tr.hx=nx;tr.hy=ny;tr.hz=nz;
        placeBlob(d,tr,nx,ny,nz,s.thick,s.center.x|0,s.center.z|0,rr);
        placeBudget-=bud-tr.placeBudget;
        if(target&&t-tr.dmg>=HM.damageEvery){const l=target.location;const dx=l.x-(nx+0.5),dy=l.y-(ny+0.5),dz=l.z-(nz+0.5);if((dx*dx+dy*dy+dz*dz)<=4){try{target.applyDamage(HM.damage)}catch{}}tr.dmg=t}
      }
    }
    for(const tr of s.tendrils)if(s.dead||t>=tr.end)tr.dead=true;
    if(s.dead||s.tendrils.some(tr=>tr.dead)){
      for(const tr of s.tendrils){if(!tr.dead)continue;while(removeBudget>0&&tr.rm<tr.list.length){const p=parse(tr.list[tr.rm++]);const b=gb(d,p);if(b&&b.typeId===HM.block){try{b.setType("minecraft:air")}catch{}}removeBudget--;if((tr.rm%6)===0)break}
      }
      let done=true;for(const tr of s.tendrils)if(tr.rm<tr.list.length)done=false;
      if(done)ACTIVE.delete(id);
    }
  }
}

system.runInterval(tick,1);
