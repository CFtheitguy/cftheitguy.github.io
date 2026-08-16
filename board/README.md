# Linear Board — a whiteboard two people can share

**<https://board.linearit.co>** (also served from `https://www.linearit.co/board/`)

A web page with a blank board on it. You send someone the link, and whatever
you draw or type, they see appear on their screen as you do it. No signup, no
app. You can save it as a picture, and the board wipes itself a day later.

## What a person actually does

1. Opens the page. The board is blank.
2. The address bar now reads something like `board.linearit.co/#quiet-blue-otter`
   — a room name generated automatically.
3. They copy that link (the room name in the corner *is* the copy button) and
   text it to the other person.
4. The other person opens the link. They are now in the same room.
5. Either one draws. The other sees the strokes appear **as they are being
   drawn**, not after.
6. Either one can pick a colour, pick a line thickness, place text, undo their
   own last action, or clear the whole board.
7. Either one can press **Save** and get a PNG of the board on their device.
8. Closing the tab and reopening the same link brings the board back with
   everything still on it — until 24 hours of inactivity, after which the board
   is gone permanently.

## What this deliberately does not do

This list matters as much as the feature list. Every one of these is a
reasonable request and every one of them is out of scope for version 1.

- No shapes (rectangles, circles, arrows)
- No image upload or background image
- No accounts, no login, no user names
- No private or password-protected rooms
- No permanent boards, no board history
- No mobile app — it is a web page
- No cursor showing where the other person is pointing
- No chat

## The files

| | |
| --- | --- |
| `index.html` | the page, its styling, and the toolbar |
| `app.js` | the drawing engine, the text tool, the export, the connection |
| `assets/` | brand logo, icon and background pattern |

Plain JavaScript. No framework, no build step, nothing to install — the two
files are served exactly as they sit here.

The backend is a Cloudflare Worker plus one Durable Object per room, in
[`../board-worker/`](../board-worker/README.md). That is where the protocol and
the 24-hour rule are documented.

## Notes on how it works

**The board is a square.** It is fitted into whatever space the window has
rather than stretched to fill it. Fitting is what keeps a circle round on both
a phone and a 27-inch monitor, and it means both people are always looking at
the whole board instead of one of them seeing a cropped piece. Square, rather
than landscape, because a landscape board leaves a phone held upright showing a
thin strip.

**Points go up while the pen is still moving.** Roughly every 50ms. If you wait
for the pen to lift, the other person sees nothing for two seconds and then a
whole line appears at once, and it feels broken.

**Text is placed, not edited.** Tap with the text tool and a real HTML input
appears on top of the canvas; what you type is painted onto the board only when
you finish. Nothing is sent until then — the other person sees the finished
text arrive in one piece rather than a stream of keystrokes. Once placed, text
is a finished item like a stroke: it can be undone or cleared, not edited. Two
people can never be inside the same piece of text at once, which keeps an
entire category of hard problem out of version 1.

**Undo takes back your own last item**, not the room's last item. If you draw,
then I draw, then you press undo, taking yours back is far less surprising than
reaching across and deleting mine. Some people will occasionally expect the
other behaviour.

**Export is done entirely in the browser** — the server is not involved. The
board is redrawn to an off-screen canvas at about three times the display size
so the file is not a blurry phone screenshot, on a white background because a
canvas with nothing on it exports transparent and transparent PNGs show up
black in a lot of viewers. The file is named for the room and the date, e.g.
`quiet-blue-otter-2026-08-16.png`. Text is painted in a plain system font
stack, never a web font, so the export can't fall back to something else.

**Reconnecting is routine, not exceptional.** Phones close WebSockets every
time the screen locks. The page notices, backs off, reopens, and reloads the
board. The room's list is treated as the truth and replaces what the page was
holding, which is what stops a reconnected phone drawing everything twice — and
also picks up an undo or a clear that happened while it was away. Anything you
drew while the socket was down was never seen by the room, so it is kept and
sent up again.

**Palm rejection** is partial, and honestly so. Pointer events report whether
input came from a pen or from a finger, so once a stylus has been used on a
device, plain touch stops drawing. On a finger-only tablet there is no clean
way to tell a palm from a fingertip.

## Keyboard

| | |
| --- | --- |
| `P` / `T` | pen / text tool |
| `Ctrl`/`Cmd` + `Z` | undo your last item |
| `Ctrl`/`Cmd` + `S` | save a PNG |
| `Enter` or `Esc` | finish the text you are typing |
