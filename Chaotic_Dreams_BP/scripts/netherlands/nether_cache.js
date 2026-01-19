const CAP=32000,TRIM=512,TTL=2400;const M=new Map();
const key=(d,x,z)=>d+":"+(x|0)+"|"+(z|0);
function trim(){if(M.size<=CAP)return;let n=TRIM;for(const k of M.keys()){M.delete(k);if(--n<=0||M.size<=CAP)break}}
export function colGet(dimId,x,z,tick){const k=key(dimId,x,z),v=M.get(k);if(!v)return;const t=tick|0;if(t-v.t>TTL){M.delete(k);return}M.delete(k);M.set(k,v);return v.y|0}
export function colSet(dimId,x,z,y,tick){const k=key(dimId,x,z);M.delete(k);M.set(k,{y:y|0,t:tick|0});trim()}
export function colSize(){return M.size}
