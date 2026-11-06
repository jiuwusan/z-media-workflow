import { pagination } from '../util/validation.js';
export function historyController(services) {
 return {
  configuration(ctx) { ctx.body={data:services.configuration.store.audit.list(pagination(ctx.query))}; },
  cleanup(ctx) { ctx.body={data:services.qbittorrent.history.list(pagination(ctx.query))}; },
  cleanupDetail(ctx) {
   if(!/^[1-9][0-9]*$/.test(ctx.params.id)||!Number.isSafeInteger(Number(ctx.params.id)))ctx.throw(400,'清理记录 ID 无效');
   ctx.body={data:services.qbittorrent.history.get(Number(ctx.params.id))};
  }
 };
}
export function recoveryController(recovery) {
 return {
  context(ctx) { const token=recovery.createChallenge();ctx.cookies.set('media_recovery',token,{httpOnly:true,sameSite:'strict',signed:false,path:'/',maxAge:300000});ctx.body={data:{csrfToken:token}}; },
  verify(ctx) { recovery.validateChallenge(ctx.get('X-CSRF-Token'),ctx.cookies.get('media_recovery',{signed:false}));ctx.body={data:recovery.verify(ctx.request.body?.passkey,ctx.ip)}; },
  reset(ctx) { recovery.validateChallenge(ctx.get('X-CSRF-Token'),ctx.cookies.get('media_recovery',{signed:false}));const b=ctx.request.body??{};ctx.body={data:recovery.reset(b.token,b.password,b.confirmPassword,ctx.ip)}; }
 };
}
