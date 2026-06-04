const ANTIPATTERNS = [
  // ── AI slop: tells that something was AI-generated ──
  {
    category: "slop",
    description:
      "Thick colored border on one side of a card — the most recognizable tell of AI-generated UIs. Use a subtler accent or remove it entirely.",
    id: "side-tab",
    name: "Side-tab accent border",
    skillGuideline: "colored accent stripe",
    skillSection: "Visual Details",
  },
  {
    category: "slop",
    description:
      "Thick accent border on a rounded card — the border clashes with the rounded corners. Remove the border or the border-radius.",
    id: "border-accent-on-rounded",
    name: "Border accent on rounded element",
    skillGuideline: "colored accent stripe",
    skillSection: "Visual Details",
  },
  {
    category: "slop",
    description:
      "Inter, Roboto, Fraunces, Geist, Plus Jakarta Sans, and Space Grotesk are used on so many sites they no longer feel distinctive. Each new wave of AI-generated UIs converges on the same handful of faces. Choose a face that gives your interface personality.",
    id: "overused-font",
    name: "Overused font",
    skillGuideline: "overused fonts like Inter",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "Only one font family is used for the entire page. Pair a distinctive display font with a refined body font to create typographic hierarchy.",
    id: "single-font",
    name: "Single font for everything",
    skillGuideline: "only one font family for the entire page",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "Font sizes are too close together — no clear visual hierarchy. Use fewer sizes with more contrast (aim for at least a 1.25 ratio between steps).",
    id: "flat-type-hierarchy",
    name: "Flat type hierarchy",
    skillGuideline: "flat type hierarchy",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "Gradient text is decorative rather than meaningful — a common AI tell, especially on headings and metrics. Use solid colors for text.",
    id: "gradient-text",
    name: "Gradient text",
    skillGuideline: "gradient text for",
    skillSection: "Color & Contrast",
  },
  {
    category: "slop",
    description:
      "Purple/violet gradients and cyan-on-dark are the most recognizable tells of AI-generated UIs. Choose a distinctive, intentional palette.",
    id: "ai-color-palette",
    name: "AI color palette",
    skillGuideline: "AI color palette",
    skillSection: "Color & Contrast",
  },
  {
    category: "slop",
    description:
      'A warm cream or beige page background has become the default "tasteful" AI surface, reached for by reflex. Choose a background that comes from a deliberate palette, not the safe warm off-white.',
    id: "cream-palette",
    name: "Cream / beige palette",
    skillGuideline: "cream and beige as the default surface",
    skillSection: "Color & Contrast",
  },
  {
    category: "slop",
    description:
      "Cards inside cards create visual noise and excessive depth. Flatten the hierarchy — use spacing, typography, and dividers instead of nesting containers.",
    id: "nested-cards",
    name: "Nested cards",
    skillGuideline: "Nest cards inside cards",
    skillSection: "Layout & Space",
  },
  {
    category: "slop",
    description:
      "The same spacing value used everywhere — no rhythm, no variation. Use tight groupings for related items and generous separations between sections.",
    id: "monotonous-spacing",
    name: "Monotonous spacing",
    skillGuideline: "same spacing everywhere",
    skillSection: "Layout & Space",
  },
  {
    category: "slop",
    description:
      "Bounce and elastic easing feel dated and tacky. Real objects decelerate smoothly — use exponential easing (ease-out-quart/quint/expo) instead.",
    id: "bounce-easing",
    name: "Bounce or elastic easing",
    skillGuideline: "bounce or elastic easing",
    skillSection: "Motion",
  },
  {
    category: "slop",
    description:
      'Dark backgrounds with colored box-shadow glows are the default "cool" look of AI-generated UIs. Use subtle, purposeful lighting instead — or skip the dark theme entirely.',
    id: "dark-glow",
    name: "Dark mode with glowing accents",
    skillGuideline: "dark mode with glowing accents",
    skillSection: "Color & Contrast",
  },
  {
    category: "slop",
    description:
      "A small rounded-square icon container above a heading is the universal AI feature-card template — every generator outputs this exact shape. Try a side-by-side icon and heading, or let the icon sit in flow without its own container.",
    id: "icon-tile-stack",
    name: "Icon tile stacked above heading",
    skillGuideline: "large icons with rounded corners above every heading",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "Oversized italic serif (Fraunces, Recoleta, Playfair, Newsreader-italic) as the primary hero headline reads as taste in isolation but has become the universal AI-startup landing page hero. Set roman, or move to a non-serif display face. Editorial / magazine register may legitimately want this — judge by context.",
    id: "italic-serif-display",
    name: "Italic serif display headline",
    skillGuideline: "oversized italic serif as the hero headline",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "A tiny uppercase letter-spaced label sitting immediately above an oversized hero headline — or the same shape rendered as a pill chip — is now the default AI SaaS hero. Drop the eyebrow, integrate the kicker into the headline, or run it as a navigation breadcrumb instead.",
    id: "hero-eyebrow-chip",
    name: "Hero eyebrow / pill chip",
    skillGuideline: "tiny uppercase tracked label above the hero headline",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "Repeating tiny uppercase tracked labels above section headings turns a brand page into AI editorial scaffolding. Replace them with stronger structure, artifacts, imagery, or a deliberate brand system.",
    id: "repeated-section-kickers",
    name: "Repeated section kicker labels",
    severity: "advisory",
    skillGuideline: "repeated eyebrow or kicker labels as section scaffolding",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "Numbered display markers as section labels (01, 02, 03) are the AI editorial scaffold one tier deeper than tracked eyebrow chips. If you find yourself reaching for them, choose a different section cadence.",
    id: "numbered-section-markers",
    name: "Numbered section markers (01 / 02 / 03)",
    severity: "advisory",
    skillGuideline: "numbered section markers",
    skillSection: "Layout & Space",
  },
  {
    category: "slop",
    description:
      "More than two em-dashes (— or --) in body copy is an AI cadence tell. Use commas, colons, periods, or parentheses instead.",
    id: "em-dash-overuse",
    name: "Em-dash overuse",
    skillGuideline: "no em dashes",
    skillSection: "Copy",
  },
  {
    category: "slop",
    description:
      "Generic SaaS phrases (streamline / empower / supercharge / world-class / enterprise-grade / next-generation / cutting-edge / etc) are instant AI tells. Pick a specific verb and noun that says what the product literally does.",
    id: "marketing-buzzword",
    name: "Marketing buzzword",
    skillGuideline: "marketing buzzwords",
    skillSection: "Copy",
  },
  {
    category: "slop",
    description:
      'Three or more sections landing on a short rebuttal sentence ("X. No Y." / "X. Just Y.") or a manufactured-contrast aphorism ("Not a feature. A platform.") reads as AI cadence, not voice. Once is fine; the pattern is the tell.',
    id: "aphoristic-cadence",
    name: "Aphoristic-cadence copy",
    skillGuideline: "aphoristic cadence",
    skillSection: "Copy",
  },
  {
    category: "slop",
    description:
      "A full-sentence headline set at display size ends up dominating the viewport, leaving no room for anything else above the fold. A punchy one- or two-word headline at that size is fine — the problem is a long headline blown up too large. Set long headlines smaller, or tighten the copy.",
    id: "oversized-h1",
    name: "Oversized hero headline",
    skillGuideline: "long headline set at display size",
    skillSection: "Typography",
  },
  {
    category: "slop",
    description:
      "Letter-spacing pulled tighter than the point where characters keep their own shapes costs legibility. Tighten display type optically, not destructively.",
    id: "extreme-negative-tracking",
    name: "Crushed letter spacing",
    skillGuideline: "letter spacing crushed past legibility",
    skillSection: "Typography",
  },
  {
    category: "quality",
    description:
      "<img> tags with empty src, missing src, or placeholder values ship as broken-image boxes. Use real images, generated assets, or remove the tag.",
    id: "broken-image",
    name: "Broken or placeholder image",
    skillGuideline: "broken image references",
    skillSection: "Imagery",
  },

  // ── Quality: general design and accessibility issues ──
  {
    category: "quality",
    description:
      "Gray text looks washed out on colored backgrounds. Use a darker shade of the background color instead, or white/near-white for contrast.",
    id: "gray-on-color",
    name: "Gray text on colored background",
    skillGuideline: "gray text on colored backgrounds",
    skillSection: "Color & Contrast",
  },
  {
    category: "quality",
    description:
      "Text does not meet WCAG AA contrast requirements (4.5:1 for body, 3:1 for large text). Increase the contrast between text and background.",
    id: "low-contrast",
    name: "Low contrast text",
  },
  {
    category: "quality",
    description:
      "Animating width, height, padding, or margin causes layout thrash and janky performance. Use transform and opacity instead, or grid-template-rows for height animations.",
    id: "layout-transition",
    name: "Layout property animation",
    skillGuideline: "Animate layout properties",
    skillSection: "Motion",
  },
  {
    category: "quality",
    description:
      "Text lines wider than ~80 characters are hard to read. The eye loses its place tracking back to the start of the next line. Add a max-width (65ch to 75ch) to text containers.",
    id: "line-length",
    name: "Line length too long",
    skillGuideline: "wrap beyond ~80 characters",
    skillSection: "Layout & Space",
  },
  {
    category: "quality",
    description:
      "Text is too close to the edge of its container. Two shapes: (1) an element with its own text where the padding is too low for the font size, and (2) a wrapper with text-bearing children and near-zero padding against a visible boundary (border, outline, or non-transparent background) — children land flush against the boundary line. Add at least 8px (ideally 12–16px) of padding inside bordered, outlined, or colored containers.",
    id: "cramped-padding",
    name: "Cramped padding",
    skillGuideline: "inside bordered or colored containers",
    skillSection: "Layout & Space",
  },
  {
    category: "quality",
    description:
      "Body paragraphs render flush against the left or right viewport edge with no container providing horizontal padding. Wrap content in a container with at least 16px (ideally 24-32px) of horizontal padding, or apply max-width with mx-auto.",
    id: "body-text-viewport-edge",
    name: "Body text touching viewport edge",
  },
  {
    category: "quality",
    description:
      "Line height below 1.3x the font size makes multi-line text hard to read. Use 1.5 to 1.7 for body text so lines have room to breathe.",
    id: "tight-leading",
    name: "Tight line height",
  },
  {
    category: "quality",
    description:
      "Heading levels should not skip (e.g. h1 then h3 with no h2). Screen readers use heading hierarchy for navigation. Skipping levels breaks the document outline.",
    id: "skipped-heading",
    name: "Skipped heading level",
  },
  {
    category: "quality",
    description:
      'Justified text without hyphenation creates uneven word spacing ("rivers of white"). Use text-align: left for body text, or enable hyphens: auto if you must justify.',
    id: "justified-text",
    name: "Justified text",
  },
  {
    category: "quality",
    description:
      "Body text below 12px is hard to read, especially on high-DPI screens. Use at least 14px for body content, 16px is ideal.",
    id: "tiny-text",
    name: "Tiny body text",
  },
  {
    category: "quality",
    description:
      "Long passages in uppercase are hard to read. We recognize words by shape (ascenders and descenders), which all-caps removes. Reserve uppercase for short labels and headings.",
    id: "all-caps-body",
    name: "All-caps body text",
    skillGuideline: "long body passages in uppercase",
    skillSection: "Typography",
  },
  {
    category: "quality",
    description:
      "Letter spacing above 0.05em on body text disrupts natural character groupings and slows reading. Reserve wide tracking for short uppercase labels only.",
    id: "wide-tracking",
    name: "Wide letter spacing on body text",
  },
  {
    category: "quality",
    description:
      "Content renders wider than its container, spilling out or forcing a horizontal scrollbar. Let text wrap, constrain widths, or give the region a deliberate scroll affordance.",
    id: "text-overflow",
    name: "Content overflowing its container",
    skillGuideline: "content wider than its container",
    skillSection: "Layout & Space",
  },
  {
    category: "quality",
    description:
      "A clipping container (overflow hidden or clip) wrapping an absolutely-positioned child cuts off tooltips, menus, and popovers that need to escape. Let the overflow be visible, or move the positioned layer out of the clip.",
    id: "clipped-overflow-container",
    name: "Positioned child clipped by overflow container",
    skillGuideline: "overflow container clipping positioned children",
    skillSection: "Layout & Space",
  },

  // ── Provider tells: opt-in via --gpt / --gemini (gated off by default) ──
  {
    category: "slop",
    description:
      "A hairline border paired with a wide, diffuse shadow is a recurring generated-UI signature. Commit to one — a defined edge or a soft elevation — rather than both at once.",
    gated: "gpt",
    id: "gpt-thin-border-wide-shadow",
    name: "Hairline border with wide shadow",
    severity: "advisory",
    skillGuideline: "hairline border plus wide diffuse shadow",
    skillSection: "Visual Details",
  },
  {
    category: "slop",
    description:
      "Repeating-gradient stripes used as surface decoration are a recurring generated-UI signature. Reach for a deliberate texture or leave the surface plain.",
    gated: "gpt",
    id: "repeating-stripes-gradient",
    name: "Repeating-gradient stripes",
    severity: "advisory",
    skillGuideline: "repeating-gradient decorative stripes",
    skillSection: "Visual Details",
  },
  {
    category: "slop",
    description:
      'Dismissing something as "theater" is a recurring generated-copy tic. Say plainly what the thing does or does not do.',
    gated: "gpt",
    id: "theater-slop-phrase",
    name: "Theater framing copy",
    severity: "advisory",
    skillGuideline: "theater framing copy",
    skillSection: "Copy",
  },
  {
    category: "slop",
    description:
      "Scaling or rotating an image on hover is a recurring generated-UI signature. Let imagery sit still, or use a subtler, purposeful interaction.",
    gated: "gemini",
    id: "image-hover-transform",
    name: "Image hover transform",
    severity: "advisory",
    skillGuideline: "image scale or rotate on hover",
    skillSection: "Motion",
  },
];

