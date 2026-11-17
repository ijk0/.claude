# Design for the task

Use this when choosing a direction or checking the usability of the result.
The user's brief wins. Existing product conventions govern extensions; a
requested redesign may deliberately replace them. Font and palette preferences
are decisions for the surface, not universal bans.

## Choose the purpose

| Purpose | Typical work | Default priorities |
|---|---|---|
| Operate | Dashboards, settings, forms, internal tools | Familiar controls, scanability, useful density, clear feedback |
| Persuade | Landing pages, campaigns, pricing | A concrete offer, credible proof, distinct composition, one primary action |
| Read | Reports, documentation, long-form content | Reading rhythm, navigation, legible tables, reliable pagination |
| Experience | Portfolios, galleries, showcases | Let the work lead; keep surrounding controls quiet |

Choose per surface. A tool's marketing page can Persuade while its settings
Operate. When no design system exists, choose a coherent direction that serves
that purpose. Distinctiveness can come from hierarchy, composition, and useful
interaction; it does not require decorative effects.

## Operate

- One legible family can carry headings, controls, and data. System fonts and
  familiar sans families are valid choices. Use a restrained scale and tabular
  numerals where comparisons matter.
- Match control anatomy and interaction conventions across artboards. Reserve
  accent color for actions, selection, and meaningful status.
- Show relevant default, hover, focus, active, disabled, loading, empty, success,
  and error states. A loading state keeps the layout understandable; an error
  preserves input and names a recovery action.
- Adapt structurally at narrow widths: stack columns, simplify navigation,
  choose deliberate table overflow or a readable alternative. Keep dense data
  useful without shrinking text until it becomes unreadable.
- Use motion to explain state changes. Load into the task without mandatory
  entrance choreography.

## Persuade

- State the offer specifically and give one clear primary action, repeated only
  where it helps the visitor act. Build supporting sections around actual
  customer doubts and the supplied evidence.
- Choose typography, color, imagery, and composition as one direction. Distinct
  display type can help here; readable body text and clear controls still matter.
- Use real supplied facts. Mark missing prices, names, dates, contacts, and
  testimonials as placeholders. Interactive sample prices may be used where a
  billing toggle needs them; identify them as sample content at handover.
- Show alternative directions only when choosing a direction is part of the
  request. Keep option identities stable across turns. Once one is selected,
  build the deliverable into `Main.dc.html` and retain alternatives only as asked.

## Read and print

- Establish a readable text measure, heading hierarchy, table style, and navigation.
  Give each table a unit and label that make its values interpretable. Use the
  user's source material; avoid invented statistics or filler sections.
- Use fixed artboards for posters and explicitly paginated brochures; use one
  `print: "flow"` artboard for documents whose text should paginate naturally.
- Author physical sizes at 96 CSS pixels per inch: A4 794×1123, Letter 816×1056,
  A5 559×794, Tabloid 1056×1632. Set `box-sizing: border-box` on fixed roots.
  Body copy normally starts at 12pt/16px; short labels may be smaller when readable
  at the actual viewing distance. A poster's headline needs much larger type.
- A trifold's outside face is inside flap, back cover, front cover from left to
  right. The inside face is the three-panel spread. Verify the fold order.
- For flowing documents use `@page` margins and `break-inside: avoid` on blocks
  that must stay together. Inspect the exported PDF, including page breaks and
  the final page; a long PNG does not prove pagination.
- Check grayscale legibility and avoid hairlines or large ink-heavy fills unless
  the brief needs them. Prefer named/embedded font families when PDF text must
  be searchable; validate selection in the actual export.

## Experience

Give the work the first meaningful viewport. Keep navigation, captions, and
controls discoverable without competing with the artifacts. Choose motion for
the intended experience, with a reduced-motion alternative that preserves meaning.

## Shared acceptance checks

Match checks to the deliverable, and make any deliberate static controls clear.

- **Content:** Every requested piece exists; factual claims have a source or a
  visible placeholder. Preserve the user's copy and targeted-edit boundaries.
- **Keyboard:** Complete the primary interaction by keyboard; show focus, label
  controls, and ensure escape/back paths work. Keep semantic buttons, links,
  headings, form labels, and informative image alternatives.
- **Contrast:** Aim for at least 4.5:1 for body text and 3:1 for large text and
  essential control boundaries. Meaning should survive without color alone.
- **Motion:** Respect `prefers-reduced-motion`; preserve state feedback while
  removing unnecessary movement. Avoid motion that delays reading or input.
- **Responsive:** Inspect desktop and phone layouts for web/app work, including
  long labels, enlarged text, and content wrapping. Phone controls should have
  comfortable 44px interaction areas. Fixed print layouts retain their paper size.
- **Interaction:** Exercise selected values, form entry, validation, loading,
  empty/error recovery, and repeated updates where those states belong to the
  brief. A screenshot of the initial state cannot validate a prototype.
- **Assets:** Verify image and font loading. Embed assets that must work offline
  or on another person's machine, with appropriate redistribution rights.

Use flex/grid with `gap` for structured groups; reserve inline flow for prose.
Keep icons consistent with the existing system, using SVG when drawing new ones.
Charts should carry clear labels, units, and distinguishable series; consult an
available dataviz skill when the chart work warrants it.
