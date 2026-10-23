import React, { useEffect, useState } from 'react';
import { defaultTranslationSettings, type TranslationSettings } from '../settings.js';
import { translate } from './api.js';
import { localizeError, ui } from './i18n.js';

const fields: Array<[keyof TranslationSettings, string, boolean]> = [
  ['apiUrl', 'API URL', false], ['apiKey', 'API Key', true], ['model', 'Model', false],
  ['fallbackApiUrl', 'Fallback API URL', false], ['fallbackApiKey', 'Fallback API Key', true], ['fallbackModel', 'Fallback model', false],
];
export function TranslationSettingsSection() {
  const [settings, setSettings] = useState<TranslationSettings>(() => ({ ...defaultTranslationSettings }));
  const [text, setText] = useState(''); const [target, setTarget] = useState<'auto' | 'zh-CN' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru'>('auto');
  const [result, setResult] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  useEffect(() => { try { const raw = localStorage.getItem('dsh-translate.settings.v1'); if (raw) setSettings(JSON.parse(raw)); } catch {} }, []);
  const update = (key: keyof TranslationSettings, value: string) => setSettings(previous => ({ ...previous, [key]: value }));
  const save = () => { localStorage.setItem('dsh-translate.settings.v1', JSON.stringify(settings)); setSaved(true); setTimeout(() => setSaved(false), 1800); };
  const run = async () => { setBusy(true); setError(''); try { setResult((await translate(text, target, settings)).translation); } catch (e) { setError(localizeError(e)); } finally { setBusy(false); } };
  return <section className="dsh-translate-settings" aria-label={ui('Translation', '翻译')}>
    <style>{`.dsh-translate-settings{padding:20px;max-width:760px;color:var(--dsh-foreground,#e4e4e7)}.dsh-translate-settings h2{margin:0 0 6px;font-size:20px}.dsh-translate-settings p{color:var(--dsh-foreground-muted,#a1a1aa);font-size:13px}.dsh-translate-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.dsh-translate-field{display:flex;flex-direction:column;gap:5px;font-size:12px}.dsh-translate-field input,.dsh-translate-field textarea,.dsh-translate-field select{border:1px solid var(--dsh-border,#3f3f46);border-radius:6px;background:var(--dsh-background,#18181b);color:inherit;padding:8px}.dsh-translate-wide{grid-column:1/-1}.dsh-translate-actions{display:flex;gap:8px;align-items:center;margin:14px 0}.dsh-translate-button{border:1px solid var(--dsh-border,#52525b);border-radius:6px;padding:7px 12px;background:var(--dsh-button,#27272a);color:inherit;cursor:pointer}.dsh-translate-button:disabled{opacity:.5}.dsh-translate-error{color:#fca5a5}.dsh-translate-result{white-space:pre-wrap;background:color-mix(in srgb,var(--dsh-accent,#60a5fa) 8%,transparent);padding:12px;border-radius:6px;min-height:40px}`}</style>
    <h2>{ui('Translation API', '翻译 API')}</h2><p>{ui('Use any OpenAI-compatible Chat Completions endpoint. API keys stay in this browser profile.', '使用任意兼容 OpenAI Chat Completions 的接口。API Key 保存在当前浏览器配置中。')}</p>
    <div className="dsh-translate-grid">{fields.map(([key, label, secret]) => <label className="dsh-translate-field" key={key}>{ui(label, label === 'Model' ? '模型' : label === 'API URL' ? 'API 地址' : label === 'API Key' ? 'API Key' : label)}<input type={secret ? 'password' : 'text'} value={settings[key]} onChange={event => update(key, event.target.value)} /></label>)}<label className="dsh-translate-field dsh-translate-wide">{ui('Automatic English lock model keywords', '自动英文锁模型关键词')}<input value={settings.englishLockModels} onChange={event => update('englishLockModels', event.target.value)} placeholder="claude, anthropic" /></label></div>
    <div className="dsh-translate-actions"><button className="dsh-translate-button" onClick={save}>{saved ? ui('Saved', '已保存') : ui('Save settings', '保存设置')}</button></div>
    <hr />
    <h2>{ui('Translate text', '翻译文字')}</h2><div className="dsh-translate-grid"><label className="dsh-translate-field dsh-translate-wide"><span>{ui('Text', '原文')}</span><textarea rows={5} value={text} onChange={event => setText(event.target.value)} /></label><label className="dsh-translate-field"><span>{ui('Target', '目标语言')}</span><select value={target} onChange={event => setTarget(event.target.value as typeof target)}>{[['auto','自动'],['zh-CN','中文'],['en','英语'],['ja','日语'],['ko','韩语'],['fr','法语'],['de','德语'],['es','西班牙语'],['ru','俄语']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div><div className="dsh-translate-actions"><button className="dsh-translate-button" disabled={busy || !text.trim()} onClick={() => void run()}>{busy ? ui('Translating…', '翻译中…') : ui('Translate', '翻译')}</button>{result && <button className="dsh-translate-button" onClick={() => void navigator.clipboard?.writeText(result)}>{ui('Copy', '复制')}</button>}</div>{error && <p className="dsh-translate-error" role="alert">{error}</p>}{result && <div className="dsh-translate-result" role="status">{result}</div>}
  </section>;
}
