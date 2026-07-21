import { openSync, readSync, statSync } from "node:fs";
import { MatroskaDemuxer } from "../src/demux/matroska.js";
import { Reader, readId, readSize } from "../src/demux/ebml.js";
class S{constructor(p){this.fd=openSync(p,"r");this.size=statSync(p).size}
 async read(o,l){const n=Math.min(l,this.size-o);if(n<=0)return new Uint8Array(0);const b=Buffer.allocUnsafe(n);readSync(this.fd,b,0,n,o);return new Uint8Array(b.buffer,b.byteOffset,n)}}
for(const f of ["houshi.mkv","mozahngtantexiaoass.mkv"]){
  const dx=await new MatroskaDemuxer(new S("D:/xiaochengxu/webplayer/"+f)).parseHeader();
  // re-read Tracks raw and dump Video child element IDs
  const v=dx.tracks.find(t=>t.type===1);
  console.log(`\n=== ${f} ===`);
  console.log("  container colour object:", JSON.stringify(v.video.colour));
  // scan hvcC -> SPS -> is there VUI colour? just report SPS presence + nal array
  const cp=v.codecPrivate;
  const numArrays=cp[22];
  let p=23; const kinds=[];
  for(let i=0;i<numArrays;i++){
    const nalType=cp[p]&0x3f; const cnt=(cp[p+1]<<8)|cp[p+2]; p+=3;
    let tot=0;
    for(let j=0;j<cnt;j++){const len=(cp[p]<<8)|cp[p+1];p+=2+len;tot+=len;}
    kinds.push(`type${nalType}x${cnt}(${tot}B)`);
  }
  console.log("  hvcC NAL arrays:", kinds.join(" "), " (32=VPS 33=SPS 34=PPS 39=SEI)");
  console.log("  hvcC总长:", cp.length);
}
