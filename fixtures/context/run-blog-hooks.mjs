// Hook acceptance only; the blog is a disposable test fixture, never a product target.
// Requires an existing CLI and --workspace; no global config changes or model inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, unlink, realpath } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { startMcpServer } from '../../tests/helpers/mcp-client.mjs';
import { workspaceFile } from '../../src/workspace.mjs';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const flag=name=>{const i=process.argv.indexOf(name);assert.ok(i>=0&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'),'Missing '+name);return process.argv[i+1];};
const rows=text=>text.split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const sha=data=>createHash('sha256').update(data).digest('hex');
const here=fileURLToPath(import.meta.url);
if(process.argv.includes('--hook')){
  let text='';for await(const chunk of process.stdin)text+=chunk;
  const event=JSON.parse(text);const child=spawn(process.execPath,[join(repo,'src/context-hook.mjs'),'--workspace',flag('--workspace'),'--rules',flag('--rules')],{stdio:['pipe','pipe','inherit'],windowsHide:true});
  let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',part=>output+=part);child.stdin.end(text);
  const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});assert.equal(code,0);
  const result=JSON.parse(output);await appendFile(flag('--log'),JSON.stringify({event:event.hook_event_name,source:event.source,session_id:event.session_id,turn_id:event.turn_id,result})+'\n');
  // Harness stop prevents any model request, while preserving the core's original non-blocking output in evidence.
  process.stdout.write(JSON.stringify(event.hook_event_name==='UserPromptSubmit'?{...result,continue:false,stopReason:'Hook-only acceptance stops before inference.'}:result)+'\n');
}else{
  const root=await realpath(resolve(flag('--workspace'))),exe=resolve(flag('--codex'));
  await workspaceFile(root,'slop/.sol-hook-boundary-check',{allowMissing:true});await mkdir(join(root,'slop'),{recursive:true});
  const run=await mkdtemp(join(root,'slop','hook-closeout-'));const prefix=relative(root,run).replaceAll('\\','/');const configPath=prefix+'/context.json';const probe=prefix+'/probe.mjs';const log=join(run,'hooks.jsonl');
  const original=JSON.parse(await readFile(join(repo,'context.example.json'),'utf8'));await writeFile(join(run,'context.json'),JSON.stringify(original));await writeFile(join(run,'probe.mjs'),'export const probe=1;\n');await writeFile(log,'');
  const hooksPath=await workspaceFile(root,'.codex/hooks.json',{allowMissing:true});await mkdir(join(root,'.codex'),{recursive:true});let previous;
  try{previous=await readFile(hooksPath);}catch(e){if(e.code!=='ENOENT')throw e;}
  const before=new Map();for(const path of ['src/server.mjs','src/lib/html.mjs','src/lib/posts.mjs','src/views/home.mjs','src/views/post.mjs','data/posts.json','public/style.css'])before.set(path,sha(await readFile(join(root,path))));
  const quote=value=>{assert.ok(!/["$`\r\n]/u.test(value),'Unsupported shell characters in fixture path');return '"'+value.replaceAll('\\','/')+'"';};
  const command=`node ${quote(here)} --hook --workspace ${quote(root)} --rules ${quote(configPath)} --log ${quote(log)}`;
  const hooks={hooks:{SessionStart:[{hooks:[{type:'command',command,timeout:30}]}],UserPromptSubmit:[{hooks:[{type:'command',command,timeout:30}]}]}};
  await writeFile(hooksPath,JSON.stringify(hooks));const trust=`projects={${JSON.stringify(root.toLowerCase())}={trust_level="trusted"}}`;
  function host(extra=[]){
    const child=spawn(exe,['app-server','-c',trust,'-c','features.hooks=true','-c','features.plugins=false','-c','notify=[]',...extra],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});const pending=new Map();const notes=[];let seq=0;child.stderr.resume();const lines=createInterface({input:child.stdout});const closed=new Promise(res=>child.once('close',res));let closing=false;
    lines.on('line',text=>{const row=JSON.parse(text);if(pending.has(row.id)){const slot=pending.get(row.id);pending.delete(row.id);clearTimeout(slot.timer);row.error?slot.reject(new Error(JSON.stringify(row.error))):slot.resolve(row.result);}else notes.push(row);});
    child.on('error',error=>{for(const slot of pending.values()){clearTimeout(slot.timer);slot.reject(error);}});
    child.on('close',()=>{for(const slot of pending.values()){clearTimeout(slot.timer);slot.reject(new Error('Host exited'));}});
    const request=(method,params)=>new Promise((res,rej)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);rej(new Error('RPC timeout: '+method));},30000);pending.set(id,{resolve:res,reject:rej,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
    return {request,notes,async init(){await request('initialize',{clientInfo:{name:'sol_blog_hook_test',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');},async close(){if(!closing){closing=true;child.stdin.end();child.kill();}await closed;lines.close();}};
  }
  let h,client;
  try{
    h=host();await h.init();const listed=(await h.request('hooks/list',{cwds:[root]})).data[0];assert.deepEqual(listed.errors,[]);assert.equal(listed.hooks.length,2);assert.ok(listed.hooks.every(x=>x.command===command));const trusted=`hooks.state={${listed.hooks.map(x=>`${JSON.stringify(x.key)}={trusted_hash=${JSON.stringify(x.currentHash)}}`).join(',')}}`;await h.close();
    h=host(['-c',trusted]);await h.init();const started=await h.request('thread/start',{cwd:root,model:'gpt-6-astra',sandbox:'danger-full-access',approvalPolicy:'never',ephemeral:true});const id=started.thread.id;
    const send=async()=>{const reply=await h.request('turn/start',{threadId:id,input:[{type:'text',text:'Synthetic hook acceptance; stop before inference.'}]});const limit=Date.now()+30000;while(!h.notes.some(n=>n.method==='turn/completed'&&n.params.turn?.id===reply.turn.id)){if(Date.now()>limit){console.log(JSON.stringify({methods:h.notes.map(n=>n.method)}));throw Error('Turn completion timeout');}await new Promise(res=>setTimeout(res,100));}const completed=h.notes.find(n=>n.method==='turn/completed'&&n.params.turn?.id===reply.turn.id);assert.equal(completed.params.turn.status,'completed');assert.equal(completed.params.turn.error,null);console.log(JSON.stringify({phase:'turn',status:completed.params.turn.status,error:completed.params.turn.error}));};await send();
    const startup=rows(await readFile(log,'utf8'));console.log(JSON.stringify({phase:'startup',id,hooks:startup}));
    client=startMcpServer({workspace:root,rulesPath:join(root,'rules.json'),env:{CODEX_SOL_CONTEXT_RULES:join(root,configPath),CODEX_SOL_HOST_EXECUTABLE:''}});await client.initialize();
    const reply=await client.request('tools/call',{name:'sol_context_prepare',arguments:{task:{id:'hook-only-'+randomUUID(),goal:'Verify Hook lifecycle without developing the blog',constraints:['test fixture only']},role:'plan',targets:[probe]},_meta:{'x-codex-turn-metadata':{thread_id:id,turn_id:randomUUID()}}});assert.equal(reply.result.isError,false);const packet=JSON.parse(reply.result.content[0].text);
    await send();await writeFile(join(run,'probe.mjs'),'export const probe=2;\n');await send();
    const observed=rows(await readFile(log,'utf8'));const prompts=observed.filter(x=>x.event==='UserPromptSubmit');assert.equal(prompts.length,3);assert.deepEqual(prompts[0].result,{});assert.deepEqual(prompts[1].result,{});assert.equal(JSON.parse(prompts[2].result.hookSpecificOutput.additionalContext).freshness,'stale');
    assert.ok(!h.notes.some(n=>n.method==='item/started'&&['agentMessage','mcpToolCall','commandExecution'].includes(n.params.item?.type)),'The Hook-only fixture produced unexpected model activity');
    for(const[path,hash]of before)assert.equal(sha(await readFile(join(root,path))),hash);
    const evidence={schema_version:1,status:'blog_hook_host_passed',date:new Date().toISOString(),workspace:root,session:id,host:'Codex app-server 0.158.0',binding_origin:'standalone MCP fixture request with real host thread UUID and synthetic turn UUID; no model invocation',core_nonblocking:true,harness_stops_before_inference:true,model_requests:0,hook_trust_bypass:false,hook_log:observed,context:packet.raw,source_hashes:Object.fromEntries(before)};await writeFile(join(run,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({phase:'passed',evidence:join(run,'evidence.json')}));
  }finally{try{await client?.close();}finally{try{await h?.close();}finally{assert.equal(await readFile(hooksPath,'utf8'),JSON.stringify(hooks),'Fixture Hooks changed concurrently; inspect before restoring.');if(previous)await writeFile(hooksPath,previous);else await unlink(hooksPath);}}}
}
