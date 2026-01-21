import{world,BlockVolume}from"@minecraft/server";
/* Gold Seal (Phase 3.3)
4 gold blocks near a portal PAUSE corruption + lives without purifying.
required: blocks needed, range: scan radius, yDown/yUp: vertical scan, every: tick period.
Tag on atlas: nc_goldseal
*/
const GCFG=Object.freeze({required:4,range:64,yDown:1,yUp:3,every:20,tag:"nc_goldseal",gold:"minecraft:gold_block"});
const gb=(d,p)=>{try{return d.getBlock(p)}catch{return}};
function countGoldBlocks(d,from,to,required){
  if(typeof d.getBlocks==="function"){
    try{
      const vol=new BlockVolume(from,to);
      const res=d.getBlocks(vol,{includeTypes:[GCFG.gold]});
      if(res?.getBlockLocationIterator){
        let count=0;
        for(const _ of res.getBlockLocationIterator()){
          if(++count>=required) return count;
        }
        return count;
      }
    }catch{}
  }
  let found=0;
  for(let x=from.x;x<=to.x;x++)for(let y=from.y;y<=to.y;y++)for(let z=from.z;z<=to.z;z++){
    const b=gb(d,{x,y,z});
    if(b&&b.typeId===GCFG.gold){if(++found>=required)break}
  }
  return found;
}
function setSealTag(e,on){if(!e)return;try{const tags=e.getTags();const has=tags.includes(GCFG.tag);if(on&&!has)e.addTag(GCFG.tag);else if(!on&&has)e.removeTag(GCFG.tag)}catch{}}
export function updateGoldSeal(d,p,t){if(!d||!p?.e)return false;if((t%GCFG.every)!==0)return!!p.sealed;const e=p.e;const cx=p.cx|0,cz=p.cz|0,by=(p.bounds?(p.bounds.minY|0):(p.cy|0));
  const from={x:cx-GCFG.range,y:by-GCFG.yDown,z:cz-GCFG.range};
  const to={x:cx+GCFG.range,y:by+GCFG.yUp,z:cz+GCFG.range};
  const found=countGoldBlocks(d,from,to,GCFG.required);
  const sealed=found>=GCFG.required;p.sealed=sealed;p.paused=sealed||!!p.pauseRelight;setSealTag(e,sealed);return sealed;
}
export function isSealed(p){return!!p?.sealed}
export const GoldSealConfig=GCFG;
