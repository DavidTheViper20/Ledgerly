# Ledgerly Icon Refresh Brief

This is a design brief for the later image-generation/icon replacement pass. No icon assets were replaced in this research pass.

## Current Assets

App icon files:

- `build/icon.svg`
- `build/icon_1024.png`
- `build/icon.icns`
- `build/icon.iconset/icon_16x16.png`
- `build/icon.iconset/icon_16x16@2x.png`
- `build/icon.iconset/icon_32x32.png`
- `build/icon.iconset/icon_32x32@2x.png`
- `build/icon.iconset/icon_128x128.png`
- `build/icon.iconset/icon_128x128@2x.png`
- `build/icon.iconset/icon_256x256.png`
- `build/icon.iconset/icon_256x256@2x.png`
- `build/icon.iconset/icon_512x512.png`
- `build/icon.iconset/icon_512x512@2x.png`

In-app logo:

- `ui/index.html`
- Inline SVG at the topbar brand mark.
- Current mark is a purple rounded square with a golden `L` stroke:

```html
<svg class="logo" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
  <rect x="2" y="2" width="28" height="28" rx="7" fill="#4f46e5"/>
  <path d="M10 8v13a3 3 0 0 0 3 3h9" stroke="#fbbf24" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

Current app icon:

- Purple macOS-style rounded square.
- White ledger/paper/book shape.
- Lavender spine.
- Purple ruled lines.
- Green check mark.

## Desired Direction

Create one unified mark that combines:

- The `L` identity from the in-app logo.
- The paper/ledger/check symbol from the app icon.
- The existing indigo/purple brand palette.
- A professional accounting/finance feel.

Recommended composition:

```text
Indigo rounded square background
  -> white ledger document
  -> large stylized golden or white "L" integrated into the document spine
  -> green check mark completing the lower part of the mark
```

The icon should stay readable at 16x16, so avoid tiny ledger lines or dense detail.

## Image Generation Prompt Draft

Use this as the starting prompt for the later image generation pass:

```text
Create a clean macOS app icon for an accounting application called Ledgerly. The icon should combine a stylized capital letter L with a white ledger document and a green check mark, all as one unified symbol. Use a deep indigo/purple rounded-square background, a crisp white document shape, subtle lavender ledger details, and a confident green check. The L should be integrated into the document spine or document silhouette, not floating separately. Modern SaaS accounting style, simple geometric forms, high contrast, readable at small sizes, no text, no mockup, no shadows outside the icon, centered composition, 1024x1024.
```

## Replacement Targets

Later pass should generate or derive:

- `build/icon.svg`
- `build/icon_1024.png`
- full `build/icon.iconset`
- `build/icon.icns`
- topbar inline SVG in `ui/index.html`

After replacing assets, run:

```bash
npm run smoke
npm test
```

