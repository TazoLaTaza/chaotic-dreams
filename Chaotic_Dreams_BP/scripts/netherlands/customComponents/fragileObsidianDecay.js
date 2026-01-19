import{system,world}from"@minecraft/server";
/* Fragile Obsidian auto-decay (optional)
- Add to block JSON:
  "minecraft:tick":{"interval_range":[1,1],"looping":true},
  "minecraft:custom_components":["netherlands:fragile_decay"]
Config:
 ttl: ticks until auto-removal (30s=600)
 jitter: +- ticks random offset (avoid mass-removal same tick)
 sweepEvery: cleanup interval
 maxEntries: hard cap for safety
*/
const C=Object.freeze({id:"netherlands:fragile_decay",block:"netherlands:fragile_obsidian",ttl:1,jitter:40,sweepEvery:200,maxEntries:20000});
const M=new Map();
const K=(dimId,x,y,z)=>dimId+"|"+x+"|"+y+"|"+z;
const P=(k)=>{const a=k.split("|");return{dimId:a[0],x:a[1]|0,y:a[2]|0,z:a[3]|0}};
const gb=(d,p)=>{try{return d.getBlock(p)}catch{return}};
const air=(b)=>{try{b.setType("minecraft:air")}catch{}};
function mark(b,now){if(!b||b.typeId!==C.block||M.size>C.maxEntries)return;const l=b.location;const k=K(b.dimension.id,l.x|0,l.y|0,l.z|0);if(M.has(k))return;const j=((Math.random()*C.jitter*2-C.jitter)|0);M.set(k,(now|0)+C.ttl+j)}
function unmark(b){if(!b)return;const l=b.location;M.delete(K(b.dimension.id,l.x|0,l.y|0,l.z|0))}
function sweep(now){if(!M.size)return;let i=0;for(const[k,t]of M){if(t>now)continue;const p=P(k);let d;try{d=world.getDimension(p.dimId)}catch{}if(d){const b=gb(d,{x:p.x,y:p.y,z:p.z});if(b&&b.typeId===C.block)air(b)}M.delete(k);if(++i>512)break}}
function register(ev){try{ev.blockComponentRegistry.registerCustomComponent(C.id,{onPlace:e=>{const b=e.block;mark(b,system.currentTick|0)},onTick:e=>{const b=e.block;if(!b||b.typeId!==C.block)return;const now=system.currentTick|0;mark(b,now);const l=b.location;const k=K(b.dimension.id,l.x|0,l.y|0,l.z|0);const t=M.get(k);if(t!==undefined&&now>=t){air(b);M.delete(k)}},onPlayerDestroy:e=>unmark(e.block),onDestroy:e=>unmark(e.block)})}catch{}}
try{world.beforeEvents.worldInitialize.subscribe(register)}catch{}
try{system.beforeEvents?.startup?.subscribe(register)}catch{}
system.runInterval(()=>sweep(system.currentTick|0),C.sweepEvery);
export const FragileDecayConfig=C;
