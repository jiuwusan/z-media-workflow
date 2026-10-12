export function configurationController(service) {
  return {
    async get(ctx) { ctx.body = { data: service.get() }; },
    async save(ctx) { ctx.body = { data: service.save(ctx.request.body) }; }
  };
}
