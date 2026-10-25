import { createI18n } from '@dsh-plugins/i18n';

export const i18n = createI18n('dsh-browser-devtools', {
  'Open page debugger': '打开调试浮窗',
  'Close page debugger': '关闭调试浮窗',
  'Opening page debugger…': '正在打开调试浮窗…',
  'The page debugger will be available after the page loads': '网页加载后可打开调试浮窗',
  'Dismiss message': '关闭提示',
  'The page is not ready for the debugger. Reload the page and try again.': '当前网页尚未准备好调试浮窗，请重新加载网页后再试。',
  'Could not open the in-page debugger. Reload the page and try again.': '无法在当前网页打开调试浮窗，请重新加载网页后再试。',
});
export const { ui, installLocale, activeLocale } = i18n;
