# Whiteboard Teacher

Whiteboard Teacher is a web app. You ask a question. An AI teacher gives you a lesson on a whiteboard.

The teacher speaks the lesson. The teacher draws diagrams and animations at the same time.
You can stop the lesson and ask a question. At the end, the teacher gives you a short quiz.

## Requirements

- Node.js 20 or later.
- The `claude` command-line tool (Claude Code). Sign in to it before you start the app.
- An ElevenLabs API key (optional). Without a key, the app uses the voice of your browser.

## Install and start

1. Clone this repository.
2. Copy `.env.example` to `.env`.
3. Put your ElevenLabs key in `.env`.
4. Run `npm start`.
5. Open http://localhost:4747 in your browser.
6. Make the admin account. Use a password of 6 characters or more.
7. Go to **Admin** and add the learners.

The app has no dependencies. You do not need `npm install`.

## Use

1. Select your profile.
2. Type or speak a question.
3. Select the length of the lesson.
4. Select **Teach me**.

| Key   | Action                                 |
|-------|----------------------------------------|
| Space | Stop or continue the lesson.           |
| ← →   | Go to the previous or next step.       |
| A     | Hold to speak a question. Tap to type. |
| C     | Show or hide captions.                 |
| 1–4   | Answer a quiz question.                |

## Admin

The admin can:

- Add learners and set a PIN for each learner.
- Set the age band of each learner.
- Change the content rules for all learners and for each age band.
- See the lessons, questions, quiz scores and feedback of each learner.
- Read and change the learning profile of each learner.

The app checks each topic and each question against the content rules. It does this before it writes a lesson.

## Data

The app keeps all data on your computer:

- `data/` contains the accounts, the content rules and the learning profiles.
- `lessons/` contains the lessons and their audio.

Git does not track these folders.

## More information

- `docs/SCRIPT_API.md` gives the format of a lesson script.
- `PLAN.md` gives the status and the next tasks.
