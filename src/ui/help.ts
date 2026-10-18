import { h } from './dom';

/** Controls reference + an honest note on input devices. */
export function helpPanel(touch: boolean, onClose: () => void): HTMLElement {
  const row = (k: string, v: string) => h('tr', null, h('td', { class: 'kbd' }, k), h('td', null, v));
  return h(
    'div',
    { class: 'modal', onclick: (e: Event) => e.target === e.currentTarget && onClose() },
    h(
      'div',
      { class: 'modal-box' },
      h('h2', null, 'Freedom FPV · controls'),
      touch
        ? null
        : h(
        'p',
        { class: 'note' },
        'For real practice, use a radio transmitter in USB joystick mode (EdgeTX/OpenTX/ELRS) or a gamepad. Keyboard flight is only for testing; it cannot reproduce analog sticks. Default mode is Acro (rate mode), like a real freestyle quad.',
      ),
      touch
        ? h(
            'div',
            null,
            h('p', { class: 'note warn' }, 'Touch sticks are a compromise: there are no springs or physical stops, so they cannot build the same muscle memory as real gimbals. They are fine for learning lines and orientation. For skills that transfer to a real quad, plug in a radio (USB-C/OTG) or a gamepad.'),
            h(
              'table',
              { class: 'keys' },
              row('Left thumb', 'Throttle (stays where you leave it) and yaw. Mode 2; other modes are in ⚙ → Touch.'),
              row('Right thumb', 'Pitch and roll (spring back to center).'),
              row('ARM', 'Arm / disarm. Throttle must be all the way down.'),
              row('ACRO', 'Cycle Acro / Angle / Horizon. Beginners: try Angle first.'),
              row('CAM', 'FPV → chase → line of sight'),
              row('⚙', 'Tuning: rates, touch layout, stick size, expo, graphics'),
              row('⛶', 'Fullscreen'),
            ),
            h('p', { class: 'tune-dim' }, 'Your thumb can land anywhere on its half of the screen; the stick never jumps. On iPhone, use Share → Add to Home Screen for a true full-screen app.'),
          )
        : null,
      h(
        'table',
        { class: touch ? 'keys hidden-touch' : 'keys' },
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
      h('button', { class: 'btn primary big', onclick: onClose }, 'Fly'),
    ),
  );
}
