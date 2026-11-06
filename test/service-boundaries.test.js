import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/service/auth.js';
import { RecoveryService } from '../src/service/recovery.js';
test('admin authorization accepts plain tokens, preserves CSRF rejection and returns session', async () => {
 const auth=new AuthService({adminUsername:'admin',adminPassword:'test-password',sessionMs:60000});
 const session=await auth.login('admin','test-password','fixture-ip');
 assert.equal(auth.authorizeAdmin({sessionId:session.id}),auth.session(session.id));
 assert.throws(()=>auth.authorizeAdmin({sessionId:session.id,requireCsrf:true,csrfToken:'wrong'}),e=>e.status===403);
 assert.equal(auth.authorizeAdmin({sessionId:session.id,requireCsrf:true,csrfToken:session.csrfToken}).csrfToken,session.csrfToken);
 auth.logout(session.id);assert.throws(()=>auth.authorizeAdmin({sessionId:session.id}),e=>e.status===401);
});
test('webhook authorization remains independent from admin sessions', () => {
 const auth=new AuthService({workflowToken:'fixture-token',webhookAuthRequired:true});
 assert.throws(()=>auth.authorizeWebhook('wrong'),e=>e.status===401);
 assert.doesNotThrow(()=>auth.authorizeWebhook('fixture-token'));
 auth.config.webhookAuthRequired=false;assert.doesNotThrow(()=>auth.authorizeWebhook(undefined));
});
test('recovery challenge checks plain values and rejects substitution, tampering, expiry and restart', t => {
 const recovery=new RecoveryService({}),token=recovery.createChallenge();
 assert.doesNotThrow(()=>recovery.validateChallenge(token,token));
 assert.throws(()=>recovery.validateChallenge(token,'wrong'),e=>e.status===403);
 const tampered='x'+token;assert.throws(()=>recovery.validateChallenge(tampered,tampered),e=>e.status===403);
 assert.throws(()=>new RecoveryService({}).validateChallenge(token,token),e=>e.status===403);
 const later=Date.now()+300001;t.mock.method(Date,'now',()=>later);
 assert.throws(()=>recovery.validateChallenge(token,token),e=>e.status===403);
});
