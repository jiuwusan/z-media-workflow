export function setupController(setup) {
  return {
    status(ctx) {
      const state = setup ? setup.status() : { initialized: true };
      if (!state.initialized) ctx.cookies.set('media_setup', state.csrfToken, { httpOnly: true, sameSite: 'strict', signed: false, maxAge: 1800000, path: '/' });
      return state;
    },
    complete(ctx, prepare) {
      const configured = setup.complete({
        input: ctx.request.body,
        cookieToken: ctx.cookies.get('media_setup', { signed: false }),
        csrfToken: ctx.get('X-CSRF-Token')
      }, prepare);
      ctx.cookies.set('media_setup', null, { signed: false, path: '/' });
      return configured;
    }
  };
}
