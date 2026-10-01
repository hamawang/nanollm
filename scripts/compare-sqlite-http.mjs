// Local Docker benchmark only. Never connects to Railway or live Turso.
// Supply SQLITE_BENCH_SOURCE (verified SQLite backup), SQLITE_BENCH_CONFIG
// (quicSQL YAML), SQLITE_BENCH_OUTPUT, and optionally SQLITE_BENCH_ORDER.
import { createClient } from '@libsql/client';
import { inspectStorage, migrateStorage, verifyStorage } from '../dist/scripts/storage-migration.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const sourcePath=path.resolve(process.env.SQLITE_BENCH_SOURCE ?? '');
const configPath=path.resolve(process.env.SQLITE_BENCH_CONFIG ?? '');
const output=path.resolve(process.env.SQLITE_BENCH_OUTPUT ?? '');
if(!process.env.SQLITE_BENCH_SOURCE||!process.env.SQLITE_BENCH_CONFIG||!process.env.SQLITE_BENCH_OUTPUT)throw Error('Set all SQLITE_BENCH_* paths');
const source=createClient({url:'file:'+sourcePath.replaceAll('\\','/'),intMode:'bigint'});
const specs={
 sqld:{image:'ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67',port:18080,internal:8080,root:'/var/lib/sqld',suffix:'',extra:['-e','SQLD_NODE=standalone','-e','SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080'],command:[]},
 quic:{image:process.env.SQLITE_BENCH_QUIC_IMAGE??'nanollm-quicsql-bench:0.6.0',port:17776,internal:7775,root:'/data',suffix:'/app/',extra:['--mount',`type=bind,source=${configPath},target=/etc/quicsql.yaml,readonly`],command:['--config','/etc/quicsql.yaml']},
};
const report={startedAt:new Date().toISOString(),versions:{sqld:'0.24.33',quic:'0.6.0'},client:'@libsql/client 0.17.4',limits:{memoryBytes:536870912,cpu:1,swap:false},retention:{writes:1000,keep:100,payloadBytes:262144},results:[]};
const ident=s=>'"'+s.replaceAll('"','""')+'"';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function command(args){return new Promise((resolve,reject)=>{const p=spawn('docker',args,{windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',c=>c===0?resolve(out.trim()):reject(Error('Docker operation failed: '+args[0])));});}
function assert(ok,reason){if(!ok)throw Error(reason)}
function parsePairs(text){return Object.fromEntries(text.split('\n').map(l=>l.trim().split(/\s+/)).filter(x=>x.length===2).map(([k,v])=>[k,Number(v)]));}
async function sample(name,root,label){
 const status=await command(['exec',name,'sh','-c','cat /proc/1/status']);
 const values={};for(const l of status.split('\n')){const m=l.match(/^(VmRSS|VmHWM|RssAnon|RssFile|Threads):\s+(\d+)/);if(m)values[m[1]]=Number(m[2])*(m[1]==='Threads'?1:1024)}
 const stat=parsePairs(await command(['exec',name,'sh','-c','cat /sys/fs/cgroup/memory.stat']));
 const total=Number(await command(['exec',name,'sh','-c','cat /sys/fs/cgroup/memory.current']));
 const peak=Number(await command(['exec',name,'sh','-c','cat /sys/fs/cgroup/memory.peak']));
 const disk=(await command(['exec',name,'sh','-c',`du -ak ${root}`])).split('\n').map(l=>{const m=l.match(/^(\d+)\s+(.+)$/);return m?{path:m[2],allocatedBytes:Number(m[1])*1024}:null}).filter(Boolean);
 return {label,at:new Date().toISOString(),rss:values.VmRSS,rssHighWater:values.VmHWM,rssAnon:values.RssAnon,rssFile:values.RssFile,threads:values.Threads,container:total,containerPeak:peak,anon:stat.anon,fileCache:stat.file,inactiveFile:stat.inactive_file,kernel:stat.kernel,disk};
}
async function compatibility(c){
 await c.executeMultiple('CREATE TABLE bench_types(id INTEGER PRIMARY KEY,n INTEGER,b BLOB,t TEXT,r REAL); CREATE TABLE bench_multi(id INTEGER PRIMARY KEY);');
 const blob=Uint8Array.from([0,127,128,255]);
 await c.batch([{sql:'INSERT INTO bench_types VALUES(?,?,?,?,?)',args:[1,9007199254740993n,blob,'Unicode: 中文 😀',1.25]}],'write');
 const r=(await c.execute('SELECT * FROM bench_types WHERE id=1')).rows[0];
 assert(r.n===9007199254740993n,'BigInt precision mismatch');
 assert(Buffer.from(r.b).equals(Buffer.from(blob)),'BLOB mismatch');assert(r.t==='Unicode: 中文 😀'&&r.r===1.25,'Text/REAL mismatch');
 const tx=await c.transaction('write');await tx.execute('INSERT INTO bench_multi VALUES(1)');await tx.rollback();
 assert((await c.execute('SELECT count(*) n FROM bench_multi')).rows[0].n===0n,'Rollback failed');
 const tx2=await c.transaction('write');await tx2.execute('INSERT INTO bench_multi VALUES(2)');await tx2.commit();
 assert((await c.execute('SELECT count(*) n FROM bench_multi')).rows[0].n===1n,'Commit failed');
 let failed=false;try{await c.batch(['INSERT INTO bench_multi VALUES(3)','INSERT INTO nonexistent_table VALUES(1)'],'write')}catch{failed=true}
 assert(failed,'Invalid batch not rejected');assert((await c.execute('SELECT count(*) n FROM bench_multi WHERE id=3')).rows[0].n===0n,'Failed batch not atomic');
 await c.executeMultiple('DROP TABLE bench_types; DROP TABLE bench_multi;');
 return ['executeMultiple','parameterized batch','64-bit integer','BLOB','Unicode','REAL','transaction commit','transaction rollback','failed batch atomicity'];
}
async function waitReady(url){for(let i=0;i<60;i++){let c;try{c=createClient({url,intMode:'bigint'});await c.execute('SELECT 1');return}catch{await sleep(500)}finally{c?.close()}}throw Error('Server readiness timeout')}
let checkpoint=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
try{
 const hash=createHash('sha256');for await(const chunk of fs.createReadStream(sourcePath))hash.update(chunk);report.sourceSha256=hash.digest('hex');
 const expected=await inspectStorage(source);report.source=expected;
 const table=expected.tables.find(t=>t.name==='records');assert(table,'Missing records');
 const primary=table.columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk);
 const size=table.columns.map(c=>'COALESCE(length(CAST('+ident(c.name)+' AS BLOB)),0)').join('+');
 const largest=(await source.execute('SELECT * FROM records ORDER BY ('+size+') DESC LIMIT 1')).rows[0];
 const where=primary.map(c=>ident(c.name)+'=?').join(' AND ');const keys=primary.map(c=>largest[c.name]);
 const order=(process.env.SQLITE_BENCH_ORDER??'sqld,quic').split(',');
 for(const kind of order){
 const spec=specs[kind];assert(spec,'Unknown server');const name='nanollm-bench-'+kind+'-'+Date.now();const volume=name+'-data';
 const result={server:kind,image:spec.image,phases:[],compatibility:[],timings:{}};report.results.push(result);checkpoint();let client;
 try{
 await command(['volume','create',volume]);
 await command(['run','-d','--name',name,'--memory','512m','--memory-swap','512m','--cpus','1','-p',`127.0.0.1:${spec.port}:${spec.internal}`,'--mount',`type=volume,source=${volume},target=${spec.root}`,...spec.extra,spec.image,...spec.command]);
 const url=`http://127.0.0.1:${spec.port}${spec.suffix}`;await waitReady(url);await sleep(2000);result.phases.push(await sample(name,spec.root,'empty'));checkpoint();
 client=createClient({url,intMode:'bigint',readYourWrites:true});
 result.pragmas={};for(const key of ['journal_mode','cache_size','page_size','foreign_keys','mmap_size','wal_autocheckpoint']){const r=await client.execute('PRAGMA '+key);result.pragmas[key]=String(r.rows[0]?.[0])}
 result.compatibility=await compatibility(client);console.log(kind+': compatibility passed');
 const start=performance.now();await migrateStorage(source,client,{migrationId:'local-http-bench-'+kind,sourceIdentity:report.sourceSha256,logger:m=>console.log(kind+': '+m)});result.timings.importAndVerifyMs=Math.round(performance.now()-start);
 result.phases.push(await sample(name,spec.root,'after_backup_import_and_verify'));checkpoint();
 let began=performance.now();for(let i=0;i<20;i++){const r=await client.execute({sql:'SELECT * FROM records WHERE '+where,args:keys});assert(r.rows.length===1,'Large read failed')}result.timings.largeRead20Ms=Math.round(performance.now()-began);
 began=performance.now();await Promise.all(Array.from({length:4},async()=>{for(let i=0;i<5;i++)await client.execute({sql:'SELECT * FROM records WHERE '+where,args:keys})}));result.timings.largeReadConcurrent4x5Ms=Math.round(performance.now()-began);
 const sql='INSERT OR REPLACE INTO records('+table.columns.map(c=>ident(c.name)).join(',')+') VALUES('+table.columns.map(()=>'?').join(',')+')';
 began=performance.now();for(let i=0;i<20;i++)await client.execute({sql,args:table.columns.map(c=>largest[c.name])});result.timings.largeUpsert20Ms=Math.round(performance.now()-began);
 result.phases.push(await sample(name,spec.root,'after_large_reads_and_writes'));checkpoint();
 await verifyStorage(client,expected);result.snapshotStillMatches=true;
 await sleep(30000);result.phases.push(await sample(name,spec.root,'idle_30s'));checkpoint();
 await command(['restart',name]);client.close();await waitReady(url);client=createClient({url,intMode:'bigint'});await verifyStorage(client,expected);result.restartVerified=true;
 result.phases.push(await sample(name,spec.root,'restart_and_full_verify'));checkpoint();
 await client.execute('CREATE TABLE bench_retention(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)');
 const payload='x'.repeat(report.retention.payloadBytes);began=performance.now();
 for(let i=1;i<=report.retention.writes;i++){await client.batch([{sql:'INSERT INTO bench_retention VALUES(?,?)',args:[i,payload]},{sql:'DELETE FROM bench_retention WHERE id<=?',args:[i-report.retention.keep]}],'write');if(i%100===0){const r=await client.execute('SELECT count(*) n FROM bench_retention');assert(r.rows[0].n===100n,'Retention mismatch');result.phases.push(await sample(name,spec.root,'retention_'+i));checkpoint();console.log(kind+': retention '+i+' writes; 100 rows kept')}}
 result.timings.retention1000Ms=Math.round(performance.now()-began);await client.execute('DROP TABLE bench_retention');await verifyStorage(client,expected);result.finalSnapshotMatches=true;
 await sleep(30000);result.phases.push(await sample(name,spec.root,'final_idle_30s'));result.success=true;checkpoint();
 console.log(kind+': all checks passed');
 }catch(e){result.success=false;result.error={name:e.name,code:e.code??null};checkpoint();console.log(kind+': FAILED ('+e.name+', '+(e.code??'no code')+'); raw payloads omitted');}
 finally{client?.close();await command(['rm','-f',name]).catch(()=>{});await command(['volume','rm',volume]).catch(()=>{})}
 }
 report.completedAt=new Date().toISOString();checkpoint();
}finally{source.close()}
