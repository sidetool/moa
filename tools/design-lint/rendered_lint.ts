const METRIC_NAMES = [
  'width', 'height', 'fontSize', 'lineHeight', 'paddingInlineStart',
  'paddingInlineEnd', 'paddingTop', 'paddingBottom', 'rowGap', 'columnGap',
  'marginTop', 'marginBottom', 'marginInlineStart', 'marginInlineEnd',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius',
  'borderBottomRightRadius',
] as const;
const STATE_NAMES = ['disabled', 'readOnly', 'expanded', 'selected', 'checked', 'pressed', 'busy', 'invalid', 'focused'] as const;
const LIMITATIONS = [
  'Only explicitly selected elements in this document and their current rendered states are inspected.',
  'No iframe/shadow-root traversal, interaction execution, accessible-name algorithm, or screen-reader test.',
  'Geometry uses bounding rectangles in CSS pixels, not proof of unclipped hit areas or target-spacing exceptions.',
  'Dropdown centering compares the arrow box and supported SVG artwork with the trigger content-box center; optical balance still needs visual review.',
  'Text glyphs, generated content, complex SVG effects, and transformed SVG artwork require visual or platform-specific geometry review.',
  'Contrast covers uniform sRGB text/solid ancestor backgrounds only; overlays, text ranges, and occlusion need visual review.',
  'A clean report means no configured issue was detected; it is not design or accessibility certification.',
];

export type RenderedMetric = typeof METRIC_NAMES[number];
export type RenderedState = typeof STATE_NAMES[number];
export interface DropdownExpectation {
  labelSelector: string;
  arrowSelector: string;
  minimumGap: number;
}
export interface RenderedLintTarget {
  selector: string;
  minWidth?: number;
  minHeight?: number;
  expected?: Partial<Record<RenderedMetric, number>>;
  states?: Partial<Record<RenderedState, boolean>>;
  contrastMinimum?: number;
  dropdown?: DropdownExpectation;
}
export interface RenderedLintConfig {
  version: 1;
  targets: RenderedLintTarget[];
  tolerance?: number;
  checkPageOverflow?: boolean;
  scenario?: string;
}
export interface RenderedDiagnostic {
  severity: 'error' | 'warning';
  rule: string;
  selector: string | null;
  message: string;
}
export interface DropdownMeasurement {
  direction: string;
  trailing: number;
  expectedTrailing: number;
  gap: number;
  centerY: number;
  expectedCenterY: number;
  verticalOffset: number;
  artworkCenterY?: number;
  artworkVerticalOffset?: number;
}
export interface RenderedMeasurement {
  selector: string;
  width: number;
  height: number;
  metrics: Partial<Record<RenderedMetric, number | string>>;
  contrast?: number;
  dropdown?: DropdownMeasurement;
}
export interface RenderedLintReport {
  tool: 'rendered-design-lint';
  version: 1;
  context: {
    url: string;
    capturedAt: string;
    viewport: { width: number; height: number };
    scenario: string;
    direction: string;
  } | null;
  coverage: { matched: number; inspected: number; checks: number };
  measurements: RenderedMeasurement[];
  diagnostics: RenderedDiagnostic[];
  summary: { errors: number; warnings: number };
  status: 'fail' | 'review' | 'pass';
  limitations: string[];
}

