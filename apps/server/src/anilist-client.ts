/** Shared, server-owned budget for optional AniList consumers. No credentials or profile data. */
export class AniListClient {
  private requests:number[]=[];
  private retryAt=0;
  private active=0;
  private abort=new AbortController();
  constructor(private fetcher:typeof fetch=fetch,private now=Date.now){}
  get available(){
    this.requests=this.requests.filter(t=>t>this.now()-60_000);
    return !this.abort.signal.aborted&&this.active<4&&this.requests.length<20&&this.retryAt<=this.now();
  }
  close(){this.abort.abort();}
  async graphql(query:string,variables:object,signal?:AbortSignal,limit=1024*1024):Promise<any>{
    signal?.throwIfAborted();
    if(!this.available)throw Error('anilist-busy');
    this.requests.push(this.now());this.active++;
    const signals=[this.abort.signal,AbortSignal.timeout(8000),...(signal?[signal]:[])];
    try{
      const response=await this.fetcher('https://graphql.anilist.co',{
        method:'POST',redirect:'error',signal:AbortSignal.any(signals),
        headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({query,variables})
      });
      if(response.status===429||response.headers.get('x-ratelimit-remaining')==='0'){
        const value=response.headers.get('retry-after')||'';
        const retry=Number.isFinite(Number(value))?Number(value)*1000:Date.parse(value)-this.now();
        const reset=Number(response.headers.get('x-ratelimit-reset'))*1000-this.now();
        this.retryAt=Math.max(this.retryAt,this.now()+Math.min(3600_000,Math.max(60_000,Number.isFinite(retry)?retry:0,Number.isFinite(reset)?reset:0)));
      }
      if(!response.ok){await response.body?.cancel();throw Error('anilist-unavailable');}
      const reader=response.body?.getReader();if(!reader)throw Error('anilist-empty');
      const chunks:Uint8Array[]=[];let total=0;
      try{
        for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit)throw Error('anilist-response-limit');chunks.push(value);}
      }finally{await reader.cancel().catch(()=>{});}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(body.errors?.length||!body.data)throw Error('anilist-invalid-response');
      return body.data;
    }finally{this.active--;}
  }
}
