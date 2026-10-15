import { DEFAULT_CONFIG } from '../config/index.js';
export function isSeriesCategory(category, config) {
  return typeof category === 'string' && (config?.seriesCategories ?? DEFAULT_CONFIG.SERIES_CATEGORIES).some(name => name.toLowerCase() === category.toLowerCase());
}