const RULE_ENGINE_SUPPORT = {
  browser: new Set(["element", "page", "layout"]),
  regex: new Set(["source", "page-analyzer"]),
  "static-html": new Set(["element", "page"]),
  visual: new Set(["visual-contrast"]),
};

function getAntipattern(id) {
  return ANTIPATTERNS.find((rule) => rule.id === id);
}

function getRulesForCategory(category) {
  return ANTIPATTERNS.filter((rule) => rule.category === category);
}

function getRuleEngineSupport(engine) {
  return RULE_ENGINE_SUPPORT[engine] || new Set();
}

// Set of provider tags that gate rules off by default (e.g. 'gpt', 'gemini').
const GATED_PROVIDERS = new Set(ANTIPATTERNS.map((rule) => rule.gated).filter(Boolean));

// Drop findings for rules gated behind a provider tag unless that provider
// was explicitly enabled (CLI --gpt / --gemini). Non-gated findings always
// pass through. `findings` carry the rule id on `.antipattern`.
function filterByProviders(findings, providers = []) {
  const enabled = new Set(providers || []);
  if (!GATED_PROVIDERS.size) {
    return findings;
  }
  return findings.filter((f) => {
    const rule = getAntipattern(f.antipattern);
    if (!rule || !rule.gated) {
      return true;
    }
    return enabled.has(rule.gated);
  });
}

export {
  ANTIPATTERNS,
  RULE_ENGINE_SUPPORT,
  GATED_PROVIDERS,
  getAntipattern,
  getRulesForCategory,
  getRuleEngineSupport,
  filterByProviders,
};
