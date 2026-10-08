// Starting schemas per mode (live, video, batch, ask). These are demonstrations of the request shape,
// not tuned prompts: the model answers whatever questions it is given, and nothing here has been
// measured for accuracy (see README, "What is not measured").
//
// Editor shape: questions are an ordered list; `options` (choice) are {id, description|null},
// `levels` (score) are ordered labels, noul takes optional true/false descriptions.

export const PRESETS = {
  live: [
    {
      name: "Presence, mood and gestures",
      state: "A live webcam frame from a laptop.",
      questions: [
        { id: "person_present", type: "noul", instructions: "Is at least one person visible?" },
        {
          id: "people",
          type: "choice",
          instructions: "How many people are visible?",
          options: [
            { id: "none", description: null },
            { id: "one", description: null },
            { id: "two", description: null },
            { id: "three_or_more", description: null },
          ],
        },
        { id: "looking_at_camera", type: "noul", instructions: "Is the nearest person looking at the camera?" },
        {
          id: "mood",
          type: "choice",
          instructions: "Apparent mood of the nearest person",
          options: [
            { id: "happy", description: null },
            { id: "neutral", description: null },
            { id: "tired", description: null },
            { id: "surprised", description: null },
            { id: "angry", description: null },
          ],
        },
        { id: "lighting", type: "score", instructions: "How well lit is the scene?", levels: ["dark", "dim", "good", "bright"] },
        {
          id: "fingers",
          type: "choice",
          instructions: "Which number is shown with fingers?",
          options: [
            { id: "1", description: null },
            { id: "2", description: null },
            { id: "3", description: null },
            { id: "4", description: null },
            { id: "5", description: null },
            { id: "none", description: null },
          ],
        },
        {
          id: "gesture",
          type: "choice",
          instructions: "Which gesture?",
          options: [
            { id: "thumbs_up", description: null },
            { id: "peace", description: null },
            { id: "none", description: null },
          ],
        },
      ],
    },
    {
      name: "Corpus v001 (parity request)",
      state: "A live webcam frame from a laptop.",
      questions: [
        { id: "wearing_glasses", type: "noul", instructions: "Wearing glasses?" },
        {
          id: "mood",
          type: "choice",
          instructions: "",
          options: [
            { id: "happy", description: null },
            { id: "neutral", description: null },
            { id: "tired", description: null },
          ],
        },
        { id: "energy", type: "score", instructions: "", levels: ["low", "medium", "high"] },
      ],
    },
    {
      name: "Desk and hands",
      state: "A webcam frame of a person at a desk.",
      questions: [
        {
          id: "holding",
          type: "choice",
          instructions: "What is the person holding?",
          options: [
            { id: "nothing", description: null },
            { id: "phone", description: null },
            { id: "cup", description: null },
            { id: "paper", description: null },
            { id: "other", description: null },
          ],
        },
        { id: "hands_visible", type: "noul", instructions: "Are the person's hands visible?" },
        { id: "clutter", type: "score", instructions: "How cluttered is the desk?", levels: ["clear", "some", "cluttered"] },
      ],
    },
  ],

  batch: [
    {
      name: "Recon screenshot triage",
      state: {
        task: "Classify a screenshot of a web page captured during an authorized external assessment.",
        note: "Judge only what is visible in the screenshot.",
      },
      questions: [
        {
          id: "page_type",
          type: "choice",
          instructions: "What kind of page is this?",
          options: [
            { id: "login", description: "A sign-in form asking for credentials" },
            { id: "admin_panel", description: "An administrative or management interface" },
            { id: "default_install", description: "A default or placeholder page of a web server or framework" },
            { id: "error", description: "An HTTP error, stack trace or exception page" },
            { id: "parked", description: "A parked or for-sale domain page" },
            { id: "api_docs", description: "API documentation or an API response" },
            { id: "marketing", description: "A public marketing or content site" },
            { id: "other", description: null },
          ],
        },
        { id: "credential_form", type: "noul", instructions: "Does the page contain a password field or sign-in form?" },
        { id: "looks_internal", type: "noul", instructions: "Does the page look like an internal or non-public application?" },
        { id: "leaks_details", type: "noul", instructions: "Does the page expose version numbers, paths, stack traces or configuration?" },
        { id: "interest", type: "score", instructions: "How interesting is this page for a security tester?", levels: ["ignore", "low", "medium", "high"] },
      ],
    },
    {
      name: "Phishing page screening",
      state: { task: "Screen a screenshot of a web page for phishing indicators." },
      questions: [
        {
          id: "brand",
          type: "choice",
          instructions: "Which brand, if any, does the page imitate?",
          options: [
            { id: "none", description: null },
            { id: "microsoft", description: null },
            { id: "google", description: null },
            { id: "apple", description: null },
            { id: "bank_or_payment", description: "A bank, card issuer or payment provider" },
            { id: "shipping", description: "A courier or postal service" },
            { id: "other", description: null },
          ],
        },
        { id: "password_field", type: "noul", instructions: "Is there a password or one-time-code field?" },
        { id: "urgency", type: "noul", instructions: "Does the page use urgency or threats (account locked, act now, verify immediately)?" },
        { id: "suspicious", type: "score", instructions: "How likely is this a phishing page?", levels: ["unlikely", "possible", "likely", "almost_certain"] },
      ],
    },
    {
      name: "Photo library sort",
      state: "A photo from a personal library.",
      questions: [
        {
          id: "subject",
          type: "choice",
          instructions: "Main subject",
          options: [
            { id: "people", description: null },
            { id: "pet", description: null },
            { id: "landscape", description: null },
            { id: "food", description: null },
            { id: "document", description: null },
            { id: "screenshot", description: null },
            { id: "other", description: null },
          ],
        },
        { id: "blurry", type: "noul", instructions: "Is the photo blurry or badly exposed?" },
        { id: "keep", type: "score", instructions: "Worth keeping?", levels: ["delete", "maybe", "keep", "favorite"] },
      ],
    },
  ],

  ask: [
    {
      name: "Document check",
      state: { task: "Review the attached document image." },
      questions: [
        {
          id: "doc_type",
          type: "choice",
          instructions: "What is this?",
          options: [
            { id: "receipt", description: null },
            { id: "invoice", description: null },
            { id: "form", description: null },
            { id: "letter", description: null },
            { id: "photo", description: null },
            { id: "screenshot", description: null },
            { id: "other", description: null },
          ],
        },
        { id: "legible", type: "noul", instructions: "Is the text legible?" },
        { id: "has_total", type: "noul", instructions: "Is a total amount visible?" },
        { id: "quality", type: "score", instructions: "Capture quality", levels: ["unusable", "poor", "fine", "good"] },
      ],
    },
    {
      name: "Scene questions",
      state: "A photo.",
      questions: [
        { id: "outdoors", type: "noul", instructions: "Was this taken outdoors?" },
        {
          id: "time_of_day",
          type: "choice",
          instructions: "Time of day",
          options: [
            { id: "day", description: null },
            { id: "dusk_or_dawn", description: null },
            { id: "night", description: null },
            { id: "indoors_unknown", description: null },
          ],
        },
        { id: "people_count", type: "score", instructions: "How many people?", levels: ["0", "1", "2", "3", "4_or_more"] },
      ],
    },
    {
      name: "Accessibility alt text",
      state: "An image from a web page; decide how to describe it.",
      questions: [
        { id: "decorative", type: "noul", instructions: "Is the image purely decorative?" },
        { id: "contains_text", type: "noul", instructions: "Does the image contain text that should be transcribed?" },
        {
          id: "kind",
          type: "choice",
          instructions: "Image kind",
          options: [
            { id: "photo", description: null },
            { id: "diagram", description: null },
            { id: "chart", description: null },
            { id: "icon_or_logo", description: null },
            { id: "screenshot", description: null },
          ],
        },
      ],
    },
  ],

  video: [
    {
      name: "Motion and change",
      state: "A short clip from a video.",
      questions: [
        {
          id: "motion",
          type: "choice",
          instructions: "Which way does the main subject move during the clip?",
          options: [
            { id: "left", description: null },
            { id: "right", description: null },
            { id: "toward_camera", description: null },
            { id: "away_from_camera", description: null },
            { id: "not_moving", description: null },
            // A window can hold both directions (a subject turning around); without this option
            // the question has no right answer for it.
            { id: "back_and_forth", description: null },
          ],
        },
        { id: "camera_moves", type: "noul", instructions: "Does the camera itself move (pan, tilt or shake) during the clip?" },
        { id: "cut", type: "noul", instructions: "Does the clip cut to a different shot?" },
        { id: "activity", type: "score", instructions: "How much is happening in the clip?", levels: ["still", "calm", "busy", "hectic"] },
      ],
    },
    {
      name: "Doorway camera",
      state: "Footage from a fixed camera watching a doorway.",
      questions: [
        { id: "person_enters", type: "noul", instructions: "Does a person come in through the doorway during the clip?" },
        { id: "person_leaves", type: "noul", instructions: "Does a person go out through the doorway during the clip?" },
        {
          id: "people",
          type: "choice",
          instructions: "How many people are visible?",
          options: [
            { id: "none", description: null },
            { id: "one", description: null },
            { id: "two_or_more", description: null },
          ],
        },
        {
          id: "door",
          type: "choice",
          instructions: "What does the door do during the clip?",
          options: [
            { id: "stays_closed", description: null },
            { id: "opens", description: null },
            { id: "closes", description: null },
            { id: "stays_open", description: null },
          ],
        },
      ],
    },
    {
      name: "Screen recording",
      state: "A screen recording of someone using a computer.",
      questions: [
        {
          id: "doing",
          type: "choice",
          instructions: "What is the user doing?",
          options: [
            { id: "typing", description: null },
            { id: "scrolling", description: null },
            { id: "reading", description: null },
            { id: "watching_video", description: null },
            { id: "idle", description: null },
          ],
        },
        { id: "error_shown", type: "noul", instructions: "Does an error message or dialog appear?" },
        { id: "switches_app", type: "noul", instructions: "Does the user switch to a different application or window?" },
      ],
    },
  ],
};
