import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceQueue } from '../src/sources/queue.js';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve}; };

test('reserved interactive lane bypasses lists, caps concurrency at two and respects management barriers',async()=>{
  const queue=new SourceQueue(), search=gate(), detail=gate(), started:string[]=[];
  let active=0,max=0;
  const task=(name:string,wait=Promise.resolve())=>async()=>{started.push(name);max=Math.max(max,++active);await wait;active--;};
  const a=queue.run('a','background',task('search',search.promise));
  const b=queue.run('a','background',task('list'));
  const c=queue.run('a','interactive',task('detail',detail.promise));
  const exclusive=queue.run('a','exclusive',task('settings'));
  const later=queue.run('a','interactive',task('video'));
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(started,['search','detail']);
  detail.resolve();await c;await new Promise(r=>setImmediate(r));
  assert.deepEqual(started,['search','detail'],'management barrier prevents later reads overtaking it');
  search.resolve();await Promise.all([a,b,exclusive,later]);await queue.drain();
  assert.deepEqual(started,['search','detail','list','settings','video']);assert.equal(max,2);
});

test('queue drains failures and enforces its bounded backlog',async()=>{
  const queue=new SourceQueue(), wait=gate();
  const tasks=Array.from({length:8},()=>queue.run('a','background',()=>wait.promise));
  await assert.rejects(queue.run('a','background',async()=>{}),/source-busy/);
  await queue.run('a','interactive',async()=>{}); // A full list backlog cannot consume the reserved lane.
  wait.resolve();await Promise.all(tasks);await queue.drain('a');
  await assert.rejects(queue.run('a','interactive',async()=>{throw new Error('failure')}),/failure/);
  await queue.drain();await queue.run('a','interactive',async()=>{});await queue.drain();
});
