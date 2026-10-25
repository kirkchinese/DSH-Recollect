import zh from './zh.js';
import en from './en.js';

export const LANGS = ['zh', 'en'];
export function texts(lang = 'zh') {
  return lang === 'en' ? en : zh;
}
