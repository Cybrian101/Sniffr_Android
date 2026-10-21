# Velvet Paw Design System

## 1. Overview & Creative North Star
**Creative North Star: "The Digital Sanctuary"**

Velvet Paw is a design system that rejects the sterile rigidity of traditional tech platforms in favor of a soft, editorial, and nursery-inspired aesthetic. It is built on the philosophy of "Soft Brutalism"—using bold, oversized type and generous whitespace, but tempering it with a pastel palette, organic shapes (blobs), and tactile depth. 

The system breaks the "template" look through intentional asymmetry, such as off-kilter organic background shapes and heavy use of decorative, low-opacity iconography that bleeds off the canvas.

## 2. Colors
The palette is a "Fruit Salad" of soft pastels: Petal Pink (Primary), Sky Blue (Secondary), and Mint (Tertiary).

- **The "No-Line" Rule:** Visual sectioning must avoid 1px solid borders. Separation is achieved through background shifts (e.g., `surface-container-low` for toggles) or subtle tonal transitions.
- **Surface Hierarchy & Nesting:** Use the `surface-container` tiers to create soft depth. A card (`surface_container_lowest`) should sit atop a `background` of `surface`, creating a "lift" through color rather than heavy shadows.
- **The "Glass & Gradient" Rule:** Primary actions and hero elements should utilize the "Pastel Gradient" (Primary to Secondary at 135deg). Use `backdrop-blur` for floating elements to maintain the "Sanctuary" feel.
- **Signature Textures:** Utilize ultra-low opacity (6-8%) large-scale icons (`pets`, `potted_plant`) as environmental textures to break up large flat areas.

## 3. Typography
Velvet Paw uses **Plus Jakarta Sans** across all levels to maintain a friendly, modern, yet high-end feel.

- **Display & Headlines:** Leverages `font-extrabold` and `tracking-tighter` at large scales (up to 36px/2.25rem) to create a high-contrast editorial look.
- **Labels:** Unlike standard systems, labels are miniaturized (10px - 11px), set in `font-bold`, and use `uppercase` with `tracking-widest` to act as sophisticated anchors for input fields.
- **Body:** Standard body text is set at 14px (0.875rem) or 12px (0.75rem) for secondary info, prioritizing readability with a softer grey (`on-surface-variant`).
- **The Rhythmic Scale:** Based on extracted values, the system jumps from tiny 10px metadata to 18px actions and 36px displays, creating a rhythmic visual hierarchy that feels curated.

## 4. Elevation & Depth
Velvet Paw moves away from "material" elevation toward **Tonal Layering** and **Ambient Glows**.

- **The Layering Principle:** Use `surface-container-low` for recessed areas (like toggle backgrounds) and `surface_container_lowest` (Pure White) for elevated cards.
- **Ambient Shadows:** Replace standard shadows with "Colored Glows." For example, a card uses a blue-tinted shadow: `0 15px 40px -15px rgba(168,216,234,0.3)`.
- **The "Ghost Border":** If structural definition is required, use `outline-variant` at 10-20% opacity.
- **Organic Blobs:** Use varying `border-radius` (e.g., `rounded-[40%_60%_70%_30%]`) behind images to create a sense of movement and organic life.

## 5. Components
- **Buttons:** Primary buttons are pill-shaped (`rounded-full`) or heavily rounded (`rounded-xl`), featuring the signature pastel gradient and a matching soft shadow.
- **Toggle Switches:** Recessed capsules using `surface-container-low` with a pure white "floating" active state.
- **Input Fields:** Borderless by default, using `surface-container-highest/50` for the field fill and 11px uppercase labels. Focus states utilize a soft ring of the secondary color.
- **Cards:** Defined by `surface_container_lowest` (white) backgrounds and extra-diffused, large-radius shadows.
- **Chips & Badges:** Use tertiary containers (`D5F2E9`) for a calming, informative appearance.

## 6. Do's and Don'ts
### Do's
- Use organic, asymmetrical blob shapes behind key imagery.
- Maintain wide gutters and generous padding (`spacing: 3`) to ensure an "editorial" feel.
- Use iconography as decorative background elements at low opacity.
- Prioritize high-contrast font weights (Extrabold vs Medium).

### Don'ts
- Never use pure black (#000000) for text; use the softer `on-surface` (#453F41).
- Avoid sharp 90-degree corners; the minimum radius should be 1rem.
- Do not use harsh 1px solid dark borders.
- Avoid standard Material shadows; always tint shadows with a hint of the primary or secondary brand colors.