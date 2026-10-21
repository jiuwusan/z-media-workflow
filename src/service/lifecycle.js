import { randomUUID } from 'node:crypto';
import { AppError } from '../util/error.js';

export class LifecycleService {
  constructor({ managed = false, shutdown } = {}) {
    this.instanceId = randomUUID(); this.supported = managed && typeof shutdown === 'function';
    this.shutdown = shutdown; this.pending = false; this.launched = false;
  }
  status() { return { instanceId: this.instanceId, supported: this.supported, pending: this.pending }; }
  prepare(input, services) {
    if (!this.supported) throw new AppError('当前服务未由 PM2 管理，请使用 PM2 启动后重试', 409);
    if (this.pending) throw new AppError('服务正在重启，请勿重复操作', 409);
    const view = services.configuration.get();
    if (input.revision !== view.revision) throw new AppError('配置已被修改，请重新读取后再重启', 409);
    const summary = services.workflow?.summary();
    if (summary?.running || summary?.queued || ['queued', 'running'].some(status => summary?.counts?.[status])) throw new AppError('存在排队或执行中任务，请处理完任务后再重启', 409);
    if (services.qbittorrent?.cleanupRunning) throw new AppError('种子清理正在执行，请完成后再重启', 409);
    this.workflow = services.workflow;
    if (this.workflow?.stopping) throw new AppError('服务正在关闭', 503);
    this.pending = true;
    if (this.workflow) this.workflow.stopping = true;
    return this.status();
  }
  async launch() {
    if (!this.pending || this.launched) return;
    this.launched = true;
    try { await this.shutdown(); }
    catch (error) {
      this.pending = false; this.launched = false;
      if (this.workflow) this.workflow.stopping = false;
      throw error;
    }
  }
}
