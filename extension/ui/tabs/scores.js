// Scores (#scores) - placeholder registered by the shell. The full screen (my scores per provider, score history
// with the follow-back track, check any account, target score coverage, provider setup) replaces this module.

import { h, section, emptyState } from "../components.js";

export default {
  id: "scores",
  title: "Scores",
  hint: "Your scores on Sorsa, TwitterScore, Ethos and Moni, and the follow-backs that move them.",
  async render(root) {
    root.appendChild(section({ wide: true, title: "Scores" },
      emptyState("Coming soon", "Your scores per provider, their history and provider setup will appear here.",
        h("p", { class: "small muted" }, "Until then, the Sorsa setup is in Settings > Advanced."))));
  },
};
