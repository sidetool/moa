// Geometry shared by the design-system previews and the real settings screens.

/** An icon inside a button sits on the label's first line, beside it rather than above it. */
export const iconBesideLabel = button => button.evaluate(element => {
  const icon = element.querySelector('svg').getBoundingClientRect();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
  const range = document.createRange();
  range.selectNodeContents(walker.nextNode());
  const line = range.getClientRects()[0];
  const centerGap = Math.abs((icon.top + icon.bottom) / 2 - (line.top + line.bottom) / 2);
  const beside = icon.right <= line.left + .5 || icon.left >= line.right - .5;
  return { ok: centerGap <= 2 && beside, centerGap, beside, height: element.getBoundingClientRect().height };
});

/** The number and unit form one centered group with no empty input space beside the digits. */
export const stepperCentered = stepper => stepper.evaluate(element => {
  const cell = element.querySelector('.number-stepper-value'), input = cell.querySelector('input'), unit = cell.querySelector('span');
  const style = getComputedStyle(input), mirror = document.createElement('span');
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariantNumeric', 'fontFeatureSettings', 'letterSpacing']) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' });
  mirror.textContent = input.value;
  document.body.append(mirror);
  const text = mirror.getBoundingClientRect().width;
  mirror.remove();
  const box = cell.getBoundingClientRect(), field = input.getBoundingClientRect(), label = unit.getBoundingClientRect();
  const slack = input.clientWidth - text;
  const offset = (Math.min(field.left, label.left) + Math.max(field.right, label.right)) / 2 - (box.left + box.right) / 2;
  const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
  return {
    // Up to a quarter of a digit is left for the caret; anything wider shows as an off-center number.
    ok: slack >= 0 && slack <= parseFloat(style.fontSize) * .3 && input.scrollWidth <= input.clientWidth && Math.abs(offset) <= 1.5,
    value: input.value, slack, offset, scroll: input.scrollWidth - input.clientWidth,
    height: element.getBoundingClientRect().height, buttonWidth: Math.min(...buttons.map(button => button.width)),
    plus: buttons.at(-1).left,
  };
});
