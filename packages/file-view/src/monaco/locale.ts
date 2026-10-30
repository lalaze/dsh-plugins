// Monaco's menus, widgets and command names in Chinese when the page that loads the bundle asks for them; see
// `loadMonaco`. Its messages are read as its modules load, so this runs before them.
import zh from 'dsh-nls:zh-cn';

const scope = globalThis as { [key: symbol]: unknown; _VSCODE_NLS_MESSAGES?: string[]; _VSCODE_NLS_LANGUAGE?: string };
if (scope[Symbol.for('dsh-plugins.editor.locale')] === 'zh') { scope._VSCODE_NLS_MESSAGES = zh; scope._VSCODE_NLS_LANGUAGE = 'zh-cn'; }
