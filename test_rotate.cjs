// What about the single quote ' and double quote " in the screenshot?
// They are also floating top-right.
// Why?
// Let's check getVerticalCharOffset:
// ```
// function getVerticalCharOffset(char: string, fontSizePx: number, isPreview: boolean): { x: number, y: number } {
//   if (VERTICAL_PUNCTUATION_SHIFT.has(char)) {
// ```
// Wait, I didn't include `'` or `"` in VERTICAL_PUNCTUATION_SHIFT.
// Let's look at the screenshot again carefully.
// The screenshot shows standard english characters cut off.
// The parenthesis `)` is rotated +90 in the preview. It's too wide for the visual width (which is charBoxH).
// Why is the parenthesis cut off?
// In `previewFontCharacter`:
// `drawnBoxes.push({ x: currentX, y: currentY, w: charBoxH, h: charBoxW, isCutoff });`
// The highlight box has `w: charBoxH` and `h: charBoxW`.
// For vertical mode, `charBoxH` is the unrotated width, and `charBoxW` is the unrotated height.
// Wait!
// In `measureCharSize`:
// ```
//   if (options.vertical) {
//     const temp = finalW;
//     finalW = finalH;
//     finalH = temp;
//   }
// ```
// So `box.width` = unrotated Height (Tall).
// `box.height` = unrotated Width (Narrow).
// So `charBoxW` = Tall.
// `charBoxH` = Narrow.
// In `previewFontCharacter` for vertical mode:
// `w: charBoxH` (Narrow)
// `h: charBoxW` (Tall)
// This is correct! The preview box is Narrow and Tall.
// But the parenthesis `)` is drawn rotated +90.
// So it is visually WIDE and SHORT!
// A wide/short character drawn inside a narrow/tall box WILL spill out the sides!
// The screenshot shows exactly this: The `)` is horizontal, sticking out of the left and right sides of the tall/narrow red box!
// That is physically what happens if you take a tall `)` and rotate it 90 degrees.
// BUT why is the e-reader able to display it without cutoff?
// The e-reader receives a binary box that is `box.width` (Tall) x `box.height` (Narrow).
// In `generateFontBinary`:
// If it's a `)`, it's a `VERTICAL_SYMBOL`.
// `isRotatedMinus90 = false`.
// So it calls `ctx.rotate(0)`.
// It draws `)` UPRIGHT into a canvas of width=Tall, height=Narrow.
// `)` is a tall character.
// It draws it upright into a box with `height=Narrow`!
// IT WILL BE CUT OFF ON THE TOP AND BOTTOM IN THE BINARY!
// 
// If it's cut off in the binary, it will be cut off on the e-reader!
// Why wasn't it cut off before?
// Because before, we didn't swap the dimensions in `measureCharSize`!
// Before, `box.width` was Narrow, `box.height` was Tall.
// The generator drew `)` upright into Narrow/Tall. It fit perfectly!
// And the generator drew `坐` rotated -90 into Narrow/Tall. `坐` is square so it fit perfectly!
// And the generator drew English rotated 0 into Narrow/Tall. They fit perfectly vertically, but if they were wide words... wait, English characters are narrow and tall. So they fit perfectly!
//
// BUT wait, I swapped the dimensions because of the English character `g` being cut off.
// "some english font like "g" is cutoff in vertical reading option. maybe swap the value of x and y"
// When I swapped them, `box.width` became Tall, and `box.height` became Narrow.
// This fixed `g` when it was drawn `rotate(-90)` (because it needs horizontal space to be drawn sideways, so it needs `box.width` to be Tall).
// BUT if we swap them globally, we break EVERYTHING that is drawn `rotate(0)` (like `)`, `|`, `‥`) because they are drawn upright and now have a Narrow `box.height`!
//
// We CANNOT swap the global box dimensions! The global box MUST be square, OR we must dynamically adjust per character (which the .bin format doesn't support, it's fixed width/height for ALL chars).
// If the font is fixed width/height for ALL chars, and we have chars drawn sideways AND chars drawn upright, the box MUST be large enough in BOTH dimensions!
// We need the box to be `max(finalW, finalH)` for BOTH width and height!
// If we make it square, it will fit everything regardless of rotation!
