import test from 'node:test';
import assert from 'node:assert/strict';
import {BloggerIndex} from '../../src/subtitles/korean/blogger-index.js';
import {PublicHttpClient} from '../../src/subtitles/korean/http.js';

test('bounded feed discovery coalesces callers, survives caller cancellation and reuses the index', async () => {
  const http=new PublicHttpClient(); const calls:string[]=[];
  http.get=async url=>{
    calls.push(url); await new Promise(resolve=>setTimeout(resolve,10));
    const start=new URL(url).searchParams.get('start-index');
    return {url,status:200,headers:{},body:Buffer.from(JSON.stringify({feed:{openSearch$totalResults:{$t:'151'},entry:[{title:{$t:start==='1'?'새 작품':'로봇 탐험대 100'},link:[{rel:'alternate',href:`https://example-catalog.blogspot.com/${start}`}]},{title:{$t:'bad'},link:[{rel:'alternate',href:'http://127.0.0.1/x'}]}]}}))};
  };
  const index=new BloggerIndex(http), cancelled=new AbortController();
  const first=index.posts('https://example-catalog.blogspot.com',cancelled.signal);
  const other=index.posts('https://example-catalog.blogspot.com',new AbortController().signal);
  cancelled.abort();await assert.rejects(first);
  const posts=await other;assert.deepEqual(posts.map(p=>p.title),['새 작품','로봇 탐험대 100']);
  assert.deepEqual(await index.posts('https://example-catalog.blogspot.com',new AbortController().signal),posts);
  assert.equal(calls.length,2);
});

test('oversized indexes stop after the first request',async()=>{
 const http=new PublicHttpClient();let calls=0;
 http.get=async url=>{calls++;return {url,status:200,headers:{},body:Buffer.from(JSON.stringify({feed:{openSearch$totalResults:{$t:'999999'}}}))};};
 await assert.rejects(new BloggerIndex(http).posts('https://example-catalog.blogspot.com',new AbortController().signal),/size/);
 assert.equal(calls,1);
});
