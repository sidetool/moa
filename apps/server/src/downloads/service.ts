import { randomUUID } from 'node:crypto';
import { access, constants, lstat, mkdir, readdir, rm, stat, statfs, realpath } from 'node:fs/promises';
import path from 'node:path';
import { publicStream, type SourceVideo } from '../sources/extensions/index.js';
import type { DownloadJob, DownloadStatus, DownloadQuality } from '@moa/shared';
import type { Store } from '../db.js';
import type { Sources } from '../sources/service.js';
import type { Config } from '../config.js';
import type { Playback } from '../playback/service.js';
import { KidsPolicy } from '../profiles/kids.js';
import { APK_RELAY } from '../sources/apk-bridge.js';
import { ApiFailure, hash, safePath, contained } from '../util.js';
import { DOWNLOAD_QUALITIES, preferredQuality, qualityHeight } from './quality.js';
import { transferVideo } from './transfer.js';

const MAX_QUEUED_DOWNLOADS=500;
const activeStates=['queued','resolving','downloading','finalizing'];
const terminal=['failed','cancelled','interrupted'];
const fingerprint=(v:SourceVideo)=>hash(JSON.stringify([v.quality||'',(()=>{try{return new URL(v.originalUrl||v.url).origin;}catch{return '';}})(),(v.audios||[]).map(a=>a.label)]));
export class Downloads {
  private choicesCache=new Map<string,{episode:string;profile:string;until:number;choices:Map<string,{fingerprint:string;quality:string}>}>();
  private running?:{id:string;abort:AbortController;promise:Promise<void>};
  private untrackedBytes=0;
  private timer?:NodeJS.Timeout;
  private mayRun=()=>true;
  start(mayRun=()=>true){this.mayRun=mayRun;if(!this.timer){this.timer=setInterval(()=>this.pump(),1000);this.timer.unref();}this.pump();}
  private configuring: Promise<void> = Promise.resolve();
  private closed=false; private paused=false; private setup=false;
  private kids:KidsPolicy;
  private opening=new Map<string,number>();
  private deleting=new Set<string>();
  constructor(private db:Store,private cfg:Config,private sources:Sources,private playback:Playback,private transport=publicStream){
    this.kids=new KidsPolicy(db);
    db.db.exec(`CREATE TABLE IF NOT EXISTS download_jobs(id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
      media_id TEXT NOT NULL,source_id TEXT NOT NULL,profile_id TEXT NOT NULL,state TEXT NOT NULL,quality TEXT NOT NULL,selection TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,total_bytes INTEGER,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS download_episode_live ON download_jobs(episode_id) WHERE state IN ('queued','resolving','downloading','finalizing','ready');
      CREATE TABLE IF NOT EXISTS download_assets(episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE RESTRICT,job_id TEXT NOT NULL UNIQUE REFERENCES download_jobs(id) ON DELETE RESTRICT,path TEXT NOT NULL,size INTEGER NOT NULL,probe TEXT NOT NULL,subtitles TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS download_jobs_state ON download_jobs(state);
      CREATE INDEX IF NOT EXISTS download_jobs_page ON download_jobs(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS download_jobs_media_page ON download_jobs(media_id,created_at DESC,id DESC);`);
  }
  get busy(){return Boolean(this.running);}
  quota(){return Number(this.db.get("SELECT value FROM admin_settings WHERE key='downloadQuota'")?.value)||0;}
  used(){return this.untrackedBytes+(this.db.get('SELECT COALESCE(SUM(size),0) AS n FROM download_assets')!.n as number);}
  private async storage(){
    if(!this.cfg.downloadRoot)throw new ApiFailure(503,'download-storage-unconfigured');
    const root=await realpath(this.cfg.downloadRoot).catch(()=>{throw new ApiFailure(503,'download-storage-unavailable');});
    for(const excluded of [this.cfg.dataDir,this.cfg.mediaRoot]){
      const p=await realpath(excluded).catch(()=>path.resolve(excluded));
      if(contained(p,root)||contained(root,p))throw new ApiFailure(503,'download-storage-overlap');
    }
    if(!(await stat(root)).isDirectory())throw new ApiFailure(503,'download-storage-unavailable');
    await access(root,constants.W_OK);return root;
  }
  async initialize(){
    this.untrackedBytes=0;
    this.db.run("UPDATE download_jobs SET state='interrupted',error='download-interrupted',updated_at=? WHERE state IN ('resolving','downloading','finalizing')",new Date().toISOString());
    try{
      const root=await this.storage();
      for(const entry of await readdir(root,{withFileTypes:true})){
        if(!/^job-[0-9a-f-]{36}$/.test(entry.name))continue;
        const known=this.db.get('SELECT 1 FROM download_assets WHERE job_id=?',entry.name.slice(4));
        if(!known){
          const job=this.db.get('SELECT state FROM download_jobs WHERE id=?',entry.name.slice(4));
          if(job&&job.state!=='ready')await rm(path.join(root,entry.name),{recursive:true,force:true});
          else if(entry.isDirectory())for(const file of await readdir(path.join(root,entry.name))){const st=await lstat(path.join(root,entry.name,file));if(st.isFile())this.untrackedBytes+=st.size;}
        }
      }
      for(const a of this.db.all('SELECT episode_id FROM download_assets'))await this.asset(a.episode_id);
    }catch{/* Optional mount absent: retain metadata for the next mount/restart. */}
    this.setup=true;
    // Queued work stays durable. The host starts it only after checking maintenance leases.
  }
  configure(bytes:number){if(!Number.isSafeInteger(bytes)||bytes<1||bytes>1000*1024**4)throw new ApiFailure(400,'download-quota-invalid');if(this.busy||bytes<this.used())throw new ApiFailure(409,'download-quota-in-use');this.db.run("INSERT OR REPLACE INTO admin_settings VALUES('downloadQuota',?)",String(bytes));}
  enabled(){return this.db.get("SELECT value FROM admin_settings WHERE key='downloadEnabled'")?.value==='true';}
  quality():DownloadQuality {const value=this.db.get("SELECT value FROM admin_settings WHERE key='downloadQuality'")?.value;return DOWNLOAD_QUALITIES.includes(value)?value:'1080p';}
  configureSettings(patch:{enabled?:boolean;quality?:DownloadQuality;quotaBytes?:number}):Promise<void>{
    const operation=this.configuring.then(async()=>{
      if(!patch||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!['enabled','quality','quotaBytes'].includes(k))||
        patch.enabled!==undefined&&typeof patch.enabled!=='boolean'||patch.quality!==undefined&&!DOWNLOAD_QUALITIES.includes(patch.quality))throw new ApiFailure(400,'download-config-invalid');
      if(patch.enabled===true){
        if(this.cfg.downloadsEnabled===false)throw new ApiFailure(503,'download-disabled');
        await this.storage();
        if(!(patch.quotaBytes??this.quota()))throw new ApiFailure(503,'download-quota-unconfigured');
      }
      this.db.transaction(()=>{
        if(patch.quotaBytes!==undefined)this.configure(patch.quotaBytes);
        if(patch.quality!==undefined)this.db.run("INSERT OR REPLACE INTO admin_settings VALUES('downloadQuality',?)",patch.quality);
        if(patch.enabled!==undefined)this.db.run("INSERT OR REPLACE INTO admin_settings VALUES('downloadEnabled',?)",String(patch.enabled));
        if(patch.enabled===false)this.db.run("UPDATE download_jobs SET state='interrupted',error='download-disabled',updated_at=? WHERE state='queued'",new Date().toISOString());
      });
      if(patch.enabled===false){this.choicesCache.clear();if(this.running){this.running.abort.abort();await this.running.promise;}}
      this.pump();
    });
    this.configuring=operation.catch(()=>{});return operation;
  }
  private job(id:string):DownloadJob{
    const r=this.db.get(`SELECT j.*,m.title,e.title AS episode_title FROM download_jobs j JOIN media m ON m.id=j.media_id JOIN episodes e ON e.id=j.episode_id WHERE j.id=?`,id);
    if(!r)throw new ApiFailure(404,'download-not-found');
    return {id:r.id,episodeId:r.episode_id,mediaId:r.media_id,title:r.title,episodeTitle:r.episode_title,state:r.state,bytes:r.bytes,totalBytes:r.total_bytes,error:r.error,quality:r.quality,createdAt:r.created_at,updatedAt:r.updated_at};
  }
  async status(query:{cursor?:string;mediaId?:string}={}):Promise<DownloadStatus>{
    const media=query.mediaId??null;
    if(media!==null&&(typeof media!=='string'||!media||media.length>512))throw new ApiFailure(400,'download-query-invalid');
    let boundary:{time:string;id:string}|undefined;
    if(query.cursor!==undefined){
      try{
        if(typeof query.cursor!=='string'||query.cursor.length>2048)throw Error();
        const cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());
        if(cursor.media!==media||typeof cursor.time!=='string'||cursor.time.length>64||typeof cursor.id!=='string'||cursor.id.length>128||!cursor.id)throw Error();
        boundary=cursor;
      }catch{throw new ApiFailure(400,'download-query-invalid');}
    }
    const where:string[]=[],args:string[]=[];
    if(media){where.push('media_id=?');args.push(media);}
    const filter=where.length?`WHERE ${where.join(' AND ')}`:'';
    const totalJobs=this.db.get(`SELECT COUNT(*) AS n FROM download_jobs ${filter}`,...args)!.n as number;
    if(boundary){where.push('(created_at<? OR (created_at=? AND id<?))');args.push(boundary.time,boundary.time,boundary.id);}
    const rows=this.db.all(`SELECT id,created_at FROM download_jobs ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY created_at DESC,id DESC LIMIT 201`,...args);
    const page=rows.slice(0,200),last=page.at(-1);
    let reason:string|null=null,storageReady=false;
    try{await this.storage();storageReady=true;if(this.cfg.downloadsEnabled===false||!this.enabled())reason='download-disabled';else if(!this.quota())reason='download-quota-unconfigured';}
    catch(e){reason=e instanceof ApiFailure?e.error:'download-storage-unavailable';}
    // Materialize rows before any further asynchronous work so concurrent deletion cannot
    // make an otherwise valid status response fail halfway through.
    const jobs=page.filter(r=>this.db.get('SELECT 1 FROM download_jobs WHERE id=?',r.id)).map(r=>this.job(r.id));
    return{enabled:this.enabled(),allowed:this.cfg.downloadsEnabled!==false,storageReady,quality:this.quality(),configured:!reason,reason,quotaBytes:this.quota(),usedBytes:this.used(),jobs,totalJobs,activeJobs:this.db.get("SELECT COUNT(*) AS n FROM download_jobs WHERE state IN ('queued','resolving','downloading','finalizing')")!.n as number,
      nextCursor:rows.length>200&&last?Buffer.from(JSON.stringify({media,time:last.created_at,id:last.id})).toString('base64url'):null};
  }

  episode(episode:string,profile:string){const r=this.db.get('SELECT media_id FROM episodes WHERE id=?',episode);if(!r)throw new ApiFailure(404,'episode-not-found');this.kids.assert(r.media_id,profile);const j=this.db.get('SELECT id FROM download_jobs WHERE episode_id=? ORDER BY updated_at DESC LIMIT 1',episode);return{saved:Boolean(this.db.get('SELECT 1 FROM download_assets WHERE episode_id=?',episode)),...(j?{job:this.job(j.id)}:{})};}
  private assertRequest(episode:string,profile:string){
    if(this.closed||this.paused||!this.setup)throw new ApiFailure(503,'download-paused');
    if(this.cfg.downloadsEnabled===false||!this.enabled())throw new ApiFailure(503,'download-disabled');
    if(!this.db.get('SELECT 1 FROM profiles WHERE id=?',profile))throw new ApiFailure(401,'profile-required');
    if(!this.quota())throw new ApiFailure(503,'download-quota-unconfigured');
    const mapping=this.sources.remoteEpisode(episode);if(!mapping)throw new ApiFailure(404,'episode-not-found');this.kids.assert(mapping.media_id,profile);
    if(this.sources.row(mapping.source_id).live)throw new ApiFailure(422,'download-live-unsupported');return mapping;
  }
  async choices(episode:string,profile:string){
    this.assertRequest(episode,profile);await this.storage();
    const videos=await this.sources.videos(episode);
    try{
      this.assertRequest(episode,profile);
      const choices=new Map<string,{fingerprint:string;quality:string}>();
      const counts=new Map<string,number>();for(const v of videos)counts.set(fingerprint(v),(counts.get(fingerprint(v))||0)+1);
      for(const v of videos){if(!v.url.startsWith('https:')||v.audios?.length||counts.get(fingerprint(v))!==1)continue;choices.set(randomUUID(),{fingerprint:fingerprint(v),quality:v.quality||'기본 화질'});}
      if(!choices.size)throw new ApiFailure(422,'download-stream-unsupported');
      const selectionToken=randomUUID();for(const [k,v] of this.choicesCache)if(v.until<Date.now())this.choicesCache.delete(k);
      if(this.choicesCache.size>=32)this.choicesCache.delete(this.choicesCache.keys().next().value!);
      this.choicesCache.set(selectionToken,{episode,profile,until:Date.now()+120_000,choices});
      return{selectionToken,choices:[...choices].map(([id,v])=>({id,label:v.quality}))};
    }finally{await this.sources.apk.release(videos.apkLease);}
  }
  async create(episode:string,profile:string,token:string,choiceId:string){
    this.assertRequest(episode,profile);await this.storage();
    this.assertRequest(episode,profile);
    const pick=this.choicesCache.get(token),choice=pick?.choices.get(choiceId);
    if(!pick||pick.profile!==profile||pick.episode!==episode||pick.until<Date.now()||!choice)throw new ApiFailure(410,'download-selection-expired');
    const job=this.enqueue(episode,profile,choice.quality,choice.fingerprint);
    this.choicesCache.delete(token);return job;
  }
  async createPreferred(episode:string,profile:string){
    this.assertRequest(episode,profile);await this.storage();
    const preference=this.quality();
    return this.enqueue(episode,profile,preference==='best'?'최고 화질':preference,`auto:${preference}`);
  }
  private batchScope(mediaId:string,profile:string,season?:number){
    if(typeof mediaId!=='string'||!mediaId||mediaId.length>512||season!==undefined&&(!Number.isSafeInteger(season)||season<0||season>10000))throw new ApiFailure(400,'download-query-invalid');
    const rows=this.db.all(`SELECT id FROM episodes WHERE media_id=? ${season===undefined?'':'AND season=?'} ORDER BY season,number,id`,mediaId,...(season===undefined?[]:[season]));
    if(!rows.length)throw new ApiFailure(404,'episode-not-found');
    this.assertRequest(rows[0].id,profile);
    const live=new Set(this.db.all("SELECT episode_id FROM download_jobs WHERE media_id=? AND state IN ('queued','resolving','downloading','finalizing','ready')",mediaId).map(r=>r.episode_id));
    return {total:rows.length,eligible:rows.filter(r=>!live.has(r.id)),skipped:rows.filter(r=>live.has(r.id)).length};
  }
  previewBatch(mediaId:string,profile:string,season?:number){
    const scope=this.batchScope(mediaId,profile,season);
    return {total:scope.total,eligible:scope.eligible.length,skipped:scope.skipped};
  }
  async createBatch(mediaId:string,profile:string,season?:number){
    this.batchScope(mediaId,profile,season);await this.storage();
    // Re-read after async work and insert atomically. Simultaneous clicks cannot create duplicate jobs.
    let result!:{total:number;added:number;skipped:number};
    this.db.transaction(()=>{
      const scope=this.batchScope(mediaId,profile,season);
      const queued=this.db.get("SELECT COUNT(*) AS n FROM download_jobs WHERE state='queued'")!.n as number;
      if(queued+scope.eligible.length>MAX_QUEUED_DOWNLOADS)throw new ApiFailure(429,'download-queue-full');
      const preference=this.quality(),now=new Date().toISOString();
      for(const row of scope.eligible){
        const mapping=this.assertRequest(row.id,profile);
        this.db.run('INSERT INTO download_jobs(id,episode_id,media_id,source_id,profile_id,state,quality,selection,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          randomUUID(),row.id,mediaId,mapping.source_id,profile,'queued',preference==='best'?'최고 화질':preference,`auto:${preference}`,now,now);
      }
      result={total:scope.total,added:scope.eligible.length,skipped:scope.skipped};
    });
    this.pump();return result;
  }
  private enqueue(episode:string,profile:string,quality:string,selection:string){
    const mapping=this.assertRequest(episode,profile);
    if(this.db.get("SELECT 1 FROM download_jobs WHERE episode_id=? AND state IN ('queued','resolving','downloading','finalizing','ready')",episode))throw new ApiFailure(409,'download-already-exists');
    if(this.db.get("SELECT COUNT(*) AS n FROM download_jobs WHERE state='queued'")!.n>=MAX_QUEUED_DOWNLOADS)throw new ApiFailure(429,'download-queue-full');
    const id=randomUUID(),now=new Date().toISOString();
    this.db.run('INSERT INTO download_jobs(id,episode_id,media_id,source_id,profile_id,state,quality,selection,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,episode,mapping.media_id,mapping.source_id,profile,'queued',quality,selection,now,now);
    this.pump();return this.job(id);
  }
  private change(id:string,state:string,error:string|null=null){this.db.run('UPDATE download_jobs SET state=?,error=?,updated_at=? WHERE id=?',state,error,new Date().toISOString(),id);}
  private pump(){
    if(this.running||this.closed||this.paused||!this.setup||!this.mayRun()||!this.enabled()||this.cfg.downloadsEnabled===false)return;
    const row=this.db.get("SELECT * FROM download_jobs WHERE state='queued' ORDER BY created_at,rowid LIMIT 1");if(!row)return;
    const abort=new AbortController();const state={id:row.id,abort,promise:Promise.resolve()};this.running=state;
    state.promise=this.run(row,abort.signal).finally(()=>{if(this.running===state)this.running=undefined;this.pump();});
  }
  private async run(row:Record<string,any>,signal:AbortSignal){
    let dir:string|undefined,lease:string|undefined,timer:NodeJS.Timeout|undefined,renewing=false,leaseError=false,bytes=0,lastFlush=0;
    try{
      const mapping=this.assertRequest(row.episode_id,row.profile_id);const root=await this.storage();signal.throwIfAborted();
      dir=path.join(root,`job-${row.id}`);await mkdir(dir,{mode:0o700});await safePath(root,dir,true);
      this.change(row.id,'resolving');
      const videos=await this.sources.videos(row.episode_id);lease=videos.apkLease;signal.throwIfAborted();
      const automatic=row.selection.startsWith('auto:')?row.selection.slice(5) as DownloadQuality:undefined;
      const matched=automatic?[]:videos.filter(v=>fingerprint(v)===row.selection);
      if(!automatic&&matched.length!==1)throw new ApiFailure(410,'download-selection-changed');
      const item=automatic?preferredQuality(videos.filter(v=>v.url.startsWith('https:')&&!v.audios?.length),automatic,v=>qualityHeight(v.quality||'')):matched[0];
      if(!item)throw new ApiFailure(422,'download-stream-unsupported');
      this.db.run('UPDATE download_jobs SET quality=? WHERE id=?',item.quality||'기본 화질',row.id);
      if(lease)timer=setInterval(()=>{if(renewing)return;renewing=true;void this.sources.apk.renew(lease!).catch(()=>{leaseError=true;this.running?.abort.abort();}).finally(()=>{renewing=false;});},45000);
      timer?.unref();
      const signalWithLimit=AbortSignal.any([signal,AbortSignal.timeout(12*3600_000)]);
      const budget=async(n:number,total?:number)=>{
        if(total!==undefined)this.db.run('UPDATE download_jobs SET total_bytes=? WHERE id=?',total,row.id);
        signalWithLimit.throwIfAborted();bytes+=n;
        if(bytes>20*1024**3||this.used()+bytes>this.quota())throw new ApiFailure(507,'download-quota-exceeded');
        if(Date.now()-lastFlush>1000||lastFlush===0){const disk=await statfs(root);if(disk.bavail*disk.bsize<Math.max(512*1024**2,n))throw new ApiFailure(507,'download-space-low');lastFlush=Date.now();this.db.run('UPDATE download_jobs SET bytes=?,updated_at=? WHERE id=?',bytes,new Date().toISOString(),row.id);}
      };
      await budget(0);this.change(row.id,'downloading');
      const initial=new URL(item.url).origin,proxy=this.sources.proxy(mapping.source_id);
      const fetcher=async(url:string,range?:string)=>{
        if(new URL(url).origin===APK_RELAY)return this.sources.apk.stream(url,lease,range,signalWithLimit);
        const headers={...item.headers};if(new URL(url).origin!==initial)for(const k of Object.keys(headers))if(/^(cookie|authorization)$/i.test(k))delete headers[k];
        return this.transport(url,{...headers,...(range?{Range:range}:{})},signalWithLimit,proxy);
      };
      const result=await transferVideo(this.cfg,dir,item,fetcher,signalWithLimit,budget,()=>this.change(row.id,'finalizing'),automatic);
      signalWithLimit.throwIfAborted();
      const subtitles=result.subtitles.map(n=>path.join(dir!,n));const size=result.size+(await Promise.all(subtitles.map(f=>stat(f)))).reduce((a,b)=>a+b.size,0);
      if(this.used()+size>this.quota())throw new ApiFailure(507,'download-quota-exceeded');
      const height=result.probe.streams.find(stream=>stream.codec_type==='video')?.height;
      this.db.transaction(()=>{
        if(typeof height==='number'&&Number.isSafeInteger(height)&&height>0)this.db.run('UPDATE download_jobs SET quality=? WHERE id=?',`${height}p`,row.id);
        this.db.run('INSERT INTO download_assets VALUES(?,?,?,?,?,?)',row.episode_id,row.id,path.relative(root,path.join(dir!,'video.mp4')),size,JSON.stringify(result.probe),JSON.stringify(subtitles));
        this.db.run("UPDATE download_jobs SET state='ready',bytes=?,total_bytes=?,error=?,updated_at=? WHERE id=?",size,size,result.subtitleWarning?'download-subtitles-incomplete':null,new Date().toISOString(),row.id);
      });
    }catch(e){
      const code=leaseError?'download-auth-expired':signal.aborted?(!this.enabled()?'download-disabled':this.closed||this.paused?'download-interrupted':'download-cancelled'):e instanceof ApiFailure?e.error:'download-failed';
      this.change(row.id,['download-interrupted','download-disabled'].includes(code)?'interrupted':code==='download-cancelled'?'cancelled':'failed',code);
      // Stop the remaining queue on server-wide storage failure instead of extracting hundreds of doomed jobs.
      if(['download-quota-exceeded','download-space-low','download-storage-unavailable','download-storage-unconfigured','download-storage-overlap'].includes(code))this.db.run("UPDATE download_jobs SET state='interrupted',error=?,updated_at=? WHERE state='queued'",code,new Date().toISOString());
      if(dir)await rm(dir,{recursive:true,force:true}).catch(()=>{});
    }finally{clearInterval(timer);await this.sources.apk.release(lease);}
  }
  async cancel(id:string){const j=this.job(id);if(!activeStates.includes(j.state))throw new ApiFailure(409,'download-not-active');if(this.running?.id===id){this.running.abort.abort();await this.running.promise;}else this.change(id,'cancelled');return this.job(id);}
  retry(id:string,profile:string){const row=this.db.get('SELECT * FROM download_jobs WHERE id=?',id);if(!row)throw new ApiFailure(404,'download-not-found');if(!terminal.includes(row.state))throw new ApiFailure(409,'download-not-retryable');this.assertRequest(row.episode_id,profile);if(this.db.get("SELECT 1 FROM download_jobs WHERE episode_id=? AND state IN ('queued','resolving','downloading','finalizing','ready')",row.episode_id))throw new ApiFailure(409,'download-already-exists');if(this.db.get("SELECT COUNT(*) AS n FROM download_jobs WHERE state='queued'")!.n>=MAX_QUEUED_DOWNLOADS)throw new ApiFailure(429,'download-queue-full');this.db.run('UPDATE download_jobs SET profile_id=?,bytes=0,total_bytes=NULL WHERE id=?',profile,id);this.change(id,'queued');this.pump();return this.job(id);}
  async withSaved<T>(episode:string,work:(asset:Awaited<ReturnType<Downloads['asset']>>)=>Promise<T>):Promise<T>{
    if(this.deleting.has(episode))throw new ApiFailure(409,'download-in-use');
    this.opening.set(episode,(this.opening.get(episode)||0)+1);
    try{return await work(await this.asset(episode));}finally{const n=this.opening.get(episode)!-1;if(n)this.opening.set(episode,n);else this.opening.delete(episode);}
  }
  async asset(episode:string){
    const row=this.db.get('SELECT * FROM download_assets WHERE episode_id=?',episode);if(!row)return;
    const root=await this.storage();
    try{const file=await safePath(root,row.path);return{root,path:file,probe:row.probe,subtitles:row.subtitles,size:row.size,mtime:(await stat(file)).mtimeMs};}
    catch(e){if(e instanceof ApiFailure&&e.error==='path-not-found'){this.db.transaction(()=>{this.db.run('DELETE FROM download_assets WHERE episode_id=?',episode);this.change(row.job_id,'failed','download-file-missing');});return;}throw e;}
  }
  async remove(id:string){
    const j=this.job(id);if(activeStates.includes(j.state)||this.opening.has(j.episodeId)||this.deleting.has(j.episodeId))throw new ApiFailure(409,'download-in-use');
    if([...this.playback.sessions.values()].some(s=>s.response.saved&&s.response.episodeId===j.episodeId))throw new ApiFailure(409,'download-in-use');
    this.deleting.add(j.episodeId);
    try {
    const a=this.db.get('SELECT * FROM download_assets WHERE job_id=?',id);
    if(a){const root=await this.storage();const dir=path.join(root,`job-${id}`);const info=await lstat(dir).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(info){if(info.isSymbolicLink())throw new ApiFailure(400,'download-path-invalid');await safePath(root,dir,true);await rm(dir,{recursive:true,force:true});}}
    this.db.transaction(()=>{this.db.run('DELETE FROM download_assets WHERE job_id=?',id);this.db.run('DELETE FROM download_jobs WHERE id=?',id);});
    } finally {this.deleting.delete(j.episodeId);}
  }
  async suspend(){this.paused=true;if(this.running){this.running.abort.abort();await this.running.promise;}}
  resume(){if(!this.closed){this.paused=false;this.pump();}}
  async close(){clearInterval(this.timer);this.closed=true;await this.suspend();this.choicesCache.clear();}
}