type Rgba = [number, number, number, number];
type Bounds = { left: number; right: number; top: number; bottom: number };
type ArtworkResult = { bounds: Bounds; reason?: never } | { bounds?: never; reason: string };
type AddDiagnostic = (severity: RenderedDiagnostic['severity'], rule: string, selector: string | null, message: string) => void;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!object(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}`);
  }
}
function number(value: unknown, label: string, minimum: number, maximum = Infinity): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}.`);
  }
}
function selector(value: unknown, label: string, document: Document): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty selector.`);
  try { document.querySelectorAll(value); } catch { throw new Error(`${label} is not a valid selector.`); }
}
function validate(config: unknown, document: Document): asserts config is RenderedLintConfig {
  keys(config, ['version', 'targets', 'tolerance', 'checkPageOverflow', 'scenario'], 'config');
  if (config.version !== 1) throw new Error('version must be 1.');
  if (!Array.isArray(config.targets) || !config.targets.length) throw new Error('targets must be a nonempty array.');
  if (config.tolerance !== undefined) number(config.tolerance, 'tolerance', 0, 2);
  if (config.scenario !== undefined && (typeof config.scenario !== 'string' || !config.scenario.trim())) {
    throw new Error('scenario must be a nonempty description of the captured state.');
  }
  if (config.checkPageOverflow !== undefined && typeof config.checkPageOverflow !== 'boolean') {
    throw new Error('checkPageOverflow must be boolean.');
  }
  for (const target of config.targets) {
    keys(target, ['selector', 'minWidth', 'minHeight', 'expected', 'states', 'contrastMinimum', 'dropdown'], 'target');
    selector(target.selector, 'target.selector', document);
    for (const prop of ['minWidth', 'minHeight']) {
      if (target[prop] !== undefined) number(target[prop], prop, Number.EPSILON);
    }
    if (target.contrastMinimum !== undefined) number(target.contrastMinimum, 'contrastMinimum', 1, 21);
    if (target.expected !== undefined) {
      keys(target.expected, METRIC_NAMES, 'expected');
      for (const [name, value] of Object.entries(target.expected)) number(value, name, name.startsWith('margin') ? -Infinity : 0);
    }
    if (target.states !== undefined) {
      keys(target.states, STATE_NAMES, 'states');
      for (const value of Object.values(target.states)) {
        if (typeof value !== 'boolean') throw new Error('State expectations must be boolean.');
      }
    }
    if (target.dropdown !== undefined) {
      keys(target.dropdown, ['labelSelector', 'arrowSelector', 'minimumGap'], 'dropdown');
      selector(target.dropdown.labelSelector, 'dropdown.labelSelector', document);
      selector(target.dropdown.arrowSelector, 'dropdown.arrowSelector', document);
      number(target.dropdown.minimumGap, 'dropdown.minimumGap', 0);
    }
    const checks = ['minWidth', 'minHeight', 'contrastMinimum', 'dropdown'].filter(key => target[key] !== undefined).length +
      Object.keys(object(target.expected) ? target.expected : {}).length + Object.keys(object(target.states) ? target.states : {}).length;
    if (!checks) throw new Error(`No checks configured for ${String(target.selector)}.`);
  }
}

function rgba(text: string): Rgba | null {
  const contents = /^rgba?\(([^)]+)\)$/i.exec(text)?.[1];
  if (!contents) return null;
  const parts = contents.trim().split(/[\s,/]+/);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const values = parts.map((part, index) => {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)%?$/.test(part)) return NaN;
    return Number.parseFloat(part) * (part.endsWith('%') ? (index < 3 ? 2.55 : 0.01) : 1);
  });
  if (values.some((value, index) => !Number.isFinite(value) || value < 0 || value > (index < 3 ? 255 : 1))) return null;
  const [red, green, blue, alpha = 1] = values;
  if (red === undefined || green === undefined || blue === undefined) return null;
  return [red, green, blue, alpha];
}
function composite(front: Rgba, back: Rgba): Rgba {
  const alpha = front[3] + back[3] * (1 - front[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (index: 0 | 1 | 2): number => (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}
function luminance(color: Rgba): number {
  const linear = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return linear(color[0]) * 0.2126 + linear(color[1]) * 0.7152 + linear(color[2]) * 0.0722;
}
function background(element: Element, view: Window): Rgba | null {
  let result: Rgba = [0, 0, 0, 0];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (Number(style.opacity) !== 1 || style.filter !== 'none' || style.mixBlendMode !== 'normal' ||
        style.backdropFilter && style.backdropFilter !== 'none' || style.backgroundImage !== 'none') return null;
    if (result[3] < 1) {
      const color = rgba(style.backgroundColor);
      if (!color) return null;
      result = composite(result, color);
    }
  }
  return result[3] === 1 ? result : null;
}
function visible(element: Element, view: Window): boolean {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height || !element.getClientRects().length) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.visibility !== 'visible' || style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
}
function state(element: Element, name: RenderedState, document: Document): boolean | null {
  if (name === 'focused') return document.activeElement === element;
  if (name === 'disabled') return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
  if (name === 'readOnly') return 'readOnly' in element && element.readOnly === true || element.getAttribute('aria-readonly') === 'true';
  if (name === 'selected' && element.tagName === 'OPTION' && 'selected' in element) return element.selected === true;
  if (name === 'checked' && 'indeterminate' in element && element.indeterminate === true) return null;
  if (name === 'checked' && element.tagName === 'INPUT' && 'type' in element && typeof element.type === 'string' &&
      ['checkbox', 'radio'].includes(element.type.toLowerCase()) && 'checked' in element) return element.checked === true;
  const attribute = element.getAttribute(`aria-${name}`);
  if (name === 'invalid') return Boolean(attribute) && attribute !== 'false';
  if (attribute !== null && !['true', 'false'].includes(attribute)) return null;
  return attribute === 'true';
}
function transformed(element: Element, view: Window): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.transform !== 'none' || style.scale && style.scale !== 'none' ||
        style.rotate && style.rotate !== 'none' || style.translate && style.translate !== 'none' ||
        Number.parseFloat(style.zoom || '1') !== 1) return true;
  }
  return false;
}
function svgGraphics(element: Element): element is SVGGraphicsElement {
  return element.namespaceURI === 'http://www.w3.org/2000/svg' && 'getBBox' in element && typeof element.getBBox === 'function';
}
function svgArtwork(arrow: Element, view: Window): ArtworkResult {
  const roots = arrow.localName === 'svg' ? [arrow] : [...arrow.querySelectorAll('svg')];
  if (roots.length !== 1) {
    return { reason: 'Use a balanced inline SVG arrow; a font glyph or generated icon box does not establish visible artwork centering.' };
  }
  const root = roots[0];
  if (!root) return { reason: 'No SVG arrow artwork could be measured.' };
  for (const part of [arrow, ...arrow.querySelectorAll('*')]) {
    if (['title', 'desc'].includes(part.localName)) continue;
    if ([...part.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim())) {
      return { reason: 'Text glyphs mixed with SVG artwork require visual review of the visible icon.' };
    }
    for (const pseudo of ['::before', '::after']) {
      const content = view.getComputedStyle(part, pseudo).content;
      if (!['', 'none', 'normal', '""', "''"].includes(content)) {
        return { reason: 'Generated icon content cannot be measured from the SVG geometry alone.' };
      }
    }
  }
  const shapes = new Set(['path', 'polyline', 'polygon', 'line', 'circle', 'ellipse', 'rect']);
  let bounds: Bounds | undefined;
  for (const part of [root, ...root.querySelectorAll('*')]) {
    if (['title', 'desc'].includes(part.localName)) continue;
    if (!['svg', 'g', ...shapes].includes(part.localName)) {
      return { reason: `SVG ${part.localName} artwork requires visual or platform-specific geometry review.` };
    }
    const style = view.getComputedStyle(part);
    let hidden = false;
    for (let ancestor: Element | null = part; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = view.getComputedStyle(ancestor);
      if (ancestorStyle.display === 'none' || ancestorStyle.visibility !== 'visible' || Number(ancestorStyle.opacity) === 0) hidden = true;
      if (ancestor === root) break;
    }
    if (hidden) continue;
    if (style.clipPath !== 'none' || style.maskImage && style.maskImage !== 'none' || style.filter !== 'none' ||
        style.markerStart !== 'none' || style.markerMid !== 'none' || style.markerEnd !== 'none' ||
        style.strokeDasharray !== 'none' || style.vectorEffect !== 'none') {
      return { reason: 'Clipping, masks, filters, markers, dashed strokes, or vector effects prevent a reliable SVG artwork bound.' };
    }
    if (!shapes.has(part.localName)) continue;
    if (!svgGraphics(part)) return { reason: 'SVG geometry is unavailable in this browser.' };
    if (style.fill.includes('url(') || style.stroke.includes('url(')) return { reason: 'SVG paint servers require visual review.' };
    const fillColor = style.fill === 'none' ? null : rgba(style.fill);
    const strokeColor = style.stroke === 'none' ? null : rgba(style.stroke);
    if (style.fill !== 'none' && !fillColor || style.stroke !== 'none' && !strokeColor) {
      return { reason: 'Unresolved SVG paint colors require visual review.' };
    }
    const fill = fillColor !== null && fillColor[3] > 0 && Number(style.fillOpacity) > 0;
    const stroke = strokeColor !== null && strokeColor[3] > 0 && Number(style.strokeOpacity) > 0 && Number.parseFloat(style.strokeWidth) > 0;
    if (!fill && !stroke) continue;
    // A round stroke expands the geometry symmetrically; other joins/caps need a paint-bound API.
    if (stroke && (style.strokeLinejoin !== 'round' || style.strokeLinecap !== 'round')) {
      return { reason: 'Use round joins and caps for measured chevrons; other stroke extents need visual review.' };
    }
    try {
      const box = part.getBBox();
      const matrix = part.getScreenCTM();
      if (!matrix || ![box.x, box.y, box.width, box.height, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) {
        return { reason: 'SVG artwork has no finite screen-space geometry.' };
      }
      if (Math.abs(matrix.b) > 1e-8 || Math.abs(matrix.c) > 1e-8 || matrix.a === 0 || matrix.d === 0) {
        return { reason: 'Rotated, skewed, or collapsed SVG artwork requires a platform-specific geometry check.' };
      }
      const inset = stroke ? Number.parseFloat(style.strokeWidth) / 2 : 0;
      const x1 = (box.x - inset) * matrix.a + matrix.e;
      const x2 = (box.x + box.width + inset) * matrix.a + matrix.e;
      const y1 = (box.y - inset) * matrix.d + matrix.f;
      const y2 = (box.y + box.height + inset) * matrix.d + matrix.f;
      const current = { left: Math.min(x1, x2), right: Math.max(x1, x2), top: Math.min(y1, y2), bottom: Math.max(y1, y2) };
      bounds = bounds ? {
        left: Math.min(bounds.left, current.left), right: Math.max(bounds.right, current.right),
        top: Math.min(bounds.top, current.top), bottom: Math.max(bounds.bottom, current.bottom),
      } : current;
    } catch {
      return { reason: 'The browser could not measure SVG artwork geometry.' };
    }
  }
  if (!bounds || bounds.bottom <= bounds.top || bounds.right <= bounds.left) return { reason: 'SVG artwork has no measurable painted area.' };
  const viewport = root.getBoundingClientRect();
  if (bounds.left < viewport.left - 0.01 || bounds.right > viewport.right + 0.01 ||
      bounds.top < viewport.top - 0.01 || bounds.bottom > viewport.bottom + 0.01) {
    return { reason: 'SVG artwork extends outside its viewport; verify clipping and icon bounds visually.' };
  }
  return { bounds };
}

/** Read-only DOM audit. The caller drives viewport, input, and states before each run. */
export function lintRenderedDesign(config: unknown, document: Document | undefined = globalThis.document): RenderedLintReport {
  const diagnostics: RenderedDiagnostic[] = [];
  const measurements: RenderedMeasurement[] = [];
  const coverage = { matched: 0, inspected: 0, checks: 0 };
  const add: AddDiagnostic = (severity, rule, selector, message) => { diagnostics.push({ severity, rule, selector, message }); };
  const finish = (): RenderedLintReport => {
    const errors = diagnostics.filter(d => d.severity === 'error').length;
    const warnings = diagnostics.filter(d => d.severity === 'warning').length;
    const view = document?.defaultView;
    const context = view && document ? {
      url: `${view.location.origin}${view.location.pathname}`, capturedAt: new Date().toISOString(),
      viewport: { width: view.innerWidth, height: view.innerHeight },
      scenario: object(config) && typeof config.scenario === 'string' ? config.scenario : 'Current DOM state',
      direction: view.getComputedStyle(document.documentElement).direction,
    } : null;
    return { tool: 'rendered-design-lint', version: 1, context, coverage, measurements, diagnostics,
      summary: { errors, warnings }, status: errors ? 'fail' : warnings ? 'review' : 'pass', limitations: [...LIMITATIONS] };
  };
  const view = document?.defaultView;
  try {
    if (!document || !view) throw new Error('A rendered browser Document is required.');
    validate(config, document);
  } catch (error) {
    add('error', 'config', null, error instanceof Error ? error.message : String(error));
    return finish();
  }
  // The runtime guard above returns for unavailable DOMs; retain the narrowed references here.
  if (!document || !view) return finish();
  const tolerance = config.tolerance ?? 0.5;
  if (config.checkPageOverflow !== false) {
    coverage.checks++;
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + tolerance) {
      add('error', 'page-overflow', 'html', 'The document overflows its viewport horizontally.');
    }
  }
  if (document.fonts?.status === 'loading') add('warning', 'fonts-pending', null, 'Wait for document.fonts.ready and repeat the audit.');
  for (const target of config.targets) {
    const elements = [...document.querySelectorAll(target.selector)];
    coverage.matched += elements.length;
    if (!elements.length) add('error', 'target-missing', target.selector, 'Selector matched no elements; no checks were performed for it.');
    elements.forEach((element, index) => {
      const label = `${target.selector} [${index}]`;
      if (!visible(element, view)) {
        add('warning', 'target-hidden', label, 'No visible geometry; expose the intended state and repeat the audit.');
        return;
      }
      coverage.inspected++;
      const rect = element.getBoundingClientRect();
      const style = view.getComputedStyle(element);
      const sample: RenderedMeasurement = { selector: label, width: rect.width, height: rect.height, metrics: {} };
      measurements.push(sample);
      for (const name of ['minWidth', 'minHeight'] as const) {
        const expected = target[name];
        const actual = name === 'minWidth' ? rect.width : rect.height;
        if (expected !== undefined) {
          coverage.checks++;
          if (actual + tolerance < expected) add('error', 'minimum-size', label, `${name}: expected at least ${expected} CSS px, measured ${actual}.`);
        }
      }
      for (const name of METRIC_NAMES) {
        const expected = target.expected?.[name];
        if (expected === undefined) continue;
        const css = style[name];
        const actual = name === 'width' ? rect.width : name === 'height' ? rect.height : /^-?\d+(?:\.\d+)?px$/.test(css) ? Number.parseFloat(css) : NaN;
        sample.metrics[name] = Number.isFinite(actual) ? actual : css;
        coverage.checks++;
        if (!Number.isFinite(actual)) add('warning', 'metric-unresolved', label, `${name} resolved to ${css}, not a scalar CSS-pixel value.`);
        else if (Math.abs(actual - expected) > tolerance) add('error', 'metric-mismatch', label, `${name}: expected ${expected} CSS px, measured ${actual}.`);
      }
      for (const name of STATE_NAMES) {
        const expected = target.states?.[name];
        if (expected === undefined) continue;
        coverage.checks++;
        const actual = state(element, name, document);
        if (actual === null) add('warning', 'state-unresolved', label, `${name} is not a binary state; inspect it with the component's interaction harness.`);
        else if (actual !== expected) add('error', 'state-mismatch', label, `${name} does not match ${expected}; this checks current DOM state, not behavior.`);
      }
      if (target.contrastMinimum !== undefined) {
        coverage.checks++;
        const foreground = rgba(style.color);
        const behind = background(element, view);
        const hasText = [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim());
        const mixedText = [...element.children].some(child => (child.textContent ?? '').trim());
        if (!foreground || !behind || !hasText || mixedText || style.textShadow !== 'none' ||
            style.webkitTextFillColor && style.webkitTextFillColor !== style.color) {
          add('warning', 'contrast-unresolved', label, 'Select a uniform text element with a solid resolved background; this sample cannot establish contrast.');
        } else {
          const a = luminance(composite(foreground, behind));
          const b = luminance(behind);
          const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          sample.contrast = ratio;
          if (ratio < target.contrastMinimum) add('error', 'contrast', label, `Contrast ${ratio.toFixed(3)}:1 is below ${target.contrastMinimum}:1.`);
        }
      }
      if (target.dropdown) {
        coverage.checks++;
        const labels = element.querySelectorAll(target.dropdown.labelSelector);
        const arrows = element.querySelectorAll(target.dropdown.arrowSelector);
        const textElement = labels[0];
        const arrowElement = arrows[0];
        if (labels.length !== 1 || arrows.length !== 1 || !textElement || !arrowElement || !visible(textElement, view) || !visible(arrowElement, view)) {
          add('error', 'dropdown-parts', label, 'Exactly one visible label and one visible arrow must match inside the trigger.');
        } else if (style.writingMode !== 'horizontal-tb' || transformed(element, view) ||
                   transformed(textElement, view) || transformed(arrowElement, view)) {
          add('warning', 'dropdown-unresolved', label, 'Vertical writing or transformed triggers require a platform-specific geometry check.');
        } else {
          const text = textElement.getBoundingClientRect();
          const arrow = arrowElement.getBoundingClientRect();
          const rtl = style.direction === 'rtl';
          const edge = Number.parseFloat(rtl ? style.borderLeftWidth : style.borderRightWidth) + Number.parseFloat(style.paddingInlineEnd);
          const trailing = rtl ? arrow.left - rect.left : rect.right - arrow.right;
          const gap = rtl ? text.left - arrow.right : arrow.left - text.right;
          const contentTop = rect.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
          const contentBottom = rect.bottom - Number.parseFloat(style.borderBottomWidth) - Number.parseFloat(style.paddingBottom);
          const expectedCenterY = (contentTop + contentBottom) / 2;
          const centerY = (arrow.top + arrow.bottom) / 2;
          const verticalOffset = centerY - expectedCenterY;
          sample.dropdown = { direction: style.direction, trailing, expectedTrailing: edge, gap, centerY, expectedCenterY, verticalOffset };
          if (Math.abs(trailing - edge) > tolerance || arrow.left < rect.left - tolerance || arrow.right > rect.right + tolerance ||
              arrow.top < rect.top - tolerance || arrow.bottom > rect.bottom + tolerance ||
              text.left < rect.left - tolerance || text.right > rect.right + tolerance ||
              text.top < rect.top - tolerance || text.bottom > rect.bottom + tolerance || gap + tolerance < target.dropdown.minimumGap) {
            add('error', 'dropdown-layout', label, 'Arrow must occupy the logical trailing padded slot, stay inside the trigger, and not overlap the label.');
          }
          coverage.checks++;
          if (contentBottom < contentTop || Math.abs(verticalOffset) > tolerance) {
            add('error', 'dropdown-vertical-alignment', label, `Arrow box center is ${verticalOffset.toFixed(3)} CSS px from the trigger content-box center; tolerance is ${tolerance}.`);
          }
          coverage.checks++;
          const artwork = svgArtwork(arrowElement, view);
          if (!artwork.bounds) {
            add('warning', 'dropdown-artwork-unresolved', label, artwork.reason);
          } else {
            const artworkCenterY = (artwork.bounds.top + artwork.bounds.bottom) / 2;
            const artworkVerticalOffset = artworkCenterY - expectedCenterY;
            sample.dropdown.artworkCenterY = artworkCenterY;
            sample.dropdown.artworkVerticalOffset = artworkVerticalOffset;
            if (Math.abs(artworkVerticalOffset) > tolerance) {
              add('error', 'dropdown-artwork-alignment', label, `Visible SVG artwork center is ${artworkVerticalOffset.toFixed(3)} CSS px from the trigger content-box center; a centered icon box alone is insufficient.`);
            }
          }
          if (textElement.clientWidth > 0 && textElement.scrollWidth > textElement.clientWidth + tolerance && view.getComputedStyle(textElement).overflowX === 'visible') {
            add('error', 'dropdown-label-overflow', label, 'Visible label overflow can overlap the arrow; define wrapping or accessible truncation.');
          }
        }
      }
    });
  }
  if (!coverage.inspected) add('error', 'empty-coverage', null, 'No visible target was inspected.');
  return finish();
}
