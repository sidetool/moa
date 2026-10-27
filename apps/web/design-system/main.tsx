import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import { ChevronDown, Download } from 'lucide-react';
import { previews } from './previews';
import styleGuide from '../../../spec/design-system/style-guide.md?raw';
import componentLibrary from '../../../spec/design-system/component-library.md?raw';
import patternLibrary from '../../../spec/design-system/pattern-library.md?raw';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles.scss';

const sections = [
  { id: 'style-guide', label: 'Style Guide', markdown: styleGuide },
  { id: 'component-library', label: 'Component Library', markdown: componentLibrary },
  { id: 'pattern-library', label: 'Pattern Library', markdown: patternLibrary },
];

function Preview({ id }: { id: string }) {
  const Component = Object.hasOwn(previews, id) ? previews[id] : undefined;
  return <section className="docs-preview" data-preview={id} aria-label={`${id} 미리보기`}>
    {Component ? <Component /> : <p role="alert" className="preview-error">등록되지 않은 미리보기: {id}</p>}
  </section>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  if (isValidElement<{ className?: string; children?: ReactNode }>(children) && children.props.className === 'language-preview') {
    return <Preview id={String(children.props.children).trim()} />;
  }
  return <pre>{children}</pre>;
}

function Docs() {
  const [hash, setHash] = useState(location.hash), [menuOpen, setMenuOpen] = useState(false);
  const [headings, setHeadings] = useState<{ id: string; text: string }[]>([]);
  const [source, setSource] = useState('');
  const header = useRef<HTMLElement>(null), main = useRef<HTMLElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const initialRoute = useRef(true);
  const parts = hash.replace(/^#\/?/, '').split('/');
  const section = sections.find(item => item.id === parts[0]) || sections[0];
  useEffect(() => {
    const navigate = () => { setHash(location.hash); setMenuOpen(false); };
    addEventListener('hashchange', navigate);
    return () => removeEventListener('hashchange', navigate);
  }, []);
  useLayoutEffect(() => {
    const measure = () => {
      if (header.current) document.documentElement.style.setProperty('--docs-header-offset', `${header.current.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (header.current) observer.observe(header.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const used = new Set<string>();
    const next = [...(main.current?.querySelectorAll<HTMLHeadingElement>('.docs-prose > h2') || [])].map(heading => {
      const text = heading.textContent || '';
      const slug = text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
      let id = slug, suffix = 2;
      while (used.has(id)) id = `${slug}-${suffix++}`;
      used.add(id);
      heading.id = id;
      heading.tabIndex = -1;
      return { id, text };
    });
    setHeadings(next);
    let anchor = '';
    try { anchor = decodeURIComponent(parts[1] || ''); } catch {}
    const target = anchor ? document.getElementById(anchor) : main.current?.querySelector<HTMLHeadingElement>('h1');
    const navigate = Boolean(anchor) || !initialRoute.current;
    initialRoute.current = false;
    if (!navigate || !target) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      if (header.current) document.documentElement.style.setProperty('--docs-header-offset', `${header.current.getBoundingClientRect().height}px`);
      target.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [section, hash]);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([section.markdown], { type: 'text/markdown;charset=utf-8' }));
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [section]);
  const href = (id: string) => `#${section.id}/${encodeURIComponent(id)}`;
  return <>
    <a className="docs-skip" href="#main-content" onClick={event => { event.preventDefault(); main.current?.focus(); }}>본문으로 이동</a>
    <header ref={header} className="docs-header">
      <a href="#style-guide" className="docs-brand">MOA</a>
      <nav aria-label="문서 분류" className="docs-tabs">{sections.map(item => <a key={item.id} href={`#${item.id}`} aria-current={item === section ? 'page' : undefined}>{item.label}</a>)}</nav>
      <a className="docs-download" href={source} download={`${section.id}.md`}><Download size={18} aria-hidden="true" /><span>Markdown</span></a>
    </header>
    <div className="docs-layout">
      <aside className={`docs-sidebar${menuOpen ? ' is-open' : ''}`} onKeyDown={event => { if (event.key === 'Escape' && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); } }}>
        <button ref={menuButton} className="docs-menu-toggle" type="button" aria-expanded={menuOpen} aria-controls="docs-sections" onClick={() => setMenuOpen(value => !value)}>목차<ChevronDown size={16} aria-hidden="true" /></button>
        <nav id="docs-sections" aria-label={`${section.label} 목차`}>{headings.map(heading => <a key={heading.id} href={href(heading.id)} aria-current={parts[1] === encodeURIComponent(heading.id) || parts[1] === heading.id ? 'location' : undefined}>{heading.text}</a>)}</nav>
      </aside>
      <main ref={main} id="main-content" className="docs-main" tabIndex={-1}>
        <div className="docs-prose"><Markdown components={{ pre: CodeBlock, a: ({ children, href, node: _node, ...rest }) => {
          const internal = sections.find(item => href?.split('#')[0] === `${item.id}.md`);
          return <a {...rest} href={internal ? `#${internal.id}${href?.includes('#') ? `/${href.split('#')[1]}` : ''}` : href} rel={href?.startsWith('http') ? 'noreferrer' : undefined}>{children}</a>;
        } }}>{section.markdown}</Markdown></div>
      </main>
    </div>
  </>;
}

createRoot(document.getElementById('root')!).render(<Docs />);
