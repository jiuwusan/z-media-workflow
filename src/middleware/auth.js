export function authenticationMiddleware(auth) {
  const admin = async (ctx, next) => {
    ctx.state.session = auth.authorizeAdmin({
      sessionId: ctx.cookies.get('media_session', { signed: false }),
      csrfToken: ctx.get('X-CSRF-Token'),
      requireCsrf: !['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)
    });
    await next();
  };
  const webhook = async (ctx, next) => {
    const authorization = ctx.get('Authorization');
    auth.authorizeWebhook(authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined);
    await next();
  };
  const cleanup = async (ctx, next) => !ctx.get('Authorization') && ctx.cookies.get('media_session', { signed: false }) ? admin(ctx, next) : webhook(ctx, next);
  return { admin, webhook, cleanup };
}
