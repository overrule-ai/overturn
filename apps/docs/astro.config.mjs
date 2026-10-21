import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://docs.overturn.run",
  integrations: [
    starlight({
      title: "Overturn",
      description: "Every human correction of an AI agent becomes a replayable regression test.",
      logo: { src: "./public/logo-dark.svg", replacesTitle: true },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/overrule-ai/overturn" }],
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Quickstart", link: "/quickstart/" },
        { label: "Hosted app", link: "/hosted/" },
        { label: "SDK & CLI", link: "/sdk/" },
        { label: "Corrections from your UI", link: "/correct-button/" },
        { label: "Replay: what it proves", link: "/replay/" },
        { label: "Self-hosting", link: "/self-hosting/" },
        { label: "Fingerprint contract", link: "/fingerprint/" },
      ],
      editLink: { baseUrl: "https://github.com/overrule-ai/overturn/edit/main/docs/" },
      lastUpdated: false,
      pagination: true,
      components: {},
    }),
  ],
});
