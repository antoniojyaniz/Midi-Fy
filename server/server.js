require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

//Scale helpers
const PITCH_CLASS = { C:0,'C#':1,Db:1, D:2,'D#':3,Eb:3, E:4, F:5,'F#':6,Gb:6, G:7,'G#':8,Ab:8, A:9,'A#':10,Bb:10, B:11 };
const MODES = {
  major:      [0,2,4,5,7,9,11],
  minor:      [0,2,3,5,7,8,10],      
  dorian:     [0,2,3,5,7,9,10],
  mixolydian: [0,2,4,5,7,9,10]
};
const STRICT_SCALE = String(process.env.STRICT_SCALE || '').toLowerCase() === 'true';
const SNAP_TO_SCALE = String(process.env.SNAP_TO_SCALE || 'true').toLowerCase() === 'true'; // default ON

const pc = (n) => ((n % 12) + 12) % 12;
function buildScale(key, mode) {
  const root = PITCH_CLASS[key];
  const degrees = MODES[(mode || '').toLowerCase()] || MODES.major;
  if (root == null) return null;
  const set = new Set(degrees.map(d => (root + d) % 12));
  return { root, degrees, set };
}
function inScale(p, scaleSet) {
  if (!scaleSet) return true;
  return scaleSet.set.has(pc(p));
}
function nearestInScale(p, scaleSet) {
  if (!scaleSet) return p;
  if (inScale(p, scaleSet)) return p;
  for (let d = 1; d <= 6; d++) {
    const down = pc(p - d); if (scaleSet.set.has(down)) return p - d;
    const up   = pc(p + d); if (scaleSet.set.has(up))   return p + d;
  }
  return p;
}

//prompt
const SYSTEM_PROMPT = `
You are a music assistant that outputs STRICT JSON for a single-track MIDI clip.

HARD RULES (must follow exactly):
- Output ONLY JSON (no prose, no code fences).
- Required keys: time_signature ("4/4" or "3/4"), length_bars (1–64), clip_type ("chords"|"bass"|"lead"),
  key (letter like A/Bb/F#), mode ("major"|"minor"|"dorian"|"mixolydian"),
  instrument {name, program}, notes[] with:
  tb (start in beats, >=0), db (duration in beats, >0), p (0–127), v (0–1).
- BAR LENGTH: beats_per_bar = 4 for 4/4, 3 for 3/4. total_beats = length_bars * beats_per_bar.
  Every note must satisfy: 0 <= tb and (tb + db) <= total_beats. No spill beyond total_beats.
- QUANTIZATION: Use a 1/16-beat grid or coarser.
- SCALE CONFORMITY: All pitches must be diatonic to (key, mode).
  • major: 0,2,4,5,7,9,11
  • minor (natural): 0,2,3,5,7,8,10
  • dorian: 0,2,3,5,7,9,10
  • mixolydian: 0,2,4,5,7,9,10
  Avoid out-of-scale accidentals.
- CHORDS: When clip_type="chords", use triads or 4-note voicings (>= 3 simultaneous notes on each chord onset). No single-note chords.
- BASS/LEAD: Monophonic (no overlapping notes).
- Omit tempo/BPM entirely.

If constraints conflict, prefer BAR LENGTH and SCALE CONFORMITY.
`;

