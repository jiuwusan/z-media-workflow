export const DEFAULT_SERIES_CATEGORIES = [];
export function isSeriesCategory(category, config) {
  return typeof category === 'string' && (config?.seriesCategories ?? DEFAULT_SERIES_CATEGORIES).some(name => name.toLowerCase() === category.toLowerCase());
}
