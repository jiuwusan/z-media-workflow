import path from 'node:path';
import { AppError } from './error.js';
export function normalizePath(value) {
  return path.posix.normalize(String(value ?? '').replace(/\\/g, '/')).replace(/\/$/, '');
}
export function containsPath(root, target) {
  let a = normalizePath(root), b = normalizePath(target);
  if (!root || !target) return false;
  if (/^[a-z]:/i.test(a)) { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || b.startsWith(`${a}/`);
}
export function mapPath(value, { from, to } = {}) {
  const normalized = normalizePath(value);
  return from && to && containsPath(from, value) ? normalizePath(`${to}${normalized.slice(normalizePath(from).length)}`) : normalized;
}
export const normalizeName = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const movieParts = [
  ['I', '1', 'One'], ['II', '2', 'Two'], ['III', '3', 'Three'], ['IV', '4', 'Four'], ['V', '5', 'Five'],
  ['VI', '6', 'Six'], ['VII', '7', 'Seven'], ['VIII', '8', 'Eight'], ['IX', '9', 'Nine'], ['X', '10', 'Ten'],
];
export function cleanMovieName(name) {
  const separated = name.replace(/\b(Part)(VIII|VII|III|VI|IV|IX|II|V|X|I)\b/gi, '$1 $2');
  // Only remove a known edition suffix when a nonempty title precedes it.
  const cleaned = separated.replace(/[\s._-]+[（(\[]?\s*(?:Extended[\s._-]+(?:Cut|Edition)|Director['’]s[\s._-]+Cut|Theatrical[\s._-]+Cut|Unrated[\s._-]+(?:Cut|Edition))\s*[）)\]]?\s*$/i, '').trim();
  return cleaned || separated;
}
export function movieSearchNames(name) {
  const match = /\bPart\s+(VIII|VII|III|VI|IV|IX|II|V|X|I|10|[1-9]|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\b/i.exec(name);
  if (!match) return [name];
  const equivalents = movieParts.find(parts => parts.some(part => part.toLowerCase() === match[1].toLowerCase()));
  const alternative = part => name.slice(0, match.index) + 'Part ' + part + name.slice(match.index + match[0].length);
  // Word-form installments give providers a more specific query than "Part I".
  return [...new Set([alternative(equivalents[2]), name, alternative(equivalents[0]), alternative(equivalents[1])])];
}
export function providerEntries(item) { return Object.entries(item.ProviderIds ?? {}).filter(([k, v]) => /^(tmdb|tvdb|imdb)$/i.test(k) && v).map(([k, v]) => [k.toLowerCase(), String(v)]); }
export function hasIdentity(item) { return providerEntries(item).length > 0; }
export const hasChineseName = item => /\p{Script=Han}/u.test(item.Name ?? '');
export function compareProviderIdentity(a, b) {
  const ids = new Map(providerEntries(a));
  const shared = providerEntries(b).filter(([key]) => ids.has(key));
  if (shared.some(([key, value]) => ids.get(key) !== value)) return 'conflict';
  return shared.length ? 'same' : 'unknown';
}
export function isLaterSeasonCandidate(identity, candidate, type, decision) {
  return type === 'Series' && Number.isInteger(identity.year) && Number.isInteger(candidate.ProductionYear)
    && candidate.ProductionYear < identity.year && decision?.confidence === 'high'
    && decision.yearRelation === 'later_season' && Number.isInteger(decision.season)
    && decision.season > 1 && decision.season <= 99;
}
export function selectCandidate(identity, candidates) {
  const matches = candidates.filter(c => hasIdentity(c) && [c.Name, c.OriginalTitle].filter(Boolean).some(n => normalizeName(n) === normalizeName(identity.name)) && (identity.year == null || c.ProductionYear === identity.year));
  const unique = new Map(matches.map(c => [JSON.stringify(providerEntries(c).sort()), c]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}
export function mediaSource(item) {
  const file = path.posix.basename(normalizePath(item.Path));
  return item.Type === 'Series' ? file : file.replace(/\.[^.]+$/, '');
}
export function validateIdentity(input) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 300) throw new AppError('识别结果缺少有效媒体名称', 422);
  const year = input.year ?? null;
  if (year !== null && (!Number.isInteger(year) || year < 1800 || year > new Date().getFullYear() + 5)) throw new AppError('识别年份无效', 422);
  return { name: input.name.trim(), year };
}
export const isVideo = value => /\.(mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|webm|iso)$/i.test(value);
