import { AppError } from '../util/error.js';
export class CleanupRepository {
  constructor(database){this.database=database;this.db=database.connection;}
  begin(input,sourceUrl){return this.database.transaction(()=>{const now=Date.now();const payload={...input,status:'running',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),matchedCount:0,deletedCount:0,skippedCount:0,failedCount:0};const row=this.db.prepare('INSERT INTO cleanup_runs(status,created_at,updated_at,source_url,payload) VALUES(?,?,?,?,?)').run('running',now,now,sourceUrl,JSON.stringify(payload));return {...payload,id:Number(row.lastInsertRowid),sourceUrl,items:[]};});}
  get(id){const row=this.db.prepare('SELECT * FROM cleanup_runs WHERE id=?').get(id);if(!row)throw new AppError('清理记录不存在或已过期',404);return {...JSON.parse(row.payload),id:row.id,sourceUrl:row.source_url,items:this.db.prepare('SELECT payload FROM cleanup_items WHERE run_id=? ORDER BY position').all(row.id).map(r=>JSON.parse(r.payload))};}
  save(run){this.database.transaction(()=>{const {items,...payload}=run;payload.updatedAt=new Date().toISOString();this.db.prepare('UPDATE cleanup_runs SET status=?,updated_at=?,payload=? WHERE id=?').run(run.status,Date.now(),JSON.stringify(payload),run.id);this.db.prepare('DELETE FROM cleanup_items WHERE run_id=?').run(run.id);const insert=this.db.prepare('INSERT INTO cleanup_items VALUES(?,?,?,?)');items.forEach((item,index)=>insert.run(run.id,item.hash,index,JSON.stringify(item)));this.prune();});}
  prune(){this.database.transaction(()=>{this.db.prepare("DELETE FROM cleanup_runs WHERE status NOT IN ('running','interrupted') AND updated_at<?").run(Date.now()-30*86400000);this.db.exec("DELETE FROM cleanup_runs WHERE status NOT IN ('running','interrupted') AND id NOT IN (SELECT id FROM cleanup_runs WHERE status NOT IN ('running','interrupted') ORDER BY id DESC LIMIT 1000)");});}
  list({page=1,pageSize=20}={}){this.prune();return {items:this.db.prepare('SELECT id,payload,source_url FROM cleanup_runs ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize).map(r=>({...JSON.parse(r.payload),id:r.id,sourceUrl:r.source_url})),total:this.db.prepare('SELECT count(*) AS n FROM cleanup_runs').get().n,page,pageSize};}
  async recover(qbt,sourceUrl){
    const rows=this.db.prepare("SELECT id FROM cleanup_runs WHERE status IN ('running','interrupted') ORDER BY id").all();
    for(const row of rows){const run=this.get(row.id);run.status='interrupted';
      if(run.sourceUrl!==sourceUrl){run.error='来源服务地址已变化，未核对旧清理记录';this.save(run);continue;}
      for(const item of run.items){if(item.phase==='prepared'||item.status==='prepared'){
        try{await qbt.torrent(item.hash);item.status='interrupted';item.reason='种子仍存在，未重新执行删除';}
        catch(error){if(error.status===404){item.status='absent';item.phase='completed';item.reason='种子已不存在，无法确认下载文件是否删除';}else{item.status='interrupted';item.reason='目标暂不可查询，未重新执行删除';}}
      }else if(item.status==='queued'){item.status='interrupted';item.reason='执行前中断，未执行删除';}}
      if(run.items.length&&run.items.every(i=>['deleted','absent','skipped','would_delete'].includes(i.status)))run.status='reconciled';
      this.save(run);
    }
  }
}
