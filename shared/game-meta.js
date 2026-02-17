'use strict';

function getTitleFromParam(param) {
  if (param && typeof param.titleName === 'string') return param.titleName;
  const localized = param && param.localizedParameters;
  if (!localized || typeof localized !== 'object') return null;
  let region = typeof localized.defaultLanguage === 'string' ? localized.defaultLanguage.trim() : '';
  if (!region) region = 'en-US';
  const normalized = region.replace('_', '-');
  const direct = localized[normalized] && localized[normalized].titleName;
  if (typeof direct === 'string') return direct;
  const fallback = localized['en-US'] && localized['en-US'].titleName;
  return typeof fallback === 'string' ? fallback : null;
}

function parseGameMetaFromParam(param) {
  if (!param || typeof param !== 'object') return null;
  return {
    title: getTitleFromParam(param) || 'Unknown',
    title_id: typeof param.titleId === 'string' ? param.titleId : '',
    content_id: typeof param.contentId === 'string' ? param.contentId : '',
    version: typeof param.contentVersion === 'string' ? param.contentVersion : '',
  };
}

module.exports = {
  getTitleFromParam,
  parseGameMetaFromParam,
};
