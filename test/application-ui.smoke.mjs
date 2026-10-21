import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp,rm,readFile,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SetupService } from '../src/service/setup.js';
import { createApp } from '../src/app.js';
for(const mode of ['skip','import'])test(`database initialization ${mode}, recovery and histories work in the browser`,{timeout:60000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'application-ui-'));
  const upstream=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(req.url.includes('/torrents/info')?JSON.stringify([{hash:'a'.repeat(40),name:'Missing test',state:'missingFiles'}]):req.url.includes('/Items')?'{}':'[]');}).listen(0,'127.0.0.1');
  await new Promise(r=>upstream.once('listening',r));
  const source=`http://127.0.0.1:${upstream.address().port}`;
  const setup=new SetupService(root),app=createApp({config:{...setup.bootstrap},setup}),server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await app.services?.close?.(1000);setup.close();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));await rm(root,{recursive:true,force:true,maxRetries:5});});
  let executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if(!executablePath&&process.platform==='win32'){const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';try{await access(edge);executablePath=edge;}catch{}}
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.goto(base+'/setup');
  await page.getByRole('textbox',{name:'管理员用户名',exact:true}).fill('admin');
  await page.getByRole('textbox',{name:'管理员密码',exact:true}).fill('first-password');
  await page.getByRole('textbox',{name:'确认密码',exact:true}).fill('first-password');
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  for(const [name,url]of [['qBittorrent','qbt'],['Jellyfin','jelly'],['DeepSeek','deep']]){
    await page.getByRole('textbox',{name:`${name} 地址`,exact:true}).fill(`${source}/${url}/`);
    await page.getByRole('textbox',{name:`${name} API 密钥`,exact:true}).fill('test-key');
  }
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  if(mode==='skip')await page.getByRole('button',{name:'跳过',exact:true}).click();
  else{
    const scope=JSON.stringify(['http://old-jelly/','lib','Movie']);
    await page.getByRole('textbox',{name:'游标 JSON',exact:true}).fill(JSON.stringify({version:1,libraries:{[scope]:{date:null,ids:[],pending:['old'],undated:[]}}}));
    await page.getByRole('button',{name:'校验并预览',exact:true}).click();
    await page.getByText('1 个范围，1 个媒体 ID',{exact:true}).waitFor();
    await page.getByText('1 个范围与当前 Jellyfin 地址不匹配，将保留原地址，不用于当前服务；对应存量媒体可能重新识别。请在初始化前确认。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'同步并继续',exact:true}).click();
  }
  await page.getByRole('button',{name:'保存并进入登录',exact:true}).click();
  await page.getByRole('heading',{name:'登录工作空间',exact:true}).waitFor();
  assert.equal(setup.database.connection.prepare('SELECT count(*) AS n FROM media_cursor_ids').get().n,mode==='skip'?0:1);
  if(mode==='import')assert.equal(JSON.parse(setup.database.connection.prepare('SELECT scope FROM media_cursors').get().scope)[0],'http://old-jelly/');
  await page.getByRole('link',{name:'找回账号',exact:true}).click();
  await page.getByRole('textbox',{name:'恢复密钥',exact:true}).fill((await readFile(path.join(root,'passkey'),'utf8')).trim());
  await page.getByRole('button',{name:'验证恢复密钥',exact:true}).click();
  await page.getByText('用户名：admin',{exact:true}).waitFor();
  await page.getByRole('textbox',{name:'新密码',exact:true}).fill('reset-password');
  await page.getByRole('textbox',{name:'确认新密码',exact:true}).fill('reset-password');
  await page.getByRole('button',{name:'重置密码',exact:true}).click();
  await page.getByRole('heading',{name:'登录工作空间',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'用户名',exact:true}).fill('admin');await page.getByRole('textbox',{name:'密码',exact:true}).fill('reset-password');
  await page.getByRole('button',{name:'进入管理面板',exact:true}).click();
  await page.getByRole('link',{name:'基础配置',exact:true}).click();await page.getByRole('heading',{name:'配置修改记录',exact:true}).waitFor();
  await page.getByRole('link',{name:'种子清理',exact:true}).click();
  await page.getByRole('button',{name:'预览清理',exact:true}).click();
  const history=page.locator('section').filter({has:page.getByRole('heading',{name:'清理执行记录',exact:true})});
  await history.getByRole('button',{name:'详情',exact:true}).first().click();
  await page.getByRole('dialog',{name:'清理记录详情',exact:true}).getByText('Missing test',{exact:true}).waitFor();
  assert.equal(await page.getByText('游标管理',{exact:true}).count(),0);assert.deepEqual(errors,[]);
});
