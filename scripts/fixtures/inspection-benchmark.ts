import '../../src/style.css';
import '../../src/decryption.css';
import { ArchiveScene } from '../../src/scene';
import { ModelViewer } from '../../src/model-viewer';
import { TerminalDeck, TERMINAL_INSPECTION_PARTS } from '../../src/ssh/terminal-deck';
import { SshClient } from '../../src/ssh/client';
import { SshTerminalPanel } from '../../src/ssh/terminal';
import { paintTheme, setPalette } from '../../src/theme-ui';

document.documentElement.dataset.desktop = 'true';
setPalette('warm'); paintTheme(0);
const stage = document.querySelector<HTMLElement>('#stage')!;
Object.assign(stage.style, { width: '1920px', height: '1080px', transform: 'none', left:'0', top:'0' });
const scene = new ArchiveScene(document.querySelector('#three-scene')!);
await scene.load();
const client = new SshClient();
const terminal = new SshTerminalPanel(client, stage, () => {}, () => {}, () => {});
const viewer = new ModelViewer(document.querySelector('#viewport')!, () => {});
let running = true;
function frame(time: number) { if (!running) return; viewer.update(time / 1000); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
const wait = (condition: () => boolean) => new Promise<void>(resolve => { function check() { if (condition()) resolve(); else requestAnimationFrame(check); } check(); });
Object.assign(window, { benchmark: {
  async run(kind: 'archive' | 'terminal') {
    if (viewer.isOpen) { viewer.close(); await wait(() => !viewer.isOpen); }
    viewer.open('BENCH', kind, () => kind === 'archive' ? scene.createAssemblyModel() : TerminalDeck.inspection(client, terminal, () => scene.createAssemblyModel()), false,
      kind === 'terminal' ? { kind:'terminal', parts:TERMINAL_INSPECTION_PARTS } : {});
    await wait(() => Boolean(JSON.parse(viewer.root.dataset.stats || '{}').ready));
    viewer.root.querySelector<HTMLButtonElement>('[data-viewer="explode"]')!.click();
    await wait(() => JSON.parse(viewer.root.dataset.stats || '{}').spread === 1);
    const samples: number[] = [];
    await new Promise<void>(resolve => {
      let previous = 0, warmup = 45;
      function sample(time: number) {
        if (samples.length % 6 === 0) viewer.root.dispatchEvent(new KeyboardEvent('keydown', { key: samples.length % 24 < 12 ? 'ArrowLeft' : 'ArrowRight', bubbles:true }));
        if (previous && warmup-- <= 0) samples.push(time - previous);
        previous = time;
        if (samples.length === 180) resolve(); else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    samples.sort((a,b) => a-b);
    return { kind, p50: samples[Math.floor(samples.length*.5)], p95: samples[Math.floor(samples.length*.95)], frames:samples.length };
  },
  dispose() { running=false; viewer.dispose(); scene.dispose(); terminal.dispose(); client.dispose(); },
} });
