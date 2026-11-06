import { randomBytes } from 'node:crypto';
import { writeRecoveryPasskey } from '../storage/recovery-passkey.js';
import path from 'node:path';
import { DEFAULT_CONFIG, runtimeConfig, validateConfig } from '../config/index.js';
import { openWorkflowDatabase } from '../storage/database.js';
import { ApplicationRepository } from '../storage/application-repository.js';
import { CursorRepository, parseCursorSnapshot } from '../storage/cursor-repository.js';
import { digest } from '../util/credentials.js';
import { AppError } from '../util/error.js';
import { tokenEquals } from './auth.js';
import { log } from '../util/logger.js';
const allowed=['ADMIN_USERNAME','ADMIN_PASSWORD','PUBLIC_URL','QBT_URL','QBT_API_KEY','JELLYFIN_URL','JELLYFIN_API_KEY','DEEPSEEK_URL','DEEPSEEK_API_KEY','DEEPSEEK_MODEL','WORKFLOW_CALLBACK_URL','WEBHOOK_AUTH_ENABLED','WORKFLOW_API_TOKEN','COOKIE_SECURE','TRUST_PROXY','cursor'];
export class SetupService {
  #passkey;
  constructor(location=path.resolve('data')) {
    this.directory=path.extname(location)==='.json'?path.dirname(location):location;
    this.filename=path.join(this.directory,'config.json');
    this.database=openWorkflowDatabase(path.join(this.directory,'workflow.sqlite'));
    try {
      this.store=new ApplicationRepository(this.database);this.config=runtimeConfig(this.store,this.directory);
      this.#passkey='v1:'+randomBytes(32).toString('hex');
      writeRecoveryPasskey(this.directory,this.#passkey);
      this.store.rotatePasskey(digest(this.#passkey));
      log('recovery.passkey.generated',{passkey:this.#passkey,message:'本次启动的账号恢复密钥；服务重启后旧密钥失效'});
    } catch(error) { this.database.close();throw error; }
    this.nonce=randomBytes(24).toString('hex');
    this.bootstrap={host:'0.0.0.0',port:3000,publicUrl:'http://localhost:3000/',trustProxy:false,shutdownMs:30000};
  }
  get initialized(){return this.store.initialized;}
  status(){return this.initialized?{initialized:true}:{initialized:false,csrfToken:this.nonce};}
  complete(command,prepare=()=>{}) {
    if(this.initialized)throw new AppError('服务已完成初始化，不能重复配置',409);
    const {input,cookieToken,csrfToken}=command??{};
    if(!tokenEquals(cookieToken,this.nonce)||!tokenEquals(csrfToken,this.nonce))throw new AppError('初始化 CSRF 校验失败，请刷新页面',403);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw new AppError('初始化参数无效');
    if(!input.cursor||!['import','skip'].includes(input.cursor.mode)||Object.keys(input.cursor).some(k=>!['mode','data'].includes(k)))throw new AppError('请选择同步游标或跳过');
    const snapshot=input.cursor.mode==='import'?parseCursorSnapshot(input.cursor.data):{version:1,libraries:{}};
    const {cursor,...fields}=input;
    if(input.WORKFLOW_API_TOKEN!==undefined&&typeof input.WORKFLOW_API_TOKEN!=='string')throw new AppError('WORKFLOW_API_TOKEN 必须为字符串');
    const document={...DEFAULT_CONFIG,...fields,WORKFLOW_API_TOKEN:input.WORKFLOW_API_TOKEN||randomBytes(32).toString('hex'),torrentCleanup:{deleteFiles:false}};
    validateConfig(document,this.filename);
    const configured=this.database.transaction(()=>{
      this.store.initialize(document,digest(this.#passkey),()=>new CursorRepository(this.database).importSnapshot(snapshot));
      this.store.audit.append('初始化',this.store.readConfig().revision,{}, {cursorSync:{mode:cursor.mode,...new CursorRepository(this.database).summary()}});
      const config=runtimeConfig(this.store,this.directory);prepare(config);return config;
    });
    this.config=configured;return configured;
  }
  close(){this.database.close();}
}
