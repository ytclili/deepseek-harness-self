import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { RuntimeProxy } from '../dist/proxy.js';

const session = key => ({ key, identity: {tenantId:'tenant',userId:key,token:'ERP-'+key,expiresAt:null}, expiresAt:Date.now()+60000 });
async function serve(t, handler) {
  const server = createServer(handler);const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{ for(const socket of sockets)socket.destroy(); server.closeAllConnections(); await new Promise(r=>server.close(r)); });
  return {server,origin:`http://127.0.0.1:${server.address().port}`};
}
test('two users proxy to their own runtime and cannot inject upstream cookies or identity headers', async t=>{
  const proxy=new RuntimeProxy({timeoutMs:1000,maxBodyBytes:4096});t.after(()=>proxy.close());
  const a=await serve(t,(req,res)=>{res.setHeader('set-cookie','native=SECRET;Path=/');res.end(JSON.stringify({runtime:'A',cookie:req.headers.cookie,auth:req.headers.authorization,forward:req.headers['x-forwarded-host'],url:req.url}));});
  const b=await serve(t,(_req,res)=>res.end('B_PRIVATE'));
  const entry=await serve(t,(req,res)=>{
    const isA=req.headers.cookie==='portal=A';
    proxy.http(session(isA?'A':'B'),{origin:isA?a.origin:b.origin,cookie:isA?'native=A_ONLY':'native=B_ONLY'},req,res);
  });
  const res=await fetch(entry.origin+'/?tenantId=B&token=stolen',{headers:{cookie:'portal=A',authorization:'Bearer attacker','x-forwarded-host':b.origin}});
  assert.equal(res.status,200);assert.equal(res.headers.get('set-cookie'),null);
  const body=await res.json();assert.equal(body.runtime,'A');assert.equal(body.cookie,'native=A_ONLY');assert.equal(body.auth,undefined);assert.equal(body.forward,undefined);assert.doesNotMatch(body.url,/token=/);
  assert.equal(await(await fetch(entry.origin+'/',{headers:{cookie:'portal=B'}})).text(),'B_PRIVATE');
});
test('session revocation aborts an in-flight HTTP response',async t=>{
  const proxy=new RuntimeProxy({timeoutMs:2000,maxBodyBytes:4096});t.after(()=>proxy.close());const s=session('A');
  const upstream=await serve(t,(_req,res)=>{res.write('private-start');});
  const entry=await serve(t,(req,res)=>proxy.http(s,{origin:upstream.origin,cookie:'native=A'},req,res));
  const result=await fetch(entry.origin+'/');const reader=result.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'private-start');
  proxy.revoke(s);await assert.rejects(reader.read());
});
test('native redirects are rewritten locally; external redirects cannot carry native tokens',async t=>{
  const proxy=new RuntimeProxy({timeoutMs:1000,maxBodyBytes:4096});t.after(()=>proxy.close());
  const upstream=await serve(t,(_req,res)=>{res.writeHead(302,{location:'https://attacker.invalid/?token=NATIVE_SECRET'});res.end();});
  const entry=await serve(t,(req,res)=>proxy.http(session('A'),{origin:upstream.origin,cookie:'native=A'},req,res));
  const res=await fetch(entry.origin+'/',{redirect:'manual'});assert.equal(res.status,502);assert.equal(res.headers.get('location'),null);assert.doesNotMatch(await res.text(),/NATIVE_SECRET/);
});
test('upgrade uses the assigned runtime and closes on session revocation',async t=>{
  const proxy=new RuntimeProxy({timeoutMs:1000,maxBodyBytes:4096});t.after(()=>proxy.close());const s=session('A');let upstreamCookie;
  const upstream=await serve(t);const serverSockets=new Set();t.after(()=>{for(const socket of serverSockets)socket.destroy();});
  upstream.server.on('upgrade',(req,socket)=>{serverSockets.add(socket);upstreamCookie=req.headers.cookie;socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});
  const entry=await serve(t);entry.server.on('upgrade',(req,socket,head)=>{serverSockets.add(socket);proxy.upgrade(s,{origin:upstream.origin,cookie:'native=A_ONLY'},req,socket,head);});
  const client=request(entry.origin+'/api/remote.mux',{headers:{connection:'Upgrade',upgrade:'websocket',cookie:'forged=B'}});client.end();
  const [_res,socket]=await once(client,'upgrade');t.after(()=>socket.destroy());assert.equal(upstreamCookie,'native=A_ONLY');
  const closed=once(socket,'close');proxy.revoke(s);await closed;
});

test('invalid redirect responses stay local to their request',async t=>{
  const proxy=new RuntimeProxy({timeoutMs:1000,maxBodyBytes:4096});t.after(()=>proxy.close());
  const upstream=await serve(t,(req,res)=>{if(req.url==='/good'){res.end('healthy');return;}res.writeHead(302,{location:req.url==='/port'?'http://localhost:bad':'http://['});res.end();});
  const entry=await serve(t,(req,res)=>proxy.http(session(req.url),{origin:upstream.origin,cookie:'native'},req,res));
  for(const path of ['/bad','/port'])assert.equal((await fetch(entry.origin+path)).status,502);
  assert.equal(await(await fetch(entry.origin+'/good')).text(),'healthy');
});

test('revocation during a pending upgrade closes both sides and forbids reuse',async t=>{
  const proxy=new RuntimeProxy({timeoutMs:1000,maxBodyBytes:4096});t.after(()=>proxy.close());const s=session('A');
  const upstream=await serve(t);let accept;const accepted=new Promise(r=>accept=r);
  upstream.server.on('upgrade',(_req,socket)=>{accept(socket);});
  const entry=await serve(t);entry.server.on('upgrade',(req,socket,head)=>proxy.upgrade(s,{origin:upstream.origin,cookie:'native'},req,socket,head));
  const client=request(entry.origin+'/api/remote.mux',{headers:{connection:'Upgrade',upgrade:'websocket'}});
  const clientClosed=new Promise(r=>{client.on('error',r);client.on('close',r);});client.end();
  const backend=await accepted;const peerClosed=once(backend,'end');backend.once('end',()=>backend.destroy());backend.resume();proxy.revoke(s);
  await Promise.all([clientClosed,peerClosed]);
});

test('connection budgets cover all sessions of a user while allowing another user',async t=>{
  const proxy=new RuntimeProxy({timeoutMs:2000,maxBodyBytes:4096,maxPerUser:1,maxTotal:2});t.after(()=>proxy.close());
  const upstream=await serve(t,(_req,res)=>{res.write('open');});
  const entry=await serve(t,(req,res)=>proxy.http(session(req.url),{origin:upstream.origin,cookie:'native'},req,res));
  const first=await fetch(entry.origin+'/A');assert.equal(first.status,200);
  assert.equal((await fetch(entry.origin+'/A')).status,429);
  const second=await fetch(entry.origin+'/B');assert.equal(second.status,200);
  assert.equal((await fetch(entry.origin+'/C')).status,429);
  await first.body.cancel();await second.body.cancel();
});
