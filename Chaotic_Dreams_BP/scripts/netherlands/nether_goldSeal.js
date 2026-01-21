import{BlockVolume}from"@minecraft/server";
/* Gold Seal (optimized)
4 gold blocks near a portal pauses corruption (and anything keying off nc_goldseal).
Uses portal bounds instead of a fixed huge radius scan.
*/
const GCFG=Object.freeze({required:4,pad:3,padY:2,every:20,tag:"nc_goldseal",gold:"minecraft:gold_block",fallbackR:8,fallbackYDown:3,fallbackYUp:8});
const TAG_B0="nc_b0:",TAG_B1="nc_b1:";
const gb=(d,p)=>{try{return d.getBlock(p)}catch{return}};
const min=(a,b)=>a<b?a:b,max=(a,b)=>a>b?a:b;
function readBoundsFromTags(e){
  try{
    let b0="",b1="";
    for(const t of e.getTags()){
      if(!b0&&t.startsWith(TAG_B0)) b0=t.slice(TAG_B0.length);
      else if(!b1&&t.startsWith(TAG_B1)) b1=t.slice(TAG_B1.length);
      if(b0&&b1) break;
    }
    if(!b0||!b1) return null;
    const a=b0.split(","),c=b1.split(",");
    if(a.length<3||c.length<3) return null;
    const x0=a[0]|0,y0=a[1]|0,z0=a[2]|0,x1=c[0]|0,y1=c[1]|0,z1=c[2]|0;
    return{minX:min(x0,x1),minY:min(y0,y1),minZ:min(z0,z1),maxX:max(x0,x1),maxY:max(y0,y1),maxZ:max(z0,z1)};
  }catch{return null}
}
function sealBox(p){
  const b=p.bounds||readBoundsFromTags(p.e);
  if(b){
    const pad=GCFG.pad,padY=GCFG.padY;
    return{
      from:{x:(b.minX|0)-pad,y:(b.minY|0)-padY,z:(b.minZ|0)-pad},
      to:{x:(b.maxX|0)+pad,y:(b.maxY|0)+padY,z:(b.maxZ|0)+pad}
    };
  }
  const cx=p.cx|0,cy=p.cy|0,cz=p.cz|0,r=GCFG.fallbackR;
  return{from:{x:cx-r,y:cy-GCFG.fallbackYDown,z:cz-r},to:{x:cx+r,y:cy+GCFG.fallbackYUp,z:cz+r}};
}
function countGoldBlocks(d,from,to,required){
  if(typeof d.getBlocks==="function"){
    try{
      const res=d.getBlocks(new BlockVolume(from,to),{includeTypes:[GCFG.gold]},true);
      const it=res?.getBlockLocationIterator?.();
      if(it){
        let c=0;
        for(const _ of it) if(++c>=required) return c;
        return c;
      }
    }catch{}
  }
  let found=0;
  for(let x=from.x;x<=to.x;x++)for(let y=from.y;y<=to.y;y++)for(let z=from.z;z<=to.z;z++){
    const b=gb(d,{x,y,z});
    if(b?.typeId===GCFG.gold&&++found>=required) return found;
  }
  return found;
}
function setSealTag(e,on){
  if(!e) return;
  try{
    const tags=e.getTags(),has=tags.includes(GCFG.tag);
    if(on&&!has) e.addTag(GCFG.tag);
    else if(!on&&has) e.removeTag(GCFG.tag);
  }catch{}
}
export function updateGoldSeal(d,p,t){
  if(!d||!p?.e) return false;
  if((t%GCFG.every)!==0) return !!p.sealed;
  const {from,to}=sealBox(p);
  const sealed=countGoldBlocks(d,from,to,GCFG.required)>=GCFG.required;
  p.sealed=sealed;
  p.paused=sealed||!!p.pauseRelight;
  setSealTag(p.e,sealed);
  return sealed;
}
export function isSealed(p){return!!p?.sealed}
export const GoldSealConfig=GCFG;
