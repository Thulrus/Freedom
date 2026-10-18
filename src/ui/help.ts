import { h } from './dom';

/** Controls reference + an honest note on input devices. */
export function helpPanel(onClose: () => void): HTMLElement {
  const row = (k: string, v: string) => h('tr', null, h('td', { class: 'kbd' }, k), h('td', null, v));
  return h(
    'div',
    { class: 'modal', onclick: (e: Event) => e.target === e.currentTarget && onClose() },
    h(
      'div',
      { class: 'modal-box' },
      h('h2', null, 'Freedom FPV · controls'),
      h(
        'p',
        { class: 'note' },
        'For real practice, use a radio transmitter in USB joystick mode (EdgeTX/OpenTX/ELRS) or a gamepad. Keyboard flight is only for testing; it cannot reproduce analog sticks. Default mode is Acro (rate mode), like a real freestyle quad.',
      ),
      h(
        'table',
        { class: 'keys' },
        row('Space', 'Arm / disarm (throttle must be low)'),
        row('W / S', 'Throttle up / down (stays where you leave it)'),
        row('A / D', 'Yaw left / right'),
        row('Arrows', 'Pitch and roll'),
        row('1 / 2 / 3', 'Acro / Angle / Horizon'),
        row('C', 'Camera: FPV → chase → line of sight'),
        row('R', 'Reset to the launch pad'),
        row('T', 'Tuning panel (rates, PIDs, physics, camera, JSON)'),
        row('G', 'Debug overlay'),
        row('O', 'Toggle OSD'),
        row('Gamepad', 'Start: arm · Y: mode · Back: reset · LB: camera. Radios: run "Set up controller" in the tuning panel.'),
      ),
      h('button', { class: 'btn primary', onclick: onClose }, 'Fly'),
    ),
  );
}
