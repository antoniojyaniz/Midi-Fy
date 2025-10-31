# MIDI-FY

Midi-Fy is a lightweight prompt based MIDI file generator. Simply describe the kind of midi clip you would like and let Midi-Fy take care of the rest. You can visualize the notes on a piano roll, tweak your inputs, and instantly build new ideas.

## Demo 

## How It’s Made

The frontend is a single static page. It collects a few parameters with simple form controls, builds a clear prompt string, and sends it to the backend with fetch. The backend is a small Express server that accepts a POST /compose. It forwards the prompt to Claude, asks for strict JSON that describes a single MIDI clip, and then validates the output. Notes are clamped so nothing spills past the requested bar length. Keys and modes are parsed into pitch classes, and out-of-scale notes are either snapped into the scale or rejected based on env flags. The server returns clean JSON to the browser. 

On the client side, a tiny MIDI writer assembles a valid SMF by hand. It sorts note-on and note-off events, writes a simple time signature meta event, and returns a Blob for download. The canvas piano roll is just a few drawing calls: background gradient, grid lines per beat and bar, then rectangles for notes sized by duration and positioned by pitch.

## Lessons Learned 

This project taught me a ton about combining AI with creative coding. I learned how to design reliable JSON contracts between models and front-end systems, how to enforce music theory rules programmatically, and how to make something visually pleasing without any frameworks.

