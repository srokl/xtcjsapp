// Let's summarize the state machine for rendering characters vertically:

// CATEGORY 1: VERTICAL SYMBOLS (Brackets, Dashes, etc)
// isVerticalSymbol = true
// isEnglishOrNumber = false
// Generator: rotate(0) // Draws upright in binary, displays sideways on reader
// Preview: rotate(+90) // Displays sideways in preview
// Shift: None
// Cutoff axes swap: No

// CATEGORY 2: CJK Characters & Japanese Punctuation (、 。)
// isVerticalSymbol = false
// isEnglishOrNumber = false
// Generator: rotate(-90) // Draws sideways in binary, displays upright on reader
// Preview: rotate(0) // Displays upright in preview
// Shift: Applied (for punctuation and sutegana)
// Cutoff axes swap: Yes

// CATEGORY 3: English / Numbers (when Upright = false)
// isVerticalSymbol = false
// isEnglishOrNumber = true
// Generator: rotate(0) // Draws upright in binary, displays sideways on reader
// Preview: rotate(+90) // Displays sideways in preview
// Shift: None
// Cutoff axes swap: No

// CATEGORY 4: English / Numbers (when Upright = true)
// isVerticalSymbol = false
// isEnglishOrNumber = true
// Generator: rotate(-90) // Draws sideways in binary, displays upright on reader
// Preview: rotate(0) // Displays upright in preview
// Shift: Applied (for punctuation)
// Cutoff axes swap: Yes

// THE ISSUE: "the english punctutation in vertical reading. in preview its out of bounds from the box. and does not warning it. check also in font generator if its properly inbox english punctuations."
// Which english punctuation? `,` and `.`
// The user mentions it's "out of bounds from the box" in the preview.
// Let's check `previewFontCharacter`:
// `drawnBoxes` uses `w: charBoxH, h: charBoxW` (swapped) when `options.vertical` is true.
// And `ctx.fillRect(currentX, currentY, charBoxH, charBoxW)` for cutoff highlight.
// And `ctx.translate(currentX + charBoxH / 2, currentY + charBoxW / 2)`
// So the PREVIEW box is always swapped in vertical mode!
// But if English is NOT upright, the character is rotated +90 inside that swapped box.
// If it's a comma `,`, it's an English character.
// If English is NOT upright, it falls into Category 3.
// Preview: translates to center of swapped box, rotates +90, draws comma at (0,0).
// Cutoff check: DOES NOT swap axes.
// Wait, if preview ALWAYS swaps the box size (`w: charBoxH, h: charBoxW`), and the context is rotated +90, then visually the character's unrotated width maps to visual height, and unrotated height maps to visual width.
// BUT `isCharCutoff` only swaps axes in the cutoff check if it's Category 2 or 4!
// So for Category 1 and 3 (rotate 0 in generator, +90 in preview), `isCharCutoff` checks the UNROTATED bounds against the swapped box dimensions (`halfW = box.width / 2`, but wait... `box.width` is already swapped at the top of the file!)
// Let's check `measureCharSize`:
// ```
//   if (options.vertical) {
//     const temp = finalW;
//     finalW = finalH;
//     finalH = temp;
//   }
// ```
// So `box.width` is the VISUAL HEIGHT (unrotated height).
// `box.height` is the VISUAL WIDTH (unrotated width).
// 
// So `halfW` = Unrotated Height / 2.
// `halfH` = Unrotated Width / 2.
//
// In `isCharCutoff`:
// For Category 3 (English NOT upright):
// It DOES NOT swap axes.
// So it checks `left < -halfW`
// `left` is Unrotated X bounds (-metrics.actualBoundingBoxLeft).
// It's checking Unrotated X against `halfW` (which is Unrotated Height / 2).
// So it's comparing X to Height, and Y to Width!
// This means the bounds check is COMPLETELY BACKWARDS for Category 1 and 3!
// That's why it doesn't warn.
//
// But wait! If in Category 3, the generator uses `rotate(0)`.
// So the generator draws Unrotated X into `box.width` (Unrotated Height).
// So the generator ALSO draws X into Height!
// If it draws X into Height, a character that is visually wide but short (like `—` em-dash) will be drawn upright into a tall, narrow box. It will be cutoff in the generator!
// 
// Let's fix `isCharCutoff` to perfectly map to `generateFontBinary`.
// In `generateFontBinary`:
// 1. `ctx.translate(box.width / 2, box.height / 2);`
// 2. 
// ```
//       if (options.vertical) {
//         if (options.verticalSymbols && isVerticalSymbol(charStr)) {
//           ctx.rotate(0);
//         } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
//           ctx.rotate(0);
//         } else {
//           ctx.rotate(-Math.PI / 2);
// ```
//
// If we want `isCharCutoff` to be identical:
// Just simulate exactly this!
// ```javascript
// function isCharCutoff(...) {
//   // We can just use the ctx transform matrix!
//   // But canvas 2d doesn't easily let us transform bounding boxes.
//   // Let's do it manually.
// }
// ```
