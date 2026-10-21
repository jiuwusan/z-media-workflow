import { AppError } from './error.js';
export class CleanupSettingsStore {
  constructor(store){this.store=store&&typeof store.readConfig==='function'?store:null;this.settings={deleteFiles:false};}
  get(){return this.store?{deleteFiles:this.store.readConfig().document.torrentCleanup?.deleteFiles??false}:{...this.settings};}
  set(settings){if(!settings||typeof settings.deleteFiles!=='boolean')throw new AppError('deleteFiles 必须为布尔值');const next={deleteFiles:settings.deleteFiles};if(this.store)this.store.updateConfig({torrentCleanup:next},{source:'管理员'});this.settings=next;return this.get();}
}
