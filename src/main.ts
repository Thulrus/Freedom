import './ui/styles.css';
import { App } from './app';
import { loadJson } from './platform/storage';
import { mergeSettings } from './settings';

const settings = mergeSettings(loadJson('settings'));
const app = new App(settings, document.getElementById('view') as HTMLCanvasElement, document.getElementById('ui') as HTMLElement);
app.start();
// Handy for debugging from the console and for automated smoke tests.
(window as unknown as { freedom: App }).freedom = app;
