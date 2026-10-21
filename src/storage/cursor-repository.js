import { AppError } from '../util/error.js';
export const CURSOR_LIMIT=10*1024*1024;
const dateOf=item=>{const n=Date.parse(item.DateCreated??'');return Number.isFinite(n)?new Date(n).toISOString():null;};
export function parseCursorSnapshot(value) {
  if (Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value??null))>CURSOR_LIMIT) throw new AppError('游标 JSON 不得超过 10 MiB',413);
  let input;
  try { input=typeof value==='string'?JSON.parse(value):value; } catch { throw new AppError('游标 JSON 格式无效'); }
  const object=v=>v && typeof v==='object' && !Array.isArray(v);
  if (!object(input)||input.version!==1||!object(input.libraries)||Object.keys(input).some(k=>!['version','libraries'].includes(k))) throw new AppError('游标格式无效，仅支持 version 1');
  const libraries=Object.create(null);
  for (const [scope,cursor] of Object.entries(input.libraries)) {
    let key;
    try { key=JSON.parse(scope); const u=new URL(key[0]); if(!['http:','https:'].includes(u.protocol)||u.username||u.password) throw Error(); } catch { throw new AppError('游标媒体库范围无效'); }
    if(!Array.isArray(key)||key.length!==3||typeof key[1]!=='string'||!key[1].trim()||!['Movie','Series'].includes(key[2])) throw new AppError('游标媒体库范围无效');
    if(!object(cursor)||!(cursor.date===null||(typeof cursor.date==='string'&&Number.isFinite(Date.parse(cursor.date))))||Object.keys(cursor).some(k=>!['date','ids','pending','undated'].includes(k))) throw new AppError('游标日期或字段无效');
    const result={date:cursor.date===null?null:new Date(cursor.date).toISOString()};
    for(const kind of ['ids','pending','undated']) {
      if(!Array.isArray(cursor[kind])||cursor[kind].some(id=>typeof id!=='string'||!id.trim()||id.length>200)) throw new AppError('游标媒体 ID 列表无效');
      result[kind]=[...new Set(cursor[kind])];
    }
    libraries[JSON.stringify(key)]=result;
  }
  return {version:1,libraries};
}
export class CursorRepository {
  constructor(database,server='') { this.database=database;this.db=database.connection;this.server=server; }
  key(item) {return JSON.stringify([this.server,item.LibraryId,item.Type]);}
  has(scope,kind,id) {return Boolean(this.db.prepare('SELECT 1 FROM media_cursor_ids WHERE scope=? AND kind=? AND item_id=?').get(scope,kind,id));}
  needsIdentification(item) {
    const scope=this.key(item),cursor=this.db.prepare('SELECT date FROM media_cursors WHERE scope=?').get(scope),date=dateOf(item);
    if(!cursor||this.has(scope,'pending',item.Id))return true;
    if(!date)return !this.has(scope,'undated',item.Id);
    return !cursor.date||date>cursor.date||(date===cursor.date&&!this.has(scope,'ids',item.Id));
  }
  add(scope,kind,id) {this.db.prepare('INSERT OR IGNORE INTO media_cursor_ids VALUES(?,?,?)').run(scope,kind,id);}
  track(items) {
    this.database.transaction(()=>{for(const item of items){if(!this.needsIdentification(item))continue;const scope=this.key(item);this.db.prepare('INSERT OR IGNORE INTO media_cursors VALUES(?,NULL)').run(scope);this.add(scope,'pending',item.Id);}});
  }
  confirm(item,{verified=false}={}) {
    this.database.transaction(()=>{
      if(!this.needsIdentification(item))return;
      const scope=this.key(item);
      if(!this.has(scope,'pending',item.Id)){if(!verified)throw new Error('媒体尚未登记到识别游标，请重新扫描');this.track([item]);}
      const cursor=this.db.prepare('SELECT date FROM media_cursors WHERE scope=?').get(scope),date=dateOf(item);
      this.db.prepare("DELETE FROM media_cursor_ids WHERE scope=? AND kind='pending' AND item_id=?").run(scope,item.Id);
      if(!date)this.add(scope,'undated',item.Id);
      else if(!cursor.date||date>cursor.date){this.db.prepare("DELETE FROM media_cursor_ids WHERE scope=? AND kind='ids'").run(scope);this.db.prepare('UPDATE media_cursors SET date=? WHERE scope=?').run(date,scope);this.add(scope,'ids',item.Id);}
      else if(date===cursor.date)this.add(scope,'ids',item.Id);
    });
  }
  importSnapshot(input) {
    const snapshot=parseCursorSnapshot(input);
    this.database.transaction(()=>{
      this.db.exec('DELETE FROM media_cursors');
      for(const [scope,cursor] of Object.entries(snapshot.libraries)) {this.db.prepare('INSERT INTO media_cursors VALUES(?,?)').run(scope,cursor.date);for(const kind of ['ids','pending','undated'])for(const id of cursor[kind])this.add(scope,kind,id);}
    });
    return this.summary();
  }
  summary() {return {libraries:this.db.prepare('SELECT count(*) AS n FROM media_cursors').get().n,ids:this.db.prepare('SELECT count(*) AS n FROM media_cursor_ids').get().n};}
}
