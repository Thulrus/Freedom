/** Dialogs for game modes: the activity menu, pre-run instructions, and results. */
import type { ActivityDef, RunResult } from '../game/types';
import { backdropClose, h } from './dom';

export interface BestScore {
  score: number;
  text: string;
}

const modal = (onBackdrop: () => void, ...children: (HTMLElement | null)[]) =>
  h('div', backdropClose(onBackdrop), h('div', { class: 'modal-box' }, ...children));

export const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

export interface MenuActions {
  free(): void;
  pick(def: ActivityDef): void;
  replay(): void;
  close(): void;
}

export function modesPanel(defs: ActivityDef[], current: string | null, worldName: string, best: (def: ActivityDef) => BestScore | null, canReplay: string, a: MenuActions): HTMLElement {
  const card = (title: string, blurb: string, extra: string, on: boolean, onPick: () => void) =>
    h('button', { class: `mode-card${on ? ' on' : ''}`, type: 'button', onclick: onPick }, h('strong', null, title), h('span', null, blurb), extra ? h('em', null, extra) : null);
  return modal(
    a.close,
    h('h2', null, 'Fly'),
    h('p', { class: 'tune-dim' }, `World: ${worldName} · change it in ⚙ → World. Bests are kept per world and seed.`),
    h(
      'div',
      { class: 'mode-grid' },
      card('Free flight', 'No rules. Just fly.', '', current === null, a.free),
      defs.map((d) => {
        const b = best(d);
        return card(d.name, d.blurb, b ? `Best: ${b.text}` : '', current === d.id, () => a.pick(d));
      }),
    ),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn', onclick: a.replay, disabled: !!canReplay, title: canReplay }, '▶ Replay last flight (P)'),
      h('button', { class: 'btn', onclick: a.close }, 'Close'),
    ),
    canReplay ? h('div', { class: 'tune-dim' }, canReplay) : null,
  );
}

export function instructionsPanel(def: ActivityDef, best: BestScore | null, onGo: () => void): HTMLElement {
  return modal(
    onGo,
    h('h2', null, def.name),
    h('p', null, def.instructions),
    best ? h('p', { class: 'tune-dim' }, `Your best here: ${best.text}`) : null,
    h('p', { class: 'tune-dim' }, 'R restarts the attempt. M opens this menu.'),
    h('button', { class: 'btn primary big', onclick: onGo }, 'Go'),
  );
}

export interface ResultActions {
  retry(): void;
  replay(): void;
  telemetry(): void;
  free(): void;
}

export function resultsPanel(def: ActivityDef, r: RunResult, best: BestScore | null, isBest: boolean, a: ResultActions): HTMLElement {
  return modal(
    a.retry,
    h('h2', null, `${def.name}: ${r.success ? 'done!' : 'failed'}`),
    r.success
      ? h(
          'div',
          { class: 'result-head' },
          h('div', { class: 'result-score' }, r.scoreText),
          h('div', { class: 'result-stars' }, starText(r.stars)),
          isBest ? h('div', { class: 'result-pb' }, 'New personal best!') : best ? h('div', { class: 'tune-dim' }, `Best: ${best.text}`) : null,
        )
      : null,
    h('ul', { class: 'result-lines' }, r.lines.map((l) => h('li', null, l))),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn primary', onclick: a.retry }, 'Retry (R)'),
      h('button', { class: 'btn', onclick: a.replay }, '▶ Replay'),
      h('button', { class: 'btn', onclick: a.telemetry }, 'Telemetry'),
      h('button', { class: 'btn', onclick: a.free }, 'Free flight'),
    ),
  );
}
