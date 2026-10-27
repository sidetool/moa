import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { Tmdb, overlayDetail } from '../src/metadata/tmdb.js';
import { trailerCandidates } from '../src/metadata/tmdb-trailers.js';
import type { MediaDetail } from '@moa/shared';

const video=(key:string,fields:Record<string,unknown>={})=>({key,site:'YouTube',type:'Trailer',official:true,iso_639_1:'en',...fields});
test('trailer candidates validate, prioritize language/official, deduplicate and cap without treating language as region',()=>{
  assert.deepEqual(trailerCandidates([null,video('bad'),video('Z'.repeat(11),{site:'Vimeo'}),video('Y'.repeat(11),{type:'Clip'}),
    video('E'.repeat(11)),video('K'.repeat(11),{iso_639_1:'ko',official:false}),video('T'.repeat(11),{iso_639_1:'ko',type:'Teaser'}),
    video('E'.repeat(11)),video('J'.repeat(11),{iso_639_1:'ja'}),video('N'.repeat(11),{official:false}),video('Q'.repeat(11),{official:false})]),
    ['T'.repeat(11),'K'.repeat(11),'E'.repeat(11),'J'.repeat(11),'N'.repeat(11)]);
  assert.deepEqual(trailerCandidates(null),[]);
});
async function fixture(fetcher:typeof fetch){
  const dir=await mkdtemp(join(tmpdir(),'moa-trailers-')),db=new Store(dir);
  db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)','movie','Example','movie','{}','2026');
  db.run("INSERT INTO tmdb_links VALUES('movie','movie',10,NULL,'manual',100,?)",Date.now());
  db.run("INSERT INTO tmdb_titles VALUES('movie',10,?,?,?)",JSON.stringify({title:'Example',seasons:{}}),JSON.stringify({people:[],similar:[],trailer:'O'.repeat(11)}),Date.now());
  const tmdb=new Tmdb(db,()=>{},{token:'fixture',fetch:fetcher});
  const detail=()=>overlayDetail(db,{id:'movie',type:'movie',title:'Example',seasons:[],playTarget:null} as unknown as MediaDetail,false,true);
  return{db,tmdb,detail,close:async()=>{tmdb.close();db.close();await rm(dir,{recursive:true,force:true});}};
}
test('legacy cache preserves video until detail access, then fetches candidates once for concurrent viewers',async()=>{
  let calls=0;
  const f=await fixture(async input=>{
    const u=new URL(String(input));assert.equal(u.pathname,'/3/movie/10/videos');assert.equal(u.searchParams.get('include_video_language'),'ko,en,ja,null');calls++;
    await new Promise(r=>setTimeout(r,10));return Response.json({results:[video('N'.repeat(11)),video('K'.repeat(11),{iso_639_1:'ko'})]});
  });
  try{
    assert.deepEqual(f.detail().trailers,['O'.repeat(11)]);
    await Promise.all([f.tmdb.ensureDetail('movie',1000),f.tmdb.ensureDetail('movie',1000)]);
    await f.tmdb.ensureDetail('movie',1000);assert.equal(calls,1);
    assert.deepEqual(f.detail().trailers,['K'.repeat(11),'N'.repeat(11)]);assert.equal(f.detail().trailer,'K'.repeat(11));
  }finally{await f.close();}
});
test('failed video refresh retains legacy trailer and backs off; empty successful list clears stale video',async()=>{
  let calls=0;
  const f=await fixture(async()=>{calls++;return calls===1?Response.json({unexpected:true}):Response.json({results:[]});});
  try{
    await f.tmdb.ensureDetail('movie',1000);await f.tmdb.ensureDetail('movie',1000);assert.equal(calls,1);assert.equal(f.detail().trailer,'O'.repeat(11));
    const row=JSON.parse(f.db.get("SELECT detail FROM tmdb_titles WHERE kind='movie' AND tmdb_id=10")!.detail);delete row.trailerCheckedAt;
    f.db.run("UPDATE tmdb_titles SET detail=? WHERE kind='movie' AND tmdb_id=10",JSON.stringify(row));
    await f.tmdb.ensureDetail('movie',1000);assert.deepEqual(f.detail().trailers,[]);assert.equal(f.detail().trailer,undefined);
    await f.tmdb.ensureDetail('movie',1000);assert.equal(calls,2);
  }finally{await f.close();}
});
test('normal metadata refresh stores multiple candidates while preserving first-video compatibility',async()=>{
  const f=await fixture(async input=>{assert.equal(new URL(String(input)).pathname,'/3/movie/10');return Response.json({title:'Example',genres:[],videos:{results:[video('A'.repeat(11)),video('B'.repeat(11))]}});});
  try{
    await f.tmdb.change('movie',{action:'link',kind:'movie',tmdbId:10});
    assert.equal(f.detail().trailer,'A'.repeat(11));assert.deepEqual(f.detail().trailers,['A'.repeat(11),'B'.repeat(11)]);
  }finally{await f.close();}
});
