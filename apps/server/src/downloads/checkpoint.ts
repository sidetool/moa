import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
export interface Checkpoint {version:1;jobId:string;episodeId:string;urlDigest:string;etag:string;totalBytes:number;confirmedOffset:number;updatedAt:number}
export const checkpointTTL = 7 * 86_400_000;
export const urlDigest = (url:string) => createHash('sha256').update(url).digest('hex');
export const strongETag = (value:unknown):value is string => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
export async function readCheckpoint(dir:string,jobId:string,episodeId:string):Promise<Checkpoint|undefined>{
  try {
    const meta=path.join(dir,'checkpoint.json'),payload=path.join(dir,'input.mp4');
    const [m,p]=await Promise.all([lstat(meta),lstat(payload)]);
    if(!m.isFile()||!p.isFile()||m.size>4096)return;
    const value=JSON.parse(await readFile(meta,'utf8')) as Checkpoint;
    if(value.version!==1||value.jobId!==jobId||value.episodeId!==episodeId||!/^([a-f0-9]{64})$/.test(value.urlDigest)||!strongETag(value.etag)||
      !Number.isSafeInteger(value.totalBytes)||value.totalBytes<=0||value.totalBytes>20*1024**3||!Number.isSafeInteger(value.confirmedOffset)||value.confirmedOffset<=0||value.confirmedOffset>=value.totalBytes||p.size!==value.confirmedOffset||
      !Number.isFinite(value.updatedAt)||value.updatedAt>Date.now()||Date.now()-value.updatedAt>checkpointTTL)return;
    return value;
  }catch{return;}
}
export async function writeCheckpoint(dir:string,value:Checkpoint){
  const temp=path.join(dir,'checkpoint.json.tmp');
  await writeFile(temp,JSON.stringify(value),{mode:0o600});
  await rename(temp,path.join(dir,'checkpoint.json'));
}
export async function clearCheckpoint(dir:string){
  for(const name of ['input.mp4','checkpoint.json','checkpoint.json.tmp'])await rm(path.join(dir,name),{force:true});
}
