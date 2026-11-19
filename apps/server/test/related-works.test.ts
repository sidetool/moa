import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { Catalog } from '../src/catalog/service.js';
import { TitleGroups } from '../src/catalog/title-groups.js';
import { WorkRelations } from '../src/catalog/related-works.js';
import { Sources } from '../src/sources/service.js';
import { AniListClient } from '../src/metadata/anilist-client.js';
import { Tmdb } from '../src/metadata/tmdb.js';

const anime = (id:number, title:string, year:number, format='TV') =>
  ({id,type:'ANIME',format,isAdult:false,title:{native:title},startDate:{year}});
const origin = anime(100,'Archive Atlas 2nd Season',2023);
const edge = (relationType:string,node:ReturnType<typeof anime>) => ({relationType,node});
const page = (media: unknown[],hasNextPage=false) => Response.json({data:{Page:{pageInfo:{hasNextPage},media}}});
const edges = (list: unknown[]) => Response.json({data:{Media:{...origin,relations:{edges:list}}}});
function fixture(graphql:(variables:any)=>Promise<Response>|Response, tmdbFetch?:typeof fetch) {
  const db = new Store('.',new DatabaseSync(':memory:')), catalog = new Catalog(db);
  new Sources(db,catalog);
  const groups = new TitleGroups(catalog);
  for (const [id,kids] of [['p',0],['kids',1]] as const)
    db.run('INSERT INTO profiles(id,name,color,kids,created_at) VALUES(?,?,?,?,?)',id,id,'blue',kids,'2026');
  const settings = (s: object) => db.run("INSERT OR REPLACE INTO settings VALUES('p',?)",JSON.stringify(s));
  settings({anilistRecommendationsEnabled:true});
  for (const lang of ['en','ko']) db.run(`INSERT INTO source_entries(id,repository,entry,enabled,type,code)
    VALUES(?,'fiction',?,1,'anime','fixture')`,lang,JSON.stringify({lang}));
  const add = (id:string,title:string,tmdbId:number,kind:'movie'|'tv',season:number|null,card:object,provider='local') => {
    const metadata = provider === 'local' ? {} : {provider:{id:provider,name:provider,kind:'mangayomi-js'}};
    db.run('INSERT INTO media VALUES(?,NULL,?,?,?,?)',id,title,kind === 'tv' ? 'anime' : 'movie',JSON.stringify(metadata),'2026');
    db.run('INSERT OR REPLACE INTO tmdb_titles VALUES(?,?,?,\'{}\',0)',kind,tmdbId,JSON.stringify({adult:false,certification:'ALL',...card}));
    db.run("INSERT INTO tmdb_links VALUES(?,?,?,?,'manual',100,0)",id,kind,tmdbId,season);
    if (provider !== 'local') db.run('INSERT INTO source_media(media_id,source_id,url) VALUES(?,?,?)',id,provider,'/fiction');
  };
  const variables: object[] = [];
  const client = new AniListClient(async (url,init) => {
    assert.equal(url,'https://graphql.anilist.co');
    const v = JSON.parse(String(init?.body)).variables;
    variables.push(v);
    return graphql(v);
  });
  const tmdb = new Tmdb(db,()=>{}, {key:'test',fetch:tmdbFetch ?? (async()=>{ throw Error('unexpected TMDB request'); })});
  const relations = new WorkRelations(catalog,groups,tmdb,client);
  return {db,add,relations,settings,variables,close(){client.close(); tmdb.close(); db.close();}};
}
const series = {title:'아틀라스',originalTitle:'Archive Atlas',year:2021,genreIds:[16],seasons:{1:{year:2021},2:{year:2023},3:{year:2025}}};
test('explicit anime edges preserve season identity, direct only to a confirmed edition, and reuse provider evidence',async () => {
  const f = fixture(v=>v.search ? page([anime(99,'Archive Atlas',2023),origin]) : edges([
    edge('PREQUEL',anime(101,'Archive Atlas',2021)), edge('SEQUEL',anime(102,'Archive Atlas Season 3',2025)),
    edge('SIDE_STORY',anime(103,'Archive Atlas Field Notes',2022,'OVA')), edge('ADAPTATION',anime(104,'Other Medium',2021)),
    edge('SIDE_STORY',{...anime(105,'Adult',2022),isAdult:true}), edge('SEQUEL',origin),
  ]));
  try {
    f.add('s2','아틀라스 2기',1,'tv',2,series,'en');
    f.add('s1','아틀라스',1,'tv',1,series,'ko');
    f.add('s3','아틀라스 3기',1,'tv',3,series,'ko');
    f.add('wrong-cut','아틀라스 3기 파트 2',1,'tv',3,series,'en');
    const [a,b] = await Promise.all([f.relations.get('s2','p'),f.relations.get('s2','p')]);
    assert.deepEqual(a,b);
    assert.deepEqual(f.variables,[{search:'Archive Atlas',format:'TV',from:20230100,to:20240101},{id:100}]);
    assert.deepEqual(a.items.map(r=>[r.relation,r.mediaId,r.title]), [
      ['prequel','s1','아틀라스'],['sequel','s3','아틀라스 3기'],['sideStory',undefined,'Archive Atlas Field Notes']]);
    f.db.run("UPDATE source_entries SET enabled=0 WHERE id='ko'");
    assert.deepEqual((await f.relations.get('s2','p')).items.map(r=>r.mediaId),[undefined,undefined,undefined]);
    assert.equal(f.variables.length,2);
    assert.deepEqual((await f.relations.get('wrong-cut','p')).items,[]);
    assert.deepEqual((await f.relations.get('s2','kids')).items,[]);
    f.settings({recommendationsEnabled:false,anilistRecommendationsEnabled:true});
    assert.deepEqual((await f.relations.get('s2','p')).items,[]);
    f.settings({});
    assert.deepEqual((await f.relations.get('s2','p')).items,[]);
    assert.equal(f.variables.length,2);
  } finally { f.close(); }
});
test('ambiguous, truncated and wrong-format seeds never fetch edges',async () => {
  for (const response of [
    () => page([origin,{...origin,id:101}]), () => page([origin],true), () => page([{...origin,format:'MOVIE'}]),
    () => page([anime(101,'Archive Atlas',2021)]),
  ]) {
    const f = fixture(response);
    try {
      f.add('s2','아틀라스 2기',1,'tv',2,series);
      assert.deepEqual((await f.relations.get('s2','p')).items,[]);
      assert.equal(f.variables.length,1);
    } finally { f.close(); }
  }
});
test('different accepted identities sharing a title, year and format fall back to search',async () => {
  const f = fixture(v=>v.search ? page([origin]) : edges([edge('SEQUEL',anime(102,'Unmapped Edition',2025))]));
  try {
    f.add('s2','아틀라스 2기',1,'tv',2,series);
    const card = {title:'별책',originalTitle:'Unmapped Edition',genreIds:[16],year:2025};
    for (const id of [20,21]) f.add('m'+id,'별책',id,'tv',1,card);
    const [r] = (await f.relations.get('s2','p')).items;
    assert.equal(r.query,'별책'); assert.equal(r.mediaId,undefined);
  } finally { f.close(); }
});
test('profile changes and source revocation during an AniList lookup suppress its response',async () => {
  for (const mode of ['setting','source','link']) {
    let release!:()=>void, started!:()=>void;
    const gate = new Promise<void>(r=>release=r), begin = new Promise<void>(r=>started=r);
    const f = fixture(async v=>{
      if (v.search) return page([origin]);
      started(); await gate;
      return edges([edge('SEQUEL',anime(102,'Archive Atlas Season 3',2025))]);
    });
    try {
      f.add('s2','아틀라스 2기',1,'tv',2,series,'en');
      const pending = f.relations.get('s2','p'); await begin;
      if (mode==='setting') f.settings({});
      if (mode==='source') f.db.run("UPDATE source_entries SET enabled=0 WHERE id='en'");
      if (mode==='link') f.db.run("UPDATE tmdb_links SET season=1 WHERE media_id='s2'");
      release(); assert.deepEqual((await pending).items,[]);
    } finally { release(); f.close(); }
  }
});
test('legacy movie detail gains explicit collection membership once, declines adult/unknown entries, and checks kids on each read',async () => {
  const paths: string[] = [];
  const part = (id:number,name:string,adult:boolean|undefined=false) => ({id,name,adult,release_date:'2023-01-01'});
  const f = fixture(()=>page([]),async url=>{
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path==='/3/movie/10') return Response.json({id:10,title:'별 하나',original_title:'Atlas Film',release_date:'2022-01-01',
      adult:false,genres:[],belongs_to_collection:{id:33},release_dates:{results:[{iso_3166_1:'KR',release_dates:[{certification:'ALL'}]}]}});
    if (path==='/3/collection/33') return Response.json({id:33,parts:[part(10,'별 하나'),part(11,'별 둘'),
      part(12,'아직 미수록'),part(13,'제한',true),{id:14,name:'미확인'},{...part(15,'다른 형식'),media_type:'tv'}]});
    throw Error('unexpected path');
  });
  try {
    f.add('origin','별 하나',10,'movie',null,{title:'별 하나',year:2022});
    f.add('known','별 둘',11,'movie',null,{title:'별 둘',year:2023,collectionId:33},'ko');
    const first = await f.relations.get('origin','p');
    assert.deepEqual(first.items.map(r=>[r.relation,r.title,r.mediaId]),[['collection','별 둘','known'],['collection','아직 미수록',undefined]]);
    assert.deepEqual((await f.relations.get('origin','kids')).items.map(r=>r.mediaId),['known']);
    f.db.run("UPDATE tmdb_titles SET card=json_set(card,'$.certification','19') WHERE tmdb_id=11");
    assert.deepEqual((await f.relations.get('origin','kids')).items,[]);
    assert.equal(paths.filter(p=>p==='/3/movie/10').length,1);
    assert.deepEqual(paths,['/3/movie/10','/3/collection/33']);
  } finally { f.close(); }
});
test('relation failures back off and do not discard another provider’s explicit movie collection',async () => {
  let collections = 0;
  const f = fixture(()=>new Response('',{status:429,headers:{'retry-after':'120'}}),async () => {
    collections++;
    return Response.json({id:33,parts:[{id:10,title:'별 하나',adult:false},{id:11,title:'별 둘',release_date:'2023-01-01',adult:false}]});
  });
  try {
    f.add('origin','별 하나',10,'movie',null,{title:'별 하나',originalTitle:'Atlas Film',year:2022,genreIds:[16],collectionId:33});
    f.add('known','별 둘',11,'movie',null,{title:'별 둘',year:2023});
    const first = await f.relations.get('origin','p');
    assert.deepEqual(first.items.map(r=>[r.relation,r.mediaId]),[['collection','known']]);
    f.db.run("UPDATE media SET metadata=json_set(metadata,'$.year',1998) WHERE id='known'");
    assert.deepEqual((await f.relations.get('origin','p')).items.map(r=>[r.query,r.mediaId]),[['별 둘',undefined]]);
    assert.equal(f.variables.length,1); assert.equal(collections,1);
  } finally { f.close(); }
});
