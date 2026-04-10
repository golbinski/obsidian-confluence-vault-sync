// Minimal stub so modules that import from 'obsidian' can be loaded in tests.
export const requestUrl = () => Promise.resolve({ json: {}, text: '' });
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class ItemView {}
export class Modal {}
export class Setting {}
export class ButtonComponent {}
export class TFolder {}
