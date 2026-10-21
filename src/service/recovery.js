import { createHmac,randomBytes } from 'node:crypto';
import { digest } from '../util/credentials.js';
import { tokenEquals } from './auth.js';
import { AppError } from '../util/error.js';
export class RecoveryService {
  constructor(store){this.store=store;this.secret=randomBytes(32);}
  context(ctx){const data=`${randomBytes(24).toString('hex')}.${Date.now()+300000}`,token=`${data}.${createHmac('sha256',this.secret).update(data).digest('hex')}`;ctx.cookies.set('media_recovery',token,{httpOnly:true,sameSite:'strict',signed:false,path:'/',maxAge:300000});return {csrfToken:token};}
  csrf(ctx){const token=ctx.get('X-CSRF-Token'),cookie=ctx.cookies.get('media_recovery',{signed:false});const [a,b,mac,...rest]=String(token).split('.');const expected=createHmac('sha256',this.secret).update(`${a}.${b}`).digest('hex');if(rest.length||!tokenEquals(token,cookie)||!tokenEquals(mac,expected)||!Number.isFinite(Number(b))||Number(b)<=Date.now())throw new AppError('找回请求已失效，请刷新重试',403);}
  verify(passkey,ip){this.store.attempt('recovery',ip);if(typeof passkey!=='string'||!/^v1:[a-f0-9]{64}$/.test(passkey.trim())||!tokenEquals(digest(passkey.trim()),this.store.credential().passkeyDigest))throw new AppError('恢复密钥无效',401);return {username:this.store.credential().username,token:this.store.createRecovery(),expires:Date.now()+300000};}
  reset(token,password,confirm,ip){this.store.attempt('recovery',ip);if(password!==confirm)throw new AppError('两次密码输入不一致');this.store.consumeRecovery(token,password);this.store.clearAttempts('login',ip);return {ok:true};}
}
