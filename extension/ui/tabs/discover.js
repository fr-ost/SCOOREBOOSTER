// Discover (#discover) - placeholder registered by the shell. The full screen (smart followers first, followers /
// following / common follows / people search, big accounts swept, candidates table) replaces this module.

import { h, section, emptyState } from "../components.js";

export default {
  id: "discover",
  title: "Discover",
  hint: "Find new accounts to target: smart followers of big accounts, followers, common follows or people search.",
  async render(root) {
    root.appendChild(section({ wide: true, title: "Discover" },
      emptyState("Coming soon", "Smart-follower lookups and the candidates table will move here.",
        h("p", { class: "small muted" }, h("a", { href: "#targets" }, "Discovery and candidates are still on Targets"), " for now."))));
  },
};
