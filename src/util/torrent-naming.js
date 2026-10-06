import path from 'node:path';
import { isVideo } from './media.js';
import { AppError } from './error.js';

function seasonMarkerNumber(marker) {
  const digits = /^(?:S|Season[ ._-]*)?(\d{1,2})$/i.exec(marker);
  if (digits) return Number(digits[1]);
  const chinese = /^第([一二三四五六七八九十\d]+)季$/.exec(marker);
  if (chinese) {
    if (/^\d{1,2}$/.test(chinese[1])) return Number(chinese[1]);
    const numbers = '一二三四五六七八九';
    if (/^[一二三四五六七八九]$/.test(chinese[1])) return numbers.indexOf(chinese[1]) + 1;
    const tens = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(chinese[1]);
    return tens ? (tens[1] ? numbers.indexOf(tens[1]) + 1 : 1) * 10 + (tens[2] ? numbers.indexOf(tens[2]) + 1 : 0) : null;
  }
  // Only canonical Roman numerals below 100, never ordinary words such as Civil.
  const roman = marker.toUpperCase();
  if (!roman || !/^(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  return [...roman].reduce((total, char, index) => total + (values[char] < (values[roman[index + 1]] ?? 0) ? -values[char] : values[char]), 0);
}

export function episodeFilename(value) {
  if (typeof value !== 'string' || !isVideo(value) || /[\\\0]/.test(value) || path.posix.isAbsolute(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) return null;
  const name = path.posix.basename(value);
  if (/(?:^|[ ._-])S\d{1,3}[ ._-]*EP?\d+/i.test(name)) return null;
  const match = /([ ._-])EP?(\d{1,4})(?=$|[ ._-])/i.exec(name);
  if (!match || match.index === 0) return null;
  return { path: value, directory: path.posix.dirname(value), title: name.slice(0, match.index), separator: match[1], episode: match[2], suffix: name.slice(match.index + match[0].length) };
}
export function renamedEpisodePath(file, decision) {
  if (!Number.isInteger(decision.season) || decision.season < 1 || decision.season > 99) throw new AppError('AI 季号无效', 502);
  let title = file.title;
  const marker = decision.removeTitleSuffix;
  if (marker != null) {
    if (typeof marker !== 'string' || seasonMarkerNumber(marker) !== decision.season || !title.endsWith(marker)) throw new AppError('AI 返回的标题季号标记无效或与季号冲突', 502);
    const prefix = title.slice(0, -marker.length);
    if (!/[ ._-]$/.test(prefix)) throw new AppError('AI 返回的标题季号标记边界无效', 502);
    title = prefix.replace(/[ ._-]+$/, '');
    if (!title) throw new AppError('移除季号标记后缺少标题', 502);
  }
  const season = String(decision.season).padStart(2, '0');
  return path.posix.join(file.directory, `${title}${file.separator}S${season}E${file.episode.padStart(2, '0')}${file.suffix}`);
}
