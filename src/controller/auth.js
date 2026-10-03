export function authController(config, auth) {
  const cookie = { httpOnly: true, sameSite: 'strict', secure: config.secureCookie, signed: false, overwrite: true, path: '/' };
  return {
    async login(ctx) {
      auth.checkOrigin(ctx);
      const session = await auth.login(ctx.request.body?.username, ctx.request.body?.password, ctx.ip);
      ctx.cookies.set('media_session', session.id, { ...cookie, maxAge: config.sessionMs });
      ctx.body = { data: { csrfToken: session.csrfToken, expires: session.expires } };
    },
    session(ctx) { const session = auth.session(ctx.cookies.get('media_session', { signed: false })); ctx.body = { data: { csrfToken: session?.csrfToken, expires: session?.expires, authenticated: true } }; },
    logout(ctx) { auth.logout(ctx.cookies.get('media_session', { signed: false })); ctx.cookies.set('media_session', null, cookie); ctx.body = { data: { ok: true } }; }
  };
}