//extract and repair JSON 
function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty response');
  // strip code fences
  text = text.replace(/```(?:json)?/gi, '').trim();

  // quick parse
  try { return JSON.parse(text); } catch (_) {}

  // slice between first { and last }
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const slice = text.slice(first, last + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }

  // balance braces scan
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const seg = text.slice(start, i + 1);
        try { return JSON.parse(seg); } catch (_) {}
      }
    }
  }
  throw new Error('No valid JSON found');
}

//Route
app.post('/compose', async (req, res) => {
  try {
    const { clipType, bars, key, mode, feel, text } = req.body || {};
    const barsNum = Number(bars) || 8;

    // Build user prompt
    const parts = [
      `Make a ${clipType || 'chords'} clip.`,
      `Length: ${barsNum} bars.`,
      `Time signature: 4/4.`,
      key && mode ? `Key/scale: ${key} ${mode}.` : `Key/scale: auto.`,
      feel ? `Feel: ${feel}.` : ``,
      text ? `Details: ${text}` : ``,
    ].filter(Boolean);

    // Per-type nudges
    if (clipType === 'chords') {
      parts.push('Voicing: triads or 4-note voicings; at least 3 notes per chord onset; avoid single-note chords.');
      parts.push('Prefer chord tones and in-scale extensions (6, 7, 9, 11).');
    }
    if (clipType === 'bass') {
      parts.push('Monophonic bassline: one note at a time; no overlapping notes.');
      parts.push('Use in-scale chord tones and scalar passing tones; avoid non-diatonic accidentals.');
    }
    if (clipType === 'lead') {
      parts.push('Monophonic melody; mostly stepwise with occasional leaps; all notes in-scale.');
    }

    //hard rules
    parts.push(
`Requirements:
- Fit exactly within ${barsNum} bars (no notes beyond bar ${barsNum}).
- All notes must be diatonic to ${key || 'the chosen'} ${mode || 'scale'}.
Return STRICT JSON per schema.`
    );

    //Model call
    const MODEL_DEFAULT = 'claude-opus-4-1-20250805'; // your requested default; override via .env if needed
    const MODEL = process.env.ANTHROPIC_MODEL || MODEL_DEFAULT;

    const msg = await anthropic.messages.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: parts.join('\n') }]
    });

    //JSON extraction
    const raw = (msg.content || []).map(c => (c.type === 'text' ? c.text : '')).join('');

    let data;
    try {
      data = extractJson(raw);
    } catch (e) {
      try {
        const repair = await anthropic.messages.create({
          model: MODEL,
          temperature: 0,
          max_tokens: 1200,
          system: 'You fix malformed JSON into valid JSON that matches the schema. Output only JSON.',
          messages: [{ role: 'user', content: `Fix this into valid JSON per schema (do not invent fields):\n${raw}` }]
        });
        const fixed = (repair.content || []).map(c => (c.type === 'text' ? c.text : '')).join('');
        data = extractJson(fixed);
      } catch (e2) {
        return res.status(400).send(`AI_JSON_ERROR: ${String(e2)}`);
      }
    }

    if (!data || !Array.isArray(data.notes) || !data.time_signature || data.length_bars == null) {
      return res.status(400).send('SCHEMA_MISSING_FIELDS: notes/time_signature/length_bars');
    }

    //Normalize & clamp by bar length
    const beatsPerBar = (data.time_signature && data.time_signature.startsWith('3/')) ? 3 : 4;
    const totalBeats = (Number(data.length_bars) || barsNum) * beatsPerBar;

    data.clip_type = clipType || data.clip_type || 'chords';
    data.length_bars = Number(data.length_bars) || barsNum;
    data.time_signature = data.time_signature || '4/4';
    if (key && !data.key)  data.key  = key;
    if (mode && !data.mode) data.mode = mode;

    data.notes = (Array.isArray(data.notes) ? data.notes : []).filter(n =>
      Number.isFinite(n.tb) && n.tb >= 0 &&
      Number.isFinite(n.db) && n.db > 0 &&
      Number.isFinite(n.p)  && n.p >= 0 && n.p <= 127 &&
      (n.tb + n.db) <= totalBeats
    );

    //Scale enforcement
    const scaleSet = (data.key && data.mode) ? buildScale(data.key, data.mode) : null;
    let snappedCount = 0;

    if (SNAP_TO_SCALE && scaleSet) {
      data.notes = data.notes.map(n => {
        if (inScale(n.p, scaleSet)) return n;
        const p2 = nearestInScale(n.p, scaleSet);
        if (p2 !== n.p) snappedCount++;
        return { ...n, p: p2 };
      });
    } else if (STRICT_SCALE && scaleSet) {
      const bad = data.notes.filter(n => !inScale(n.p, scaleSet));
      if (bad.length) {
        return res.status(400).send(`OUT_OF_SCALE: ${bad.length} non-diatonic notes for ${data.key} ${data.mode}`);
      }
    }

    if (snappedCount > 0) {
      data._snapped_info = { snapped_count: snappedCount, mode: 'snap_to_scale' };
    }

    return res.json(data);

  } catch (err) {
    try {
      if (err && (err.status || err.response || err.error)) {
        const status = err.status || err.response?.status || 400;
        const detail = err.message
          || (typeof err.error === 'object' ? JSON.stringify(err.error) : String(err.error))
          || String(err);
        return res.status(status).send(detail);
      }
    } catch (_) { /* ignore */ }
    return res.status(400).send(String(err));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
