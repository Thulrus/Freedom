# Testing on a real phone

M3 is accepted only after real-device checks: at least one mid-range Android phone and one iPhone. The automated tests use an emulated phone with software rendering. They prove that the logic works, not that performance or touch feel is right.

## Get it on the phone

The app needs **HTTPS** for offline mode and low-latency touch events. Use GitHub Pages:

Open **https://thulrus.github.io/Freedom/**. Every push to the default branch redeploys it through the "Deploy to GitHub Pages" workflow.

Quick LAN test without HTTPS: run `npm run dev -- --host` and open the printed network URL. Everything works except offline mode, and `pointerrawupdate` is off, so latency reads slightly higher.

## Checklist

On each phone, turn on the debug overlay: ⚙ → Graphics → "Show debug overlay".

| # | Check | Pass when |
|---|---|---|
| 1 | Install | Android: "Install app" or "Add to Home screen". iPhone: Safari → Share → Add to Home Screen. It opens full-screen in landscape. |
| 2 | Offline | Turn on airplane mode and open the app from the home screen. It loads and flies. |
| 3 | Gestures | Two-thumb flying for 2 minutes causes no scroll, zoom, text selection, magnifier, pull-to-refresh or back-swipe. |
| 4 | Multi-touch | Holding both sticks and moving them independently works. A third finger on the screen doesn't disturb either stick. |
| 5 | Interruptions | A notification, the control-center pull-down or an app switch while flying: the throttle holds or the quad disarms. No stuck stick. |
| 6 | Rotation / notch | Rotating to portrait shows the prompt. In landscape, sticks and buttons stay clear of the notch and home bar. |
| 7 | Frame rate | Debug overlay `fps` holds the display rate (60/90/120) after 10 minutes. Note the `scale` and `quality` it settles at. |
| 8 | Thermal | Fly 10 minutes with Battery saver off, then on. Note whether fps drops and how warm the phone gets. |
| 9 | Latency | Note `input→sim` avg and p95 while moving a stick (see below). |

## Reading the latency numbers

`input→sim` is the time from the browser timestamping a touch to the physics consuming it. Getting the frame onto the screen adds roughly one more display frame (16.7 ms at 60 Hz) plus display latency.

For a true end-to-end number, film the screen and your thumb with a phone's slow-motion camera (240 fps). Then count frames from the moment the thumb starts moving to the moment the horizon starts moving. Fly in Acro with high rates so that small stick moves are visible.

Please report: phone model, OS and browser version, display Hz, the `input→sim` avg/p95, and the slow-motion result if you did it.
