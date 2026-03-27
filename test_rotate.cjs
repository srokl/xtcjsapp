// Let's re-verify the math:
// Generator: M_total = Translate(center) * Rotation(-90) * Translate(gX, gY)
// When e-reader reads the binary, it rotates it +90.
// E-reader screen = Rotation(+90) * Generator
// E-reader screen = Rotation(+90) * Translate(center) * Rotation(-90) * Translate(gX, gY) * Point
// Rotation(+90) * Translate(center) * Rotation(-90)
// = Rotation(+90) * [ 1 0 cx ] * [ 0 1 0 ]
//                   [ 0 1 cy ]   [-1 0 0 ]
//                   [ 0 0  1 ]   [ 0 0 1 ]
// = [ 0 -1 0 ] * [ 1 0 cx ] * [ 0 1 0 ]
//   [ 1  0 0 ]   [ 0 1 cy ]   [-1 0 0 ]
//   [ 0  0 1 ]   [ 0 0  1 ]   [ 0 0 1 ]
//
// = [ 0 -1 -cy ] * [ 0 1 0 ]
//   [ 1  0  cx ]   [-1 0 0 ]
//   [ 0  0   1 ]   [ 0 0 1 ]
//
// = [ 1 0 -cy ]
//   [ 0 1  cx ]
//   [ 0 0   1 ]
//
// This is exactly Translate(-cy, cx)!
// But wait, center of box is (boxW/2, boxH/2).
// So it's Translate(-boxH/2, boxW/2).
// But the e-reader doesn't just rotate around (0,0), it rotates the IMAGE.
// If it rotates the image, the center of the image stays the center!
// So E-reader screen = Translate(center) * Translate(gX, gY) * Point!
//
// CONCLUSION: If the e-reader reads the binary and displays it rotated +90 (which it must, to display CJK characters upright),
// then any translation `gX, gY` applied BEFORE the `-90` rotation in the generator will result in EXACTLY `gX, gY` translation on the e-reader screen!
//
// Therefore:
// Preview Offset MUST EQUAL Generator Offset!
//
// Why did the user say "the japanese punctuation is in the top left" when the generator offset was `{ x: 0, y: -0.55 }`?
// If the offset was `{ x: 0, y: -0.55 }`, the e-reader displays it at `{ x: 0, y: -0.55 }`.
// `x=0` means NO right/left shift.
// `y=-0.55` means UP shift.
// If a comma starts at Bottom-Left, and you move it UP, it goes to Top-Left!
// THAT'S WHY IT WAS IN THE TOP-LEFT!
// 
// So the user wants it in the Top-Right.
// If it starts at Bottom-Left, to get to Top-Right we must move it RIGHT (+X) and UP (-Y).
// So the correct offset for BOTH preview AND generator is: `{ x: +0.55, y: -0.55 }`!
//
// Wait! Earlier I changed `isCharCutoff` to use the generator's weird swapped offsets, which broke it.
// Let's revert `getVerticalCharOffset` to be simple and identical for both spaces!
