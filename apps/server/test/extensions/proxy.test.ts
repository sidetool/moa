import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createServer as tcpServer, type Socket} from 'node:net';
import {parseOutboundProxy,pinnedProxyAgent} from '../../src/sources/extensions/proxy.js';
import {publicStream} from '../../src/sources/extensions/stream.js';
import {invokeMangayomi,parseRepository} from '../../src/sources/extensions/index.js';

test('proxy parsing and private destinations remain blocked with proxy enabled',async()=>{
  assert.equal(parseOutboundProxy(' '),undefined);assert.equal(parseOutboundProxy('socks5://127.0.0.1:1080'),'socks5://127.0.0.1:1080');
  for(const url of ['file:///etc/passwd','http://user:pass@host','http://host/path','http://host:0'])assert.throws(()=>parseOutboundProxy(url));
  await assert.rejects(publicStream('https://127.0.0.1/',{},AbortSignal.timeout(1000),'socks5://127.0.0.1:1'),/source_address_denied/);
});
test('HTTP CONNECT and SOCKS5 receive the approved IP and preserve the original Host',async()=>{
 for(const scheme of ['http','socks5']){
  let destination='',host='';const sockets=new Set<Socket>();
  const proxy=scheme==='http'?createServer():tcpServer();
  const track=(s:Socket)=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));};
  proxy.on('connection',track);
  if(scheme==='http')proxy.on('connect',(req,socket)=>{destination=req.url!;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',chunk=>{host=chunk.toString();socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');});});
  else proxy.on('connection',(socket:Socket)=>{let step=0,buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(step===0&&buffer.length>=3){buffer=buffer.subarray(3);step=1;socket.write(Buffer.from([5,0]));}if(step===1&&buffer.length>=10){assert.equal(buffer[3],1);destination=[...buffer.subarray(4,8)].join('.')+':'+buffer.readUInt16BE(8);buffer=buffer.subarray(10);step=2;socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));}if(step===2&&buffer.includes('\r\n\r\n')){host=buffer.toString();step=3;socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');}});});
  await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
  const port=(proxy.address() as import('node:net').AddressInfo).port;
  const agent=pinnedProxyAgent(`${scheme}://127.0.0.1:${port}`,new URL('http://fixture.invalid:8080'),'93.184.215.14',AbortSignal.timeout(2000))!;
  try{const body=await new Promise<string>((resolve,reject)=>{const req=request('http://fixture.invalid:8080',{agent},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve(text));});req.on('error',reject);req.end();});assert.equal(body,'ok');assert.equal(destination,'93.184.215.14:8080');assert.match(host,/Host: fixture.invalid:8080/);}
  finally{agent.destroy();for(const s of sockets)s.destroy();await new Promise<void>(r=>proxy.close(()=>r()));}
 }
});
test('runtime forwards only the host-selected proxy to its HTTP broker',async()=>{
 const entry=parseRepository([{id:1,name:'Fixture',version:'1',itemType:1,sourceCodeLanguage:1,baseUrl:'https://example.com',sourceCodeUrl:'https://example.com/x.js'}])[0];let observed:string|undefined;
 await invokeMangayomi({entry,source:`class DefaultExtension extends MProvider {async getPopular(){await new Client().get('https://example.com');return {list:[],hasNextPage:false};}}`,action:'list',outboundProxy:'socks5://host:1080',signal:AbortSignal.timeout(5000)},async(_request,_signal,_allowed,_maximum,proxy)=>{observed=proxy;return{statusCode:200,bytes:Buffer.from('ok'),headers:{},contentType:'text/plain',url:'https://example.com'};});assert.equal(observed,'socks5://host:1080');
});
