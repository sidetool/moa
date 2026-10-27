import test from 'node:test';
import assert from 'node:assert/strict';
import {AniListRecommendations,matchAnimeSeed,matchAnimeCandidate} from '../src/profiles/anilist-recommendations.js';
const anime=(id:number,name='Synthetic Animation',year=2024)=>({id,type:'ANIME',format:'TV',isAdult:false,title:{native:name,english:name},startDate:{year}});
const seed={kind:'tv' as const,id:9,title:'Localized',originalTitle:'Synthetic Animation',year:2024};
const candidate={kind:'tv' as const,id:200,title:'Localized Candidate',originalTitle:'Recommended Animation',year:2023,genreIds:[16]};
const wait=async(service:AniListRecommendations)=>{for(let i=0;i<100&&service.busy;i++)await new Promise(r=>setTimeout(r,1));assert.equal(service.busy,false);};
test('cross-provider matching requires unique original title, year, animation and format; season qualifiers stay intact',()=>{
  assert.equal(matchAnimeSeed(seed,[anime(1)])?.id,1);
  for(const rows of [[anime(1),anime(2)],[anime(1,'Synthetic Animation 2')],[anime(1,'Synthetic Animation',2023)],[{...anime(1),format:'MOVIE'}],[{...anime(1),isAdult:true}]])assert.equal(matchAnimeSeed(seed,rows),undefined);
  assert.equal(matchAnimeCandidate(anime(2,'Recommended Animation',2023),[candidate])?.id,200);
  for(const rows of [[candidate,{...candidate,id:201}],[{...candidate,genreIds:[]}],[{...candidate,year:2022}],[{...candidate,originalTitle:'Recommended Animation Part 2'}]])assert.equal(matchAnimeCandidate(anime(2,'Recommended Animation',2023),rows),undefined);
});
test('bounded adapter coalesces, caches public metadata and never sends private context',async()=>{
  let calls=0,searches=0;const fetcher:typeof fetch=async(url,init)=>{
    calls++;assert.equal(url,'https://graphql.anilist.co');assert.equal(init?.redirect,'error');
    const payload=JSON.parse(String(init?.body));assert.deepEqual(Object.keys(payload.variables).sort(),['format','from','search','to']);
    return Response.json({data:{Page:{pageInfo:{hasNextPage:false},media:[{...anime(1),recommendations:{nodes:[{rating:5,mediaRecommendation:anime(2,'Recommended Animation',2023)},{rating:-1,mediaRecommendation:anime(3)}]}}]}}});
  };
  const service=new AniListRecommendations(async()=>{searches++;return[candidate];},fetcher);
  assert.deepEqual(service.lookup(seed),[]);service.lookup(seed);await wait(service);
  assert.deepEqual(service.lookup(seed),[candidate]);assert.equal(calls,1);assert.equal(searches,1);service.close();
});
test('rate limit backs off all seeds; incomplete and ambiguous search pages never map',async()=>{
  let now=100000,calls=0;
  const service=new AniListRecommendations(async()=>[],async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});},()=>now);
  service.lookup(seed);await wait(service);now+=30000;service.lookup({...seed,id:10});assert.equal(calls,1);
  now+=100000;service.lookup({...seed,id:10});await wait(service);assert.equal(calls,2);service.close();
  let searches=0;const truncated=new AniListRecommendations(async()=>{searches++;return[candidate];},async()=>Response.json({data:{Page:{pageInfo:{hasNextPage:true},media:[anime(1)]}}}));
  truncated.lookup(seed);await wait(truncated);assert.deepEqual(truncated.lookup(seed),[]);assert.equal(searches,0);truncated.close();
});
