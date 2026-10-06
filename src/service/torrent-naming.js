import { episodeFilename, renamedEpisodePath } from '../util/torrent-naming.js';
import { AppError } from '../util/error.js';
import { sleep } from '../util/http.js';
import { redact } from '../util/logger.js';
const seriesCategory = torrent => typeof torrent.category === 'string' && /series/i.test(torrent.category);

export class TorrentNamingService {
  constructor(config, qbittorrent, deepseek, secrets = []) { this.config = config; this.qbt = qbittorrent; this.ai = deepseek; this.secrets = secrets; }
  async filesReady(hash) {
    const deadline = Date.now() + (this.config.torrentFilesTimeoutMs ?? 120000);
    do {
      const files = await this.qbt.files(hash);
      if (!Array.isArray(files)) throw new AppError('qBittorrent 文件列表无效', 502);
      if (files.length) return files;
      await sleep(this.config.pollMs);
    } while (Date.now() < deadline);
    throw new AppError('等待种子元数据及文件列表超时，请重试任务', 504);
  }
  async run(job, update) {
    if (!job.input.checkExisting) return this.checkTorrent(job, job.input.hash, update);
    update(job, '读取已有种子');
    const torrents = await this.qbt.torrents();
    if (!Array.isArray(torrents)) throw new AppError('qBittorrent 种子列表无效', 502);
    const targets = torrents.filter(seriesCategory);
    for (const torrent of targets) {
      try { await this.checkTorrent(job, torrent.hash, update); }
      catch (error) { job.items.push({ itemId: `${torrent.hash}:torrent`, torrentHash: torrent.hash, torrentName: torrent.name, type: 'File', originalName: torrent.name ?? torrent.hash, path: '', status: 'failed', error: redact(error.message, this.secrets) }); }
    }
    job.message = targets.length ? `已检查 ${targets.length} 个分类包含 series 的种子` : '没有分类包含 series 的已有种子';
  }
  async checkTorrent(job, hash, update) {
    update(job, '检查种子分类');
    const torrent = await this.qbt.torrent(hash);
    if (!seriesCategory(torrent)) {
      if (!job.input.checkExisting) job.message = '种子分类不包含 series，已跳过文件检查';
      return;
    }
    update(job, '等待种子文件列表');
    const files = await this.filesReady(hash);
    const decisions = new Map();
    for (const file of files) {
      const parsed = episodeFilename(file.name);
      if (!parsed) continue;
      const entry = { itemId: `${hash}:${file.index}`, torrentHash: hash, torrentName: torrent.name, type: 'File', originalName: file.name, path: file.name, status: 'running' };
      job.items.push(entry);
      try {
        if (!Number.isInteger(file.index)) throw new AppError('qBittorrent 文件索引无效', 502);
        update(job, `AI 判断季号：${parsed.title}`);
        const key = JSON.stringify([parsed.directory, parsed.title, parsed.suffix]);
        if (!decisions.has(key)) decisions.set(key, await this.ai.identifySeason({ torrent: torrent.name, path: file.name, title: parsed.title }));
        const decision = decisions.get(key);
        entry.seasonDecision = { ...decision, reason: redact(decision.reason, this.secrets) };
        const useDefault = decision.confidence !== 'high' || decision.season == null;
        if (useDefault) entry.message = 'AI 无法可靠确定季号，默认使用 S01';
        entry.newPath = renamedEpisodePath(parsed, useDefault ? { season: 1, removeTitleSuffix: null } : decision);
        if (!seriesCategory(await this.qbt.torrent(hash))) { entry.status = 'skipped'; entry.message = '种子分类已不包含 series，已停止重命名'; continue; }
        const current = await this.qbt.files(hash), actual = current.find(f => f.index === file.index);
        if (actual?.name === entry.newPath) { entry.status = 'completed'; continue; }
        if (actual?.name !== file.name) throw new AppError('文件名在检查期间发生变化，请重试', 409);
        if (current.some(f => f.index !== file.index && f.name.toLowerCase() === entry.newPath.toLowerCase())) throw new AppError('目标文件名已存在，已停止重命名', 409);
        update(job, `规范文件名：${file.name}`);
        let renameError;
        try { await this.qbt.renameFile(hash, file.name, entry.newPath); } catch (error) { renameError = error; }
        const deadline = Date.now() + this.config.requestTimeoutMs;
        let confirmed = false;
        do {
          const renamed = (await this.qbt.files(hash)).find(f => f.index === file.index);
          if (renamed?.name === entry.newPath) { confirmed = true; break; }
          await sleep(this.config.pollMs);
        } while (Date.now() < deadline);
        if (!confirmed) throw renameError ?? new AppError('文件重命名回读确认超时，请重试任务', 504);
        entry.status = 'completed';
      } catch (error) { entry.status = 'failed'; entry.error = redact(error.message, this.secrets); }
    }
    if (!job.items.length) job.message = '没有需要补充季号的影视文件';
  }
}
