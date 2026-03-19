// Let's explicitly separate the offsets for preview vs generator because the coordinate spaces are fundamentally different.
// The user explicitly stated in a previous prompt that `{ x: 0, y: -0.55 }` for punctuation in the GENERATOR worked perfectly to put it in the "top right".
// Why did that work?
// Context rotated by -Math.PI / 2.
// Translation by { x: 0, y: -0.55 * fontSizePx }
// Original canvas coords: Right is +X, Down is +Y.
// After rotation (-90 deg), the X axis points UP. The Y axis points RIGHT.
// Translation of `y = -0.55` moves it along the negative Y axis, which is LEFT visually.
// So the generator moves the punctuation LEFT.
// Why does moving it LEFT put it in the Top-Right?
// Ah! In vertical text on the e-reader, lines flow from RIGHT to LEFT.
// If you draw the glyph, and it's placed in the box, perhaps the box itself is drawn rotated or placed differently?
// Regardless of the internal device mapping, the empirical truth from the user is:
// For GENERATOR punctuation (rotated): { x: 0, y: -0.55 } -> works perfectly (puts it in top right).
// 
// For PREVIEW punctuation (unrotated):
// If generator uses {x: 0, y: -0.55}, we need the preview to match this visual outcome.
// In the preview, it's not rotated. To move something visually to the Top-Right, we shift Right (+X) and Up (-Y).
// 
// For SUTEGANA:
// Sutegana normally draws in the center-left or center-bottom.
// The user said: "the sutegana 'yo' character has small tiny cutoff in generated font but in preview it does not cutoff.."
// This proves the generator offset and the preview offset are misaligned.
// Let's bring back `isPreview` flag so we can tune them completely independently.
