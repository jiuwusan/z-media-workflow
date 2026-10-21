import { DEFAULT_CONFIG,CONFIG_FIELDS,validateConfig } from '../config/index.js';
import { AppError } from '../util/error.js';
import { openWorkflowDatabase } from '../storage/database.js';
import { ApplicationRepository } from '../storage/application-repository.js';
import { secretFields } from '../storage/audit-repository.js';
const fieldValue=(config,field)=>field.split('.').reduce((value,key)=>value?.[key],config);
export function configurationStore(config) {
  if(config.store)return config.store;
  const store=new ApplicationRepository(openWorkflowDatabase(':memory:'));
  const document={...DEFAULT_CONFIG,ADMIN_USERNAME:config.adminUsername??'admin',ADMIN_PASSWORD:config.adminPassword??'test-only-password'};
  for(const [key,[field]] of Object.entries(CONFIG_FIELDS)){const value=fieldValue(config,field);if(value!==undefined)document[key]=value;}
  store.initialize(document,'');return store;
}
export class ConfigurationService {
  constructor(config){this.runtime=config;this.filename=config.configFile;this.store=configurationStore(config);}
  read(){const record=this.store.readConfig();if(!record)throw new AppError('请先完成首次运行配置',503);return record.document;}
  view(document,revision=this.store.readConfig().revision){
    const saved=validateConfig(document,this.filename,this.store.credential()),values={},secrets={};
    for(const [key,[,type]] of Object.entries(CONFIG_FIELDS)){
      if(secretFields.has(key))secrets[key]=key==='ADMIN_PASSWORD'?Boolean(this.store.credential()):Boolean(document[key]);
      else values[key]=document[key]??DEFAULT_CONFIG[key]??(type==='string'?'':undefined);
    }
    const restartRequired=Object.entries(CONFIG_FIELDS).some(([key,[field]])=>!['ADMIN_USERNAME','ADMIN_PASSWORD'].includes(key)&&JSON.stringify(fieldValue(saved,field))!==JSON.stringify(fieldValue(this.runtime,field)));
    return {values,secretFields:secrets,revision,restartRequired};
  }
  get(){return this.view(this.read());}
  save(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['values','revision'].includes(k))||!input.values||typeof input.values!=='object'||Array.isArray(input.values)||typeof input.revision!=='string')throw new AppError('配置保存参数无效');
    return this.store.database.transaction(()=>{
      const patch={};
      for(const [key,value] of Object.entries(input.values)){if(!Object.hasOwn(CONFIG_FIELDS,key))throw new AppError('存在不支持的配置项');if(secretFields.has(key)&&value==='')continue;patch[key]=value;}
      validateConfig({...this.read(),...patch},this.filename,this.store.credential());
      const result=this.store.updateConfig(patch,{revision:input.revision});return this.view(result.document,result.revision);
    });
  }
}
