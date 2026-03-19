// Let's summarize the offset math for the GENERATOR (rotated -Math.PI / 2):
// The canvas translates to the center of the box, then rotates CCW by 90 degrees.
// This means the context's +X axis points visually UP.
// The context's +Y axis points visually RIGHT.
// 
// For Japanese punctuation (、。，．):
// It naturally draws at the bottom-left of the unrotated EM square.
// When rotated CCW by 90, the bottom-left corner physically moves to the bottom-right of the cell.
// To move it from bottom-right to top-right, we need to shift it visually UP.
// Visually UP is the +X axis in the rotated context.
// Therefore, the generator offset should be: { x: fontSizePx * 0.55, y: 0 }
//
// Let's verify what the user said before:
// "the japanese punctuation is in the top left" when the code was:
// `return { x: 0, y: -fontSizePx * 0.55 };`
// In the rotated context:
// x = 0 (no up/down movement)
// y = -0.55 (move along -Y, which is visually LEFT)
// If it started at bottom-right, and we moved it visually LEFT, it should end up at BOTTOM-LEFT.
// But the user said it was at TOP-LEFT.
// If it ended up at TOP-LEFT, then my assumption about where it starts might be inverted, OR the e-reader handles the placement of the character differently.
// 
// If { x: 0, y: -0.55 } puts it in TOP-LEFT.
// And we want it in TOP-RIGHT.
// The difference between Top-Left and Top-Right is a shift to the RIGHT visually.
// Visually RIGHT is +Y in the rotated context.
// So if {x:0, y:-0.55} = Top-Left, then changing `y` to `0` or `+0.55` will move it Right.
// Let's try { x: 0, y: 0 }. Where would that be? Probably Top-Right? If so, no shift is needed?
// But earlier, without any shift, the user asked to move it.
//
// What did I use for Sutegana that was successful?
// `return { x: fontSizePx * 0.15, y: 0 };`
// The user said: "the sutegana "yo" character has small tiny cutoff in generated font but in preview its good."
// So `{ x: 0.15, y: 0 }` was mostly correct for sutegana, just slightly cut off.
// Sutegana start near the bottom-left or center-left.
// { x: 0.15, y: 0 } moves it visually UP.
//
// To match the PREVIEW:
// Preview (unrotated):
// Punctuation: { x: 0.55, y: -0.55 } -> Right and Up.
// Sutegana: { x: 0.15, y: -0.15 } -> Right and Up.
// 
// If we want the EXACT same visual shift in the GENERATOR (rotated -90):
// Visual Right = +Y
// Visual Up = +X
// So to move Right and Up visually:
// Punctuation: { x: 0.55, y: 0.55 }
// Sutegana: { x: 0.15, y: 0.15 }
// 
// Let's try to mathematically map it exactly!
// If preview shift is `(pX, pY)`, the visual shift is `(Right: pX, Down: pY)`.
// So visual shift is `Right: +0.55, Down: -0.55` (which means UP).
// In generator (rotated -90):
// X_gen maps to visual UP. -> So X_gen = -pY.
// Y_gen maps to visual RIGHT. -> So Y_gen = pX.
// Therefore:
// Punctuation: X_gen = -(-0.55) = 0.55. Y_gen = 0.55.  => { x: 0.55, y: 0.55 }
// Sutegana: X_gen = -(-0.15) = 0.15. Y_gen = 0.15. => { x: 0.15, y: 0.15 }
//
// Let's verify this mathematically.
// `ctx.translate(X_gen, Y_gen)` inside `ctx.rotate(-Math.PI/2)`.
// The physical point is:
// Physical X = X_gen * cos(-90) - Y_gen * sin(-90) = 0 - Y_gen * (-1) = Y_gen.
// Physical Y = X_gen * sin(-90) + Y_gen * cos(-90) = X_gen * (-1) + 0 = -X_gen.
// We want Physical X (Right) to be +0.55. So Y_gen = +0.55.
// We want Physical Y (Down) to be -0.55. So -X_gen = -0.55 => X_gen = +0.55.
// THIS IS THE EXACT MATHEMATICAL SOLUTION!
// To perfectly mirror the preview's visual shift in the generator's rotated space, the generator offsets must be exactly `{ x: 0.55, y: 0.55 }` and `{ x: 0.15, y: 0.15 }`.
