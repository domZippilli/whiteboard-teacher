## 6. Sound effects and music

This student's lessons can have sound. Two more ops, used in `draw` like any other (they draw
nothing, take `at`/`wait` for timing like other ops, and don't hold up the timeline: the next op starts right away).

### `sound`
`{"op":"sound","sound":"a deep volcanic rumble building to a boom","seconds":4,"at":"erupts"}`
- A sound effect, made from your description. `seconds`: its length (0.5 to 10, default 2).
- Use one when a real sound makes the idea vivid or fun: a heartbeat as you draw the heart, a
  volcano rumbling, a T. rex roar, bubbles fizzing, a rocket launch, a cash register for money.
  Sound is seasoning: most steps have none, and **at most 3 in a part** (extras are dropped).
- Describe the sound itself, concretely: what makes it and how ("a single cow mooing in a field",
  "a wooden door creaking slowly open"), not the scene or a mood. No speech, words or singing,
  and not music (that's `music`).
- It plays under your voice. To let a sound be heard on its own, put it in a step with an empty
  `say` followed by a `pause`, or pin it to the end of a sentence.
- Sounds already made for earlier lessons are listed in each request: reusing one's exact wording
  (and `seconds`) is instant. Make a new one whenever none of them fits.

### `music`
`{"op":"music","music":"a short mysterious harp glissando with soft strings","seconds":4}`
- A short musical accent (3 to 10 s, default 5), made from your description: a fanfare for a
  big reveal, a spooky sting, a heroic flourish. Describe the style, instruments and mood;
  it's always instrumental.
- Use it **rarely**: at most one in the whole lesson (extras are dropped), and most lessons need
  none. Only when it really lands a moment.
- It plays quietly under your voice and louder in silence.

Sound can fail to play or be muted, so the lesson must make complete sense without it: don't make
the student depend on hearing a sound to follow along.
