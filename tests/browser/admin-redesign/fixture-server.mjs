import { createServer } from 'node:http';
import { createSyntheticBrowserComposition } from '../../../scripts/lib/synthetic-browser-composition.mjs';
const composition = await createSyntheticBrowserComposition();
const context = composition.createContext({name:'redesign-preview',identity:{kind:'authenticated',verifiedEmail:'redesign@example.invalid',verifiedFullName:'Design Preview'}});
await context.ready(); await context.bootstrap('redesign-bootstrap-20260905');
for (const [handle,name,description] of [['research','Research notes','Sources, findings and decisions for ongoing research.'],['product','Product development','Product direction, release decisions and engineering notes.'],['reading','Reading list','Books, articles and ideas to return to.'],['travel','Travel plans','Destinations, practical notes and itineraries.'],['family','Family projects','Shared plans and household reference material.']]) {
const r=await context.api('/api/v1/minds',{method:'POST',body:{name,handle,description},idempotencyKey:'redesign-create-'+handle}); if(r.status!==201&&r.status!==200) throw new Error('seed '+r.status);
}
const server=createServer(async(req,res)=>{try {const chunks=[];for await(const c of req)chunks.push(c);const headers={...req.headers};delete headers.host;delete headers['content-length'];const r=await context.request(req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});res.statusCode=r.status;r.headers.forEach((v,k)=>{if(!['content-length','content-encoding'].includes(k))res.setHeader(k,v)});res.end(r.text);}catch{res.statusCode=500;res.end('Preview error')}});
server.listen(0,'127.0.0.1',()=>console.log('Redesign preview: http://127.0.0.1:'+server.address().port+'/minds'));
process.on('SIGTERM',()=>server.close(async()=>{await composition.close();process.exit()}));
